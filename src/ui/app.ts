/**
 * The app shell: owns the terminal, the connection, and the keymap, and is the
 * only place allowed to combine them.
 *
 * Repaint policy matters more than it looks. A streaming turn can emit hundreds
 * of deltas per second, and each one changes the transcript. Painting per delta
 * would spend the whole frame budget on text nobody can read that fast, so the
 * store coalesces changes onto a microtask and this shell coalesces frames onto
 * a fixed interval.
 */

import { DeckClient } from '../protocol/client.ts'
import { Connection, type ConnectionState } from '../protocol/connection.ts'
import { DeckStore, type SessionState } from '../model/store.ts'
import type { HostDescription, SessionId } from '../protocol/contract.ts'
import { detectCapabilities, type TerminalCapabilities } from '../term/capabilities.ts'
import { Screen } from '../term/screen.ts'
import { InputReader, type Key } from '../term/input.ts'
import { TerminalIntegration } from '../term/ghostty.ts'
import { stringWidth } from '../term/width.ts'
import { createGlyphs, createTheme, type Glyphs, type Theme } from './theme.ts'
import { computeLayout, viewportTooSmall, type Layout } from './layout.ts'
import { layoutTranscript, renderTranscript, type RenderedLine } from './transcript.ts'
import { renderSidebar } from './sidebar.ts'
import { renderComposer } from './composer.ts'
import { renderFooter, renderHeader } from './statusbar.ts'
import { renderHelp } from './help.ts'

/** Frame budget. 24fps is plenty for text and leaves the CPU alone while idle. */
const FRAME_INTERVAL_MS = 42
/** Spinner cadence, only ticking while at least one session runs. */
const SPINNER_INTERVAL_MS = 90

const KEY_HINTS = [
  { key: 'tab', label: 'switch' },
  { key: '^n', label: 'new' },
  { key: '^c', label: 'cancel' },
  { key: '^g', label: 'help' },
]

const APPROVAL_HINTS = [
  { key: 'a', label: 'allow' },
  { key: 'r', label: 'reject' },
]

const BINDINGS = [
  { keys: 'type anything', label: 'goes to the composer — letters are never commands' },
  { keys: 'enter', label: 'send (queues behind the running turn)' },
  { keys: 'alt+enter', label: 'send as steering, interrupting the turn' },
  { keys: 'tab', label: 'next session' },
  { keys: 'alt+1 … alt+9', label: 'jump to a session' },
  { keys: 'ctrl+n', label: 'new session in the current directory' },
  { keys: 'ctrl+f', label: 'fork the focused session' },
  { keys: 'ctrl+c', label: 'cancel the running turn, or quit when idle' },
  { keys: 'ctrl+d', label: 'quit' },
  { keys: 'ctrl+y', label: 'copy the last answer to the clipboard' },
  { keys: 'ctrl+e', label: 'expand or collapse tool detail' },
  { keys: 'ctrl+u / ctrl+w', label: 'clear the draft / delete a word' },
  { keys: 'ctrl+l', label: 'jump to the newest output' },
  { keys: 'up / down, pgup / pgdn', label: 'scroll the transcript' },
  { keys: 'ctrl+g', label: 'toggle this help' },
  { keys: '— when an approval is waiting —', label: '' },
  { keys: 'a or y, enter', label: 'allow once' },
  { keys: 'r or n, esc', label: 'reject' },
]

export interface DeckAppOptions {
  baseUrl: string
  /** Working directory for sessions this instance creates. */
  cwd: string
  /** Write a transcript into the primary screen on exit. */
  printOnExit?: boolean
  env?: NodeJS.ProcessEnv
}

interface Message {
  text: string
  kind: 'info' | 'warn' | 'error'
}

export class DeckApp {
  private readonly client: DeckClient
  private readonly store = new DeckStore()
  private readonly connection: Connection
  private readonly caps: TerminalCapabilities
  private readonly theme: Theme
  private readonly glyphs: Glyphs
  private readonly screen: Screen
  private readonly input: InputReader
  private readonly term: TerminalIntegration
  private readonly options: DeckAppOptions

  private host: HostDescription | undefined
  private connectionState: ConnectionState = 'connecting'
  private draft = ''
  private cursor = 0
  private scrollOffset = 0
  private spinnerFrame = 0
  private showHelp = false
  private expandTools = false
  private message: Message | undefined
  private messageTimer: NodeJS.Timeout | undefined
  private frameTimer: NodeJS.Timeout | undefined
  private spinnerTimer: NodeJS.Timeout | undefined
  private framePending = false
  private stopped = false
  /** Sessions whose history fetch is in flight, so focus does not refetch. */
  private readonly historyInFlight = new Set<SessionId>()
  private lastProgress = -1

  constructor(options: DeckAppOptions) {
    this.options = options
    const env = options.env ?? process.env
    this.caps = detectCapabilities(env)
    this.theme = createTheme(this.caps, env)
    this.glyphs = createGlyphs(env)
    this.client = new DeckClient({ baseUrl: options.baseUrl })
    this.screen = new Screen(process.stdout, this.caps)
    this.input = new InputReader(process.stdin)
    this.term = new TerminalIntegration(process.stdout, this.caps)
    this.connection = new Connection(this.client, options.baseUrl, {
      state: (state, detail) => this.onConnectionState(state, detail),
      ready: (host) => { void this.onReady(host) },
      mux: (frame, rpcId) => { this.store.applyMux(frame, rpcId) },
      host: (frame, rpcId) => { this.store.applyHost(frame, rpcId) },
      lost: (reason) => this.onLost(reason),
    })
  }

  async start(): Promise<void> {
    this.screen.open()
    this.input.start()
    this.input.onKey((key) => { this.onKey(key) })
    // Piped stdin (scripted runs, CI) reaches EOF and sends no further keys;
    // without this the app would sit there with nothing able to quit it.
    process.stdin.once('end', () => { void this.quit() })
    this.screen.onResize(() => { this.requestFrame() })
    this.store.subscribe((change) => this.onStoreChange(change.kind))
    this.connection.start()
    this.requestFrame()
    await this.waitUntilStopped()
  }

  private waitUntilStopped(): Promise<void> {
    return new Promise((resolve) => {
      this.resolveStopped = resolve
    })
  }

  private resolveStopped: (() => void) | undefined

  // -- connection ----------------------------------------------------------

  private onConnectionState(state: ConnectionState, detail?: string): void {
    this.connectionState = state
    if (state === 'reconnecting') this.notice(detail ?? 'connection lost, reconnecting', 'warn')
    this.requestFrame()
  }

  private async onReady(host: HostDescription): Promise<void> {
    this.host = host
    const result = await this.client.call('session.list', {})
    if (!result.ok) {
      this.notice(`session.list failed: ${result.error.message}`, 'error')
      return
    }
    this.store.applySessionList(result.value.items)
    const first = this.store.sessions[0]
    if (first === undefined) {
      await this.createSession()
    } else if (this.store.focusedId === undefined) {
      this.focus(first.id)
    } else {
      void this.loadHistory(this.store.focusedId)
    }
    this.requestFrame()
  }

  private onLost(reason: string): void {
    // Live-only state (queues, jobs, in-flight partials) cannot be trusted
    // across a generation boundary; history refetch rebuilds the transcript.
    this.store.resetLiveState()
    this.notice(`stream ended: ${reason}`, 'warn')
    this.historyInFlight.clear()
    this.requestFrame()
  }

  // -- store ---------------------------------------------------------------

  private onStoreChange(kind: string): void {
    if (kind === 'approval') {
      const pending = this.store.sessions.find((s) => s.pendingApproval !== undefined)
      if (pending !== undefined) {
        this.term.notify('Approval needed', `${pending.pendingApproval?.toolName ?? 'tool'} in ${this.titleOf(pending)}`)
      }
    }
    this.requestFrame()
  }

  // -- input ---------------------------------------------------------------

  /**
   * Key handling has one hard rule: **printable characters always go to the
   * composer**. An earlier design bound bare letters to commands whenever the
   * draft was empty, which meant typing "add tests" fired the approve action on
   * the `a`. Commands therefore live on modifiers, and the only single-letter
   * bindings belong to the approval overlay, which owns input while it is up.
   *
   * This method is deliberately synchronous up to the point it mutates the
   * draft. Awaiting first let several keys observe the same stale draft.
   */
  private onKey(key: Key): void {
    // The approval overlay grabs input: a blocked agent is the one thing worth
    // stealing the keyboard for, and it makes allow/reject a single keystroke.
    if (this.pendingApprovalTarget() !== undefined && this.answerKey(key)) return

    if (key.kind === 'paste') { this.insert(key.text); return }

    if (key.kind === 'ctrl') {
      this.onCtrl(key.char)
      return
    }

    if (key.kind === 'alt') {
      if (key.char >= '1' && key.char <= '9') {
        const target = this.store.sessions[Number(key.char) - 1]
        if (target !== undefined) this.focus(target.id)
        return
      }
      if (key.char === '\r' || key.char === '\n') { void this.send('steer'); return }
      return
    }

    if (key.kind === 'char') {
      if (this.showHelp) { this.showHelp = false; this.requestFrame(); return }
      this.insert(key.char)
      return
    }

    switch (key.kind) {
      case 'enter': void this.send('queue'); return
      case 'tab': this.cycleFocus(1); return
      case 'backspace': this.backspace(); return
      case 'left': this.cursor = Math.max(0, this.cursor - 1); this.requestFrame(); return
      case 'right': this.cursor = Math.min([...this.draft].length, this.cursor + 1); this.requestFrame(); return
      case 'up': this.scroll(1); return
      case 'down': this.scroll(-1); return
      case 'pageup': this.scroll(this.visibleTranscriptRows()); return
      case 'pagedown': this.scroll(-this.visibleTranscriptRows()); return
      case 'home': this.cursor = 0; this.requestFrame(); return
      case 'end': this.cursor = [...this.draft].length; this.requestFrame(); return
      case 'escape': this.showHelp = false; this.requestFrame(); return
      default: return
    }
  }

  private onCtrl(char: string): void {
    switch (char) {
      // Cancel the turn if one is running, otherwise quit — the same shape
      // users already expect from other terminal agents.
      case 'c': {
        const focused = this.focused()
        if (focused?.running === true) void this.cancel()
        else void this.quit()
        return
      }
      case 'd': void this.quit(); return
      case 'n': void this.createSession(); return
      case 'f': void this.fork(); return
      case 'y': this.copyLastAssistant(); return
      case 'e': this.expandTools = !this.expandTools; this.requestFrame(); return
      case 'g': this.showHelp = !this.showHelp; this.requestFrame(); return
      case 'u': this.draft = ''; this.cursor = 0; this.requestFrame(); return
      case 'a': this.cursor = 0; this.requestFrame(); return
      case 'w': this.deleteWord(); return
      case 'l': this.scrollOffset = 0; this.requestFrame(); return
      default: return
    }
  }

  /** Returns the session whose approval should be answered, preferring the focused one. */
  private pendingApprovalTarget(): SessionState | undefined {
    const focused = this.focused()
    if (focused?.pendingApproval !== undefined) return focused
    return this.store.sessions.find((s) => s.pendingApproval !== undefined)
  }

  /** Single-key answers, valid only while an approval is outstanding. */
  private answerKey(key: Key): boolean {
    if (key.kind === 'char') {
      const char = key.char.toLowerCase()
      if (char === 'a' || char === 'y') { void this.answerApproval('allowed-once'); return true }
      if (char === 'r' || char === 'n') { void this.answerApproval('rejected'); return true }
      return false
    }
    if (key.kind === 'enter') { void this.answerApproval('allowed-once'); return true }
    if (key.kind === 'escape') { void this.answerApproval('rejected'); return true }
    return false
  }

  private deleteWord(): void {
    const chars = [...this.draft]
    let i = this.cursor
    while (i > 0 && chars[i - 1] === ' ') i -= 1
    while (i > 0 && chars[i - 1] !== ' ') i -= 1
    chars.splice(i, this.cursor - i)
    this.draft = chars.join('')
    this.cursor = i
    this.requestFrame()
  }

  private insert(text: string): void {
    const chars = [...this.draft]
    const head = chars.slice(0, this.cursor).join('')
    const tail = chars.slice(this.cursor).join('')
    // Control characters would corrupt the composer and, worse, could smuggle
    // escape sequences into a prompt; strip everything but tab-as-space.
    const clean = text.replace(/\r/g, '').replace(/\t/g, ' ').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    this.draft = head + clean + tail
    this.cursor += [...clean].length
    this.requestFrame()
  }

  private backspace(): void {
    if (this.cursor === 0) return
    const chars = [...this.draft]
    chars.splice(this.cursor - 1, 1)
    this.draft = chars.join('')
    this.cursor -= 1
    this.requestFrame()
  }

  private scroll(lines: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset + lines)
    this.requestFrame()
  }

  private cycleFocus(direction: number): void {
    const list = this.store.sessions
    if (list.length === 0) return
    const index = list.findIndex((s) => s.id === this.store.focusedId)
    const next = list[(index + direction + list.length) % list.length]
    if (next !== undefined) this.focus(next.id)
  }

  // -- actions -------------------------------------------------------------

  private focus(id: SessionId): void {
    this.store.focus(id)
    this.scrollOffset = 0
    void this.loadHistory(id)
    this.requestFrame()
  }

  private async loadHistory(id: SessionId): Promise<void> {
    const session = this.store.get(id)
    if (session === undefined || session.historyLoaded || this.historyInFlight.has(id)) return
    this.historyInFlight.add(id)
    // The tail page carries the in-flight partial, so this is also how a
    // mid-turn attach catches up.
    const result = await this.client.call('session.history', { sessionId: id, maxMessages: 80 })
    this.historyInFlight.delete(id)
    if (!result.ok) {
      this.notice(`history failed: ${result.error.message}`, 'error')
      return
    }
    this.store.applyHistoryPage(id, result.value.events, result.value.hasMore)
    this.requestFrame()
  }

  private async createSession(): Promise<void> {
    const result = await this.client.call('session.create', { cwd: this.options.cwd })
    if (!result.ok) {
      this.notice(`could not create a session: ${result.error.message}`, 'error')
      return
    }
    this.focus(result.value.sessionId)
    this.notice('new session', 'info')
  }

  private async send(mode: 'queue' | 'steer'): Promise<void> {
    const text = this.draft.trim()
    const focused = this.focused()
    if (text === '' || focused === undefined) return
    this.draft = ''
    this.cursor = 0
    this.scrollOffset = 0
    this.requestFrame()
    const result = await this.client.call('session.prompt', {
      sessionId: focused.id,
      mode,
      content: [{ type: 'text', text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    if (!result.ok) {
      // A leading '/' is a slash command upstream; surface its own error text.
      this.notice(result.error.message, 'error')
      return
    }
    const command = result.value.command
    if (command !== undefined && command.text !== undefined) this.notice(command.text, 'info')
  }

  private async answerApproval(outcome: 'allowed-once' | 'rejected'): Promise<void> {
    const target = this.pendingApprovalTarget()
    const pending = target?.pendingApproval
    if (target === undefined || pending === undefined) return
    const receipt = await this.client.respond(pending.rpcId, {
      sessionId: target.id,
      approvalId: pending.approvalId,
      outcome,
    })
    if (!receipt.accepted) {
      this.notice(`approval not accepted: ${receipt.reason}`, 'warn')
      return
    }
    this.notice(outcome === 'allowed-once' ? `allowed ${pending.toolName}` : `rejected ${pending.toolName}`, 'info')
  }

  private async cancel(): Promise<void> {
    const focused = this.focused()
    if (focused === undefined || !focused.running) return
    const result = await this.client.call('session.cancel', { sessionId: focused.id })
    if (!result.ok) this.notice(`cancel failed: ${result.error.message}`, 'error')
    else this.notice('cancelled', 'info')
  }

  private async fork(): Promise<void> {
    const focused = this.focused()
    if (focused === undefined) return
    const result = await this.client.call('session.fork', { sessionId: focused.id })
    if (!result.ok) {
      this.notice(`fork failed: ${result.error.message}`, 'error')
      return
    }
    this.focus(result.value.sessionId)
    this.notice('forked', 'info')
  }

  private copyLastAssistant(): void {
    const focused = this.focused()
    if (focused === undefined) return
    const items = focused.transcript.items
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i]
      if (item !== undefined && item.kind === 'assistant') {
        this.term.copy(item.text)
        this.notice('copied to clipboard', 'info')
        return
      }
    }
  }

  // -- rendering -----------------------------------------------------------

  private requestFrame(): void {
    if (this.stopped || this.framePending) return
    this.framePending = true
    this.frameTimer = setTimeout(() => {
      this.framePending = false
      this.frameTimer = undefined
      this.render()
    }, FRAME_INTERVAL_MS)
    this.frameTimer.unref?.()
  }

  private visibleTranscriptRows(): number {
    return Math.max(1, computeLayout(this.screen.columns, this.screen.rows).transcript.height)
  }

  private focused(): SessionState | undefined {
    return this.store.focusedId === undefined ? undefined : this.store.get(this.store.focusedId)
  }

  private titleOf(session: SessionState): string {
    if (session.title !== undefined && session.title !== '') return session.title
    if (session.cwd !== undefined) {
      const parts = session.cwd.split('/')
      const base = parts[parts.length - 1]
      if (base !== undefined && base !== '') return base
    }
    return session.id.slice(0, 8)
  }

  private render(): void {
    const { columns, rows } = this.screen
    this.syncSpinner()
    this.syncTerminalState()

    this.screen.begin()
    if (viewportTooSmall(columns, rows)) {
      this.screen.put(1, 1, `deck needs at least 40x10 (have ${columns}x${rows})`, this.theme.warn)
      this.screen.end()
      return
    }

    const draftRows = Math.min(4, Math.max(1, Math.ceil(Math.max(1, stringWidth(this.draft) + 3) / Math.max(1, columns - 2))))
    const layout: Layout = computeLayout(columns, rows, { composerHeight: draftRows })
    const focused = this.focused()

    renderHeader(this.screen, {
      rect: layout.header,
      host: this.host,
      connection: this.connectionState,
      sessionTitle: focused === undefined ? undefined : this.titleOf(focused),
      theme: this.theme,
      glyphs: this.glyphs,
    })

    if (layout.sidebar !== undefined) {
      renderSidebar(this.screen, {
        rect: layout.sidebar,
        sessions: this.store.sessions,
        focusedId: this.store.focusedId,
        theme: this.theme,
        glyphs: this.glyphs,
        spinnerFrame: this.spinnerFrame,
      })
      for (let row = layout.sidebar.row; row < layout.sidebar.row + layout.sidebar.height; row += 1) {
        this.screen.put(row, layout.sidebar.width + 1, this.glyphs.vline, this.theme.border)
      }
    }

    let lines: readonly RenderedLine[] = []
    if (focused !== undefined) {
      lines = layoutTranscript(focused.transcript.items, {
        width: layout.transcript.width,
        theme: this.theme,
        glyphs: this.glyphs,
        spinnerFrame: this.spinnerFrame,
        expandTools: this.expandTools,
      })
    }
    const { maxScroll } = renderTranscript(this.screen, {
      rect: layout.transcript,
      lines,
      scrollOffset: this.scrollOffset,
      theme: this.theme,
    })
    if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll

    this.screen.fill(layout.composer.row - 1, 1, columns, 1, this.glyphs.hline, this.theme.border)
    const caret = renderComposer(this.screen, {
      rect: layout.composer,
      draft: this.draft,
      cursor: this.cursor,
      mode: 'queue',
      busy: focused?.running ?? false,
      theme: this.theme,
      glyphs: this.glyphs,
    })

    renderFooter(this.screen, {
      rect: layout.footer,
      // The hint row is how the user learns the keyboard has changed mode.
      hints: this.pendingApprovalTarget() === undefined ? KEY_HINTS : APPROVAL_HINTS,
      message: this.message,
      theme: this.theme,
    })

    if (this.showHelp) {
      renderHelp(this.screen, layout.transcript, this.theme, BINDINGS)
    }

    this.screen.end()
    void caret
  }

  /** Only animate while something is actually running. */
  private syncSpinner(): void {
    const anyRunning = this.store.sessions.some((s) => s.running)
    if (anyRunning && this.spinnerTimer === undefined) {
      this.spinnerTimer = setInterval(() => {
        this.spinnerFrame += 1
        this.requestFrame()
      }, SPINNER_INTERVAL_MS)
      this.spinnerTimer.unref?.()
    } else if (!anyRunning && this.spinnerTimer !== undefined) {
      clearInterval(this.spinnerTimer)
      this.spinnerTimer = undefined
    }
  }

  /**
   * Terminal-level state: window title and the OSC 9;4 progress indicator.
   * An approval outranks a running turn, because a blocked agent is the thing
   * the user needs to come back to.
   */
  private syncTerminalState(): void {
    const focused = this.focused()
    const blocked = this.store.sessions.some((s) => s.pendingApproval !== undefined)
    const running = this.store.sessions.some((s) => s.running)
    const state = blocked ? 2 : running ? 3 : 0
    if (state !== this.lastProgress) {
      this.term.progress(state === 0 ? 0 : (state as 2 | 3))
      this.lastProgress = state
    }
    const label = focused === undefined ? 'deck' : `deck · ${this.titleOf(focused)}`
    this.term.title(blocked ? `${label} · approval needed` : running ? `${label} · working` : label)
  }

  private notice(text: string, kind: Message['kind']): void {
    this.message = { text, kind }
    if (this.messageTimer !== undefined) clearTimeout(this.messageTimer)
    this.messageTimer = setTimeout(() => {
      this.message = undefined
      this.requestFrame()
    }, 4000)
    this.messageTimer.unref?.()
    this.requestFrame()
  }

  // -- shutdown ------------------------------------------------------------

  private async quit(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.frameTimer !== undefined) clearTimeout(this.frameTimer)
    if (this.spinnerTimer !== undefined) clearInterval(this.spinnerTimer)
    if (this.messageTimer !== undefined) clearTimeout(this.messageTimer)
    this.term.progress(0)
    this.term.dispose()
    this.input.stop()
    this.connection.close()
    this.screen.close()
    if (this.options.printOnExit !== false) this.printTranscript()
    this.resolveStopped?.()
  }

  /**
   * Leave the conversation in the user's real scrollback. A full-screen TUI runs
   * on the alternate screen, so everything it drew vanishes on exit; writing a
   * plain transcript to the primary screen means the session is still there to
   * scroll back to, with OSC 133 marks so the terminal can jump between turns.
   */
  private printTranscript(): void {
    const focused = this.focused()
    if (focused === undefined) return
    const out = process.stdout
    out.write(`\n${this.theme.accent}deck · ${this.titleOf(focused)}${this.theme.reset}\n`)
    for (const item of focused.transcript.items) {
      if (item.kind === 'user') {
        this.term.markPromptStart()
        out.write(`\n${this.theme.user}${this.glyphs.user} ${item.text}${this.theme.reset}\n`)
        this.term.markOutputStart()
      } else if (item.kind === 'assistant') {
        out.write(`${item.text}\n`)
      } else if (item.kind === 'tool') {
        out.write(`${this.theme.tool}${this.glyphs.tool} ${item.call.name}${this.theme.reset}\n`)
      } else if (item.kind === 'turn-end') {
        this.term.markCommandEnd(0)
      }
    }
    out.write('\n')
  }
}
