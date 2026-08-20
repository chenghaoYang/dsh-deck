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
import {
  DeckStore,
  pendingApprovalsOf,
  pendingQuestionsOf,
  type SessionState,
} from '../model/store.ts'
import type { HostDescription, SessionId } from '../protocol/contract.ts'
import { detectCapabilities, type TerminalCapabilities } from '../term/capabilities.ts'
import { Screen } from '../term/screen.ts'
import { InputReader, type Key } from '../term/input.ts'
import { TerminalIntegration } from '../term/ghostty.ts'
import { graphemes, stringWidth } from '../term/width.ts'
import { createGlyphs, createTheme, type Glyphs, type Theme } from './theme.ts'
import { computeLayout, viewportTooSmall, type Layout } from './layout.ts'
import { layoutTranscript, renderTranscript, type RenderedLine } from './transcript.ts'
import { renderSidebar } from './sidebar.ts'
import { renderComposer } from './composer.ts'
import { renderFooter, renderHeader, type ModeSummary } from './statusbar.ts'
import { renderHelp } from './help.ts'
import {
  createModes,
  modesHitTest,
  reduceModes,
  renderModes,
  updateModesRows,
  type ModeRow,
  type ModeRowId,
  type ModesState,
} from './modes.ts'
import {
  createCommandPalette,
  createPickerOverlay,
  createQuestionOverlay,
  layoutImageOverlay,
  reduceCommandPalette,
  reducePickerOverlay,
  reduceQuestionOverlay,
  renderCommandPalette,
  renderImageOverlayChrome,
  renderPickerOverlay,
  renderQuestionOverlay,
  type CommandPaletteState,
  type DeckCommandAction,
  type ImageOverlayLayout,
  type PickerModel,
  type PickerOverlayState,
  type QuestionOverlayState,
  type SlashCommandEntry,
} from './overlay.ts'
import {
  createSwitcher,
  reduceSwitcher,
  renderSwitcher,
  updateSwitcherEntries,
  type SwitcherEntry,
  type SwitcherState,
} from './switcher.ts'
import {
  beginDrag,
  endDrag,
  extractSelection,
  isEmptySelection,
  screenToPoint,
  selectedRange,
  updateDrag,
  type DragState,
  type Selection,
} from './selection.ts'
import { sidebarHitTest } from './sidebar.ts'
import type { AgentPresetEntry, AskUserQuestionAnswer, CommandDescriptor, RpcId } from '../protocol/contract.ts'
import { cursorTo, sgr } from '../term/ansi.ts'
import { appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

/** Frame budget. 24fps is plenty for text and leaves the CPU alone while idle. */
const FRAME_INTERVAL_MS = 42
/** Spinner cadence, only ticking while at least one session runs. */
const SPINNER_INTERVAL_MS = 90

const KEY_HINTS = [
  { key: '/', label: 'commands' },
  { key: '^k', label: 'sessions' },
  { key: '^s', label: 'modes' },
  { key: '^n', label: 'new' },
  { key: '^g', label: 'help' },
]

function approvalHints(count: number): readonly { key: string; label: string }[] {
  const more = count > 1 ? ` · ${String(count - 1)} more pending` : ''
  return [
    { key: 'a', label: `allow${more}` },
    { key: 'r', label: 'reject' },
  ]
}

function questionHints(count: number): readonly { key: string; label: string }[] {
  const more = count > 1 ? ` · ${String(count - 1)} more pending` : ''
  return [{ key: '⏎', label: `answer the question${more}` }]
}

/** One modal at a time; while it exists it owns the keyboard. */
type Overlay =
  | { kind: 'question'; sessionId: SessionId; rpcId: RpcId; state: QuestionOverlayState }
  | { kind: 'picker'; sessionId: SessionId; state: PickerOverlayState }
  | { kind: 'image'; alt: string; data: Uint8Array; transmitted: boolean; layout?: ImageOverlayLayout }
  | { kind: 'switcher'; state: SwitcherState }
  | { kind: 'modes'; sessionId: SessionId; state: ModesState }
  | { kind: 'commands'; sessionId: SessionId; state: CommandPaletteState }

const DECK_COMMANDS: readonly SlashCommandEntry[] = [
  { name: 'model', description: 'Switch model and reasoning effort', action: 'model' },
  { name: 'effort', description: 'Adjust reasoning effort', action: 'model' },
  { name: 'modes', description: 'Model, preset, permission, plan, and compact', action: 'modes' },
  { name: 'preset', description: 'Switch the agent preset', action: 'modes' },
  { name: 'permissions', description: 'Inspect or switch permission mode', action: 'modes' },
  { name: 'sessions', description: 'Search and switch sessions', action: 'sessions' },
  { name: 'resume', description: 'Resume an existing session', action: 'sessions' },
  { name: 'archive', description: 'Open session manager and archive with Delete', action: 'sessions' },
  { name: 'clear', description: 'Clear the visible transcript', action: 'clear' },
  { name: 'rename', description: 'Rename the focused session', input: { hint: '<title>' }, action: 'rename' },
  { name: 'new', description: 'Start a new session', action: 'new' },
  { name: 'fork', description: 'Fork the focused session', action: 'fork' },
  { name: 'help', description: 'Show shortcuts and command help', action: 'help' },
  { name: 'exit', description: 'Exit Deck', action: 'quit' },
  { name: 'quit', description: 'Exit Deck', action: 'quit' },
  { name: 'q', description: 'Exit Deck', action: 'quit' },
]

function inRect(rect: { row: number; col: number; width: number; height: number }, row: number, col: number): boolean {
  return row >= rect.row && row < rect.row + rect.height && col >= rect.col && col < rect.col + rect.width
}

const BINDINGS = [
  { keys: 'type anything', label: 'goes to the composer — letters are never commands' },
  { keys: 'enter', label: 'send (queues behind the running turn)' },
  { keys: 'alt+enter', label: 'send as steering, interrupting the turn' },
  { keys: 'tab', label: 'next session' },
  { keys: 'ctrl+k', label: 'session manager: search, Delete archive, ^r rename, ^n new' },
  { keys: 'alt+1 … alt+9', label: 'jump to a session' },
  { keys: 'mouse', label: 'click a session to focus it; drag in the transcript to select and copy; wheel scrolls' },
  { keys: 'shift+drag', label: 'bypass deck — the terminal\u2019s own selection, always available' },
  { keys: 'ctrl+t', label: 'toggle mouse capture (off = native terminal selection)' },
  { keys: 'ctrl+n', label: 'new session in the current directory' },
  { keys: 'ctrl+s', label: 'modes: model, agent preset, permission, plan, compact' },
  { keys: 'ctrl+p', label: 'pick the model and reasoning effort' },
  { keys: 'ctrl+o', label: 'view the latest image inline (Kitty graphics)' },
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
  /** Changes to draft or caret while a prompt RPC is in flight. */
  private draftRevision = 0
  private slashOpenInFlight = false
  private scrollOffset = 0
  private spinnerFrame = 0
  private showHelp = false
  private expandTools = false
  private message: Message | undefined
  private overlay: Overlay | undefined
  private lastLayout: Layout | undefined
  private lastLines: readonly RenderedLine[] = []
  private drag: DragState | undefined
  private selection: Selection | undefined
  private mouseEnabled = true
  private readonly debugKeysPath = process.env.DECK_DEBUG_KEYS
  private messageTimer: NodeJS.Timeout | undefined
  private frameTimer: NodeJS.Timeout | undefined
  private spinnerTimer: NodeJS.Timeout | undefined
  private progressTimer: NodeJS.Timeout | undefined
  private framePending = false
  private stopped = false
  /** Sessions whose history fetch is in flight, so focus does not refetch. */
  private readonly historyInFlight = new Set<SessionId>()
  private lastProgress = -1
  /** Host-wide and immutable for a run, so fetched once and kept. */
  private agentPresets: readonly AgentPresetEntry[] | undefined
  /** Sessions whose model selection has been asked for, so focus asks once. */
  private readonly modelFetched = new Set<SessionId>()

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
    // Archived sessions stay in session.list; the registry is the only way to
    // hide them, and this is its reconnect baseline.
    const workspace = await this.client.call('workspace.list', {})
    if (workspace.ok) this.store.applyArchivedBaseline(workspace.value.archivedSessionIds)
    // Preset names are localized by the host, and the header shows one. Fetch
    // the catalog now so it reads "标准模式" from the first frame rather than
    // the bare id until the user happens to open the modes panel.
    if (this.agentPresets === undefined) {
      const presets = await this.client.call('agentPreset.list', {})
      if (presets.ok) this.agentPresets = presets.value.presets
    }
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
        // Approval is the only interaction that preempts other chrome. Preserve
        // a half-typed slash filter so the user can resume it afterwards.
        if (this.overlay?.kind === 'commands') this.replaceDraft(`/${this.overlay.state.filter}`)
        if (this.overlay?.kind === 'image') this.term.clearImages()
        this.overlay = undefined
        this.showHelp = false
        const count = pendingApprovalsOf(pending).length
        const suffix = count > 1 ? ` · ${String(count)} pending` : ''
        this.term.notify('Approval needed', `${pending.pendingApproval?.toolName ?? 'tool'} in ${this.titleOf(pending)}${suffix}`)
      }
    }
    if (kind === 'question') {
      const pending = this.store.sessions.find((s) => s.pendingQuestion !== undefined)
      if (pending !== undefined) {
        const count = pendingQuestionsOf(pending).length
        const suffix = count > 1 ? ` · ${String(count)} pending` : ''
        this.term.notify('Question from agent', `${this.titleOf(pending)}${suffix}`)
        this.maybeOpenQuestion()
      }
    }
    // Permission and plan arrive as projections on the status channel, so an
    // open modes panel picks up its own switch from the host rather than
    // guessing what the switch did.
    if (kind === 'status' || kind === 'sessions') this.refreshModes()
    this.requestFrame()
  }

  /** Auto-open the question overlay for the focused session, unless a modal is already up. */
  private maybeOpenQuestion(): void {
    if (this.overlay !== undefined) return
    const focused = this.focused()
    const pending = focused === undefined ? undefined : pendingQuestionsOf(focused)[0]
    if (focused === undefined || pending === undefined) return
    this.overlay = {
      kind: 'question',
      sessionId: focused.id,
      rpcId: pending.rpcId,
      state: createQuestionOverlay(pending.questions),
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
    // Interaction debugging: pty-driven runs cannot be watched, so this trace
    // is how mouse/keyboard issues get diagnosed. Set DECK_DEBUG_KEYS=<file>.
    if (this.debugKeysPath !== undefined) {
      try {
        appendFileSync(this.debugKeysPath, `${JSON.stringify(key)}\n`)
      } catch {
        // never let tracing break input
      }
    }
    if (key.kind === 'mouse' || key.kind === 'wheel') {
      this.onMouse(key)
      return
    }

    // A modal overlay owns the keyboard outright.
    if (this.overlay !== undefined) {
      this.onOverlayKey(this.overlay, key)
      return
    }

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
      case 'left': {
        const next = previousGraphemeBoundary(this.draft, this.cursor)
        if (next !== this.cursor) { this.cursor = next; this.draftRevision += 1 }
        this.requestFrame()
        return
      }
      case 'right': {
        const next = nextGraphemeBoundary(this.draft, this.cursor)
        if (next !== this.cursor) { this.cursor = next; this.draftRevision += 1 }
        this.requestFrame()
        return
      }
      case 'up': this.scroll(1); return
      case 'down': this.scroll(-1); return
      case 'pageup': this.scroll(this.visibleTranscriptRows()); return
      case 'pagedown': this.scroll(-this.visibleTranscriptRows()); return
      case 'home': {
        if (this.cursor !== 0) { this.cursor = 0; this.draftRevision += 1 }
        this.requestFrame()
        return
      }
      case 'end': {
        const end = codePointLength(this.draft)
        if (this.cursor !== end) { this.cursor = end; this.draftRevision += 1 }
        this.requestFrame()
        return
      }
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
      case 'u': {
        if (this.draft !== '' || this.cursor !== 0) {
          this.draft = ''
          this.cursor = 0
          this.draftRevision += 1
        }
        this.requestFrame()
        return
      }
      case 'a': {
        if (this.cursor !== 0) { this.cursor = 0; this.draftRevision += 1 }
        this.requestFrame()
        return
      }
      case 'w': this.deleteWord(); return
      case 'l': this.scrollOffset = 0; this.requestFrame(); return
      case 'p': void this.openPicker(); return
      case 'o': void this.openLatestImage(); return
      case 'k': this.openSwitcher(); return
      case 's': void this.openModes(); return
      case 't': this.toggleMouse(); return
      default: return
    }
  }

  private openSwitcher(): void {
    if (this.overlay !== undefined) return
    this.overlay = { kind: 'switcher', state: createSwitcher(this.switcherEntries(), this.store.focusedId) }
    this.requestFrame()
  }

  private switcherEntries(): SwitcherEntry[] {
    return this.store.sessions.map((s) => ({
      id: s.id,
      title: this.titleOf(s),
      ...s.cwd === undefined ? {} : { cwd: s.cwd },
      running: s.running,
      unread: s.unread,
      blocked: s.pendingApproval !== undefined || s.pendingQuestion !== undefined,
      updatedAt: s.updatedAt,
    }))
  }

  // -- modes -----------------------------------------------------------------

  /**
   * The modes panel is the one place every per-session dsh mode is switched.
   * It exists because dsh scatters them across two RPC conventions and five
   * method names, which is the host's business and not the user's: here they
   * are five rows.
   */
  private async openModes(): Promise<void> {
    const focused = this.focused()
    if (focused === undefined || this.overlay !== undefined) return
    // Normally prefetched on connect; this covers a host that gained presets
    // since, and a connect where the call failed.
    if (this.agentPresets === undefined) {
      const result = await this.client.call('agentPreset.list', {})
      if (result.ok) this.agentPresets = result.value.presets
      // Awaiting above means another overlay may have opened meanwhile.
      if (this.overlay !== undefined) return
    }
    this.overlay = { kind: 'modes', sessionId: focused.id, state: createModes(this.modeRows(focused)) }
    this.requestFrame()
  }

  private modeRows(session: SessionState): ModeRow[] {
    const modes = session.modes
    const model = modes.model
    const permissions = modes.permissions
    const plan = modes.plan

    const presetOptions = (this.agentPresets ?? []).map((preset) => ({
      value: preset.id,
      label: preset.name ?? preset.id,
      ...preset.description === undefined ? {} : { detail: preset.description },
      ...preset.id === modes.agentPreset ? { current: true } : {},
      ...preset.broken === undefined ? {} : { disabled: preset.broken },
    }))
    const presetLabel = this.agentPresets?.find((p) => p.id === modes.agentPreset)
    // The host refuses agentPreset.select once a turn has run, so say so here
    // rather than letting the user pick and collecting `agent-preset-locked`.
    const presetLocked = session.blank ? undefined : 'locked once the session has run a turn'

    return [
      {
        id: 'model',
        label: 'model',
        value: model === undefined
          ? 'host default'
          : `${model.provider} · ${shortModelId(model.model)}${model.effort === undefined ? '' : ` · ${model.effort}`}`,
      },
      {
        id: 'agent',
        label: 'agent',
        value: presetLabel?.name ?? modes.agentPreset ?? 'default',
        optionsTitle: 'agent preset',
        options: presetOptions,
        ...presetLocked === undefined ? {} : { disabled: presetLocked },
      },
      {
        id: 'permission',
        label: 'permission',
        value: permissions?.currentValue ?? 'unknown',
        optionsTitle: 'permission preset',
        options: (permissions?.options ?? []).map((option) => ({
          value: option.value,
          label: option.name,
          ...option.value === 'danger-full-access' ? { detail: 'no approval prompts at all' } : {},
          ...option.value === 'read-only' ? { detail: 'refuses every write' } : {},
          ...option.value === permissions?.currentValue ? { current: true } : {},
        })),
      },
      {
        id: 'plan',
        label: 'plan',
        value: plan === undefined ? 'unknown' : plan.pending ? 'pending' : plan.active ? 'on' : 'off',
        optionsTitle: 'plan mode',
        options: [
          { value: 'on', label: 'on', detail: 'plan first, do not touch anything', ...plan?.active === true ? { current: true } : {} },
          { value: 'off', label: 'off', ...plan?.active === false ? { current: true } : {} },
        ],
      },
      { id: 'compact', label: 'compact', value: 'compact older history now' },
    ]
  }

  /** Refresh the open panel from the store, so a switch shows its new value. */
  private refreshModes(): void {
    if (this.overlay?.kind !== 'modes') return
    const session = this.store.get(this.overlay.sessionId)
    if (session === undefined) return
    this.overlay = { ...this.overlay, state: updateModesRows(this.overlay.state, this.modeRows(session)) }
  }

  private async chooseMode(sessionId: SessionId, row: ModeRowId, value: string): Promise<void> {
    if (row === 'agent') {
      const result = await this.client.call('agentPreset.select', { sessionId, agentPreset: value })
      if (!result.ok) this.notice(`agent preset: ${result.error.message}`, 'error')
      else this.notice(`agent preset: ${result.value.agentPreset}`, 'info')
      return
    }
    if (row === 'permission') {
      await this.runCommand(sessionId, `/permission ${value}`)
      return
    }
    if (row === 'plan') {
      await this.runCommand(sessionId, value === 'on' ? '/plan' : '/plan off')
      return
    }
  }

  /**
   * Runs a dsh slash command through the Typert remote the official web UI
   * uses. Two failure layers: the RPC can fail, and a command that ran can
   * still answer `kind: 'error'`. An absent value means no command matched.
   */
  private async runCommand(sessionId: SessionId, line: string): Promise<boolean> {
    const result = await this.client.call('commands/execute', {
      args: { agentId: sessionId, line, images: [] },
    })
    if (!result.ok) {
      this.notice(`${line}: ${result.error.message}`, 'error')
      return false
    }
    const execution = result.value
    if (execution === undefined) {
      this.notice(`${line}: this host has no such command`, 'warn')
      return false
    }
    const outcome = execution.result
    if (outcome.kind === 'error') {
      this.notice(outcome.text, 'error')
      return false
    }
    if (outcome.text !== undefined && outcome.text !== '') this.notice(outcome.text, 'info')
    return true
  }

  private async archiveSession(id: SessionId): Promise<void> {
    const session = this.store.get(id)
    const wasFocused = this.store.focusedId === id
    const result = await this.client.call('workspace.archiveSession', { sessionId: id })
    if (!result.ok) {
      this.notice(`archive failed: ${result.error.message}`, 'error')
      return
    }
    this.store.applyArchivedBaseline(result.value.archivedSessionIds)
    if (wasFocused) {
      const next = this.store.sessions.find((item) => item.id !== id)
      if (next === undefined) await this.createSession()
      else this.focus(next.id)
    }
    if (this.overlay?.kind === 'switcher') {
      this.overlay = { kind: 'switcher', state: updateSwitcherEntries(this.overlay.state, this.switcherEntries()) }
    }
    this.notice(`archived ${session === undefined ? 'session' : `“${this.titleOf(session)}”`} · log kept on disk`, 'info')
    this.requestFrame()
  }

  private async renameSession(id: SessionId, title: string): Promise<void> {
    const result = await this.client.call('session.rename', { sessionId: id, title })
    if (!result.ok) this.notice(`rename failed: ${result.error.message}`, 'error')
    else this.notice(`renamed: ${result.value.title}`, 'info')
  }

  // -- mouse -----------------------------------------------------------------

  private onMouse(key: Extract<Key, { kind: 'mouse' } | { kind: 'wheel' }>): void {
    // Modal overlays are keyboard-driven; swallowing stray clicks under them
    // beats accidentally switching sessions behind a question card.
    if (this.debugKeysPath !== undefined) {
      try {
        appendFileSync(this.debugKeysPath, `#mouse overlay=${this.overlay?.kind ?? 'none'} layout=${this.lastLayout === undefined ? 'undefined' : JSON.stringify({ t: this.lastLayout.transcript, s: this.lastLayout.sidebar })} screen=${this.screen.columns}x${this.screen.rows}\n`)
      } catch { /* trace only */ }
    }
    const layout = this.lastLayout
    if (layout === undefined) return

    // The modes panel is the one overlay worth clicking: it is a list of
    // switches, and reaching for the arrow keys to flip one is the exact
    // friction the panel exists to remove.
    if (this.overlay?.kind === 'modes') {
      if (key.kind === 'mouse' && key.action === 'down' && key.button === 'left') {
        this.onModesClick(this.overlay, layout, key.row, key.col)
      }
      return
    }
    if (this.overlay !== undefined) return

    if (key.kind === 'wheel') {
      if (inRect(layout.transcript, key.row, key.col) || (layout.sidebar !== undefined && inRect(layout.sidebar, key.row, key.col))) {
        this.scroll(key.direction === 'up' ? 3 : -3)
      }
      return
    }

    if (key.action === 'down' && key.button === 'left') {
      if (layout.sidebar !== undefined && inRect(layout.sidebar, key.row, key.col)) {
        const hit = sidebarHitTest(this.store.sessions, this.store.focusedId, layout.sidebar, key.row)
        if (hit !== undefined) this.focus(hit.id)
        return
      }
      if (inRect(layout.transcript, key.row, key.col)) {
        const point = screenToPoint(layout.transcript, this.scrollOffset, this.lastLines.length, key.row, key.col)
        if (this.debugKeysPath !== undefined) {
          try {
            appendFileSync(this.debugKeysPath, `#down rect=${JSON.stringify(layout.transcript)} lines=${this.lastLines.length} scroll=${this.scrollOffset} point=${JSON.stringify(point)}\n`)
          } catch { /* trace only */ }
        }
        this.drag = beginDrag(point)
        this.selection = undefined
        this.requestFrame()
      }
      return
    }

    if (key.action === 'drag' && this.drag !== undefined) {
      const point = screenToPoint(layout.transcript, this.scrollOffset, this.lastLines.length, key.row, key.col)
      this.drag = updateDrag(this.drag, point)
      this.selection = this.drag.selection
      this.requestFrame()
      return
    }

    if (key.action === 'up' && this.drag !== undefined) {
      const { selection } = endDrag(this.drag)
      this.drag = undefined
      if (selection !== undefined && !isEmptySelection(selection)) {
        this.selection = selection
        const text = extractSelection(this.lastLines, selection)
        if (text.length > 0) {
          // Matches the user's terminal habit: releasing a selection copies it.
          this.copyText(text)
          this.notice('selection copied', 'info')
        }
      } else {
        this.selection = undefined
      }
      this.requestFrame()
    }
  }

  /**
   * A click on a mode row selects it and drills in, and a click on an option
   * chooses it — the same two steps the keyboard takes, without the keyboard.
   */
  private onModesClick(
    overlay: Extract<Overlay, { kind: 'modes' }>,
    layout: Layout,
    row: number,
    col: number,
  ): void {
    const hit = modesHitTest(overlay.state, layout.transcript, row, col)
    if (hit === undefined) return
    const state = overlay.state
    if (hit.kind === 'row') {
      const target = state.rows[hit.index]
      if (target === undefined) return
      // Route through the reducer so a disabled row, an action row, and a
      // drill-in all behave exactly as they do from the keyboard.
      this.overlay = { ...overlay, state: { ...state, cursor: hit.index } }
      this.onOverlayKey(this.overlay, { kind: 'enter' })
      return
    }
    const options = state.rows[state.cursor]?.options
    if (options === undefined || options[hit.index] === undefined) return
    this.overlay = { ...overlay, state: { ...state, optionCursor: hit.index } }
    this.onOverlayKey(this.overlay, { kind: 'enter' })
  }

  /**
   * Two-route copy, the pattern Grok Build uses: the OS clipboard tool first
   * (works even when the terminal refuses OSC 52 writes), OSC 52 as well
   * (works across SSH where pbcopy does not exist).
   */
  private copyText(text: string): void {
    if (process.platform === 'darwin') {
      try {
        const child = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] })
        child.on('error', () => { /* OSC 52 still ran */ })
        child.stdin.end(text)
      } catch {
        // OSC 52 still ran
      }
    }
    this.term.copy(text)
  }

  private toggleMouse(): void {
    this.mouseEnabled = !this.mouseEnabled
    this.screen.setMouse(this.mouseEnabled)
    this.selection = undefined
    this.drag = undefined
    this.notice(
      this.mouseEnabled ? 'mouse on' : 'mouse off — the terminal\u2019s native text selection works now',
      'info',
    )
  }

  // -- overlays --------------------------------------------------------------

  private onOverlayKey(overlay: Overlay, key: Key): void {
    if (overlay.kind === 'commands') {
      const result = reduceCommandPalette(overlay.state, key)
      if (result.kind === 'continue') {
        this.overlay = { ...overlay, state: result.state }
      } else if (result.kind === 'cancelled') {
        this.overlay = undefined
        this.replaceDraft(result.input)
      } else if (result.kind === 'complete') {
        this.overlay = undefined
        this.replaceDraft(`/${normalizedCommandName(result.command.name)} `)
      } else {
        this.overlay = undefined
        this.replaceDraft('')
        this.runSlashEntry(overlay.sessionId, result.command)
      }
      this.requestFrame()
      return
    }
    if (overlay.kind === 'modes') {
      const result = reduceModes(overlay.state, key)
      switch (result.kind) {
        case 'continue':
          this.overlay = { ...overlay, state: result.state }
          break
        case 'chose':
          // The panel stays open: switching a mode is usually one of several
          // adjustments, and the row must visibly take the new value.
          this.overlay = { ...overlay, state: result.state }
          void this.chooseMode(overlay.sessionId, result.row, result.value)
          break
        case 'fired':
          this.overlay = undefined
          if (result.row === 'model') void this.openPicker()
          else if (result.row === 'compact') void this.runCommand(overlay.sessionId, '/compact')
          break
        case 'cancelled':
          this.overlay = undefined
          break
      }
      this.requestFrame()
      return
    }
    if (overlay.kind === 'switcher') {
      const result = reduceSwitcher(overlay.state, key)
      switch (result.kind) {
        case 'continue': this.overlay = { kind: 'switcher', state: result.state }; break
        case 'focus': this.overlay = undefined; this.focus(result.id); break
        case 'archive': this.overlay = { kind: 'switcher', state: result.state }; void this.archiveSession(result.id); break
        case 'rename': this.overlay = undefined; void this.renameSession(result.id, result.title); break
        case 'create': this.overlay = undefined; void this.createSession(); break
        case 'cancelled': this.overlay = undefined; break
      }
      this.requestFrame()
      return
    }
    if (overlay.kind === 'question') {
      const result = reduceQuestionOverlay(overlay.state, key)
      if (result.kind === 'continue') {
        this.overlay = { ...overlay, state: result.state }
      } else if (result.kind === 'answered') {
        this.overlay = undefined
        void this.respondQuestion(overlay.sessionId, overlay.rpcId, result.answer)
      } else {
        // Keep the store pending until the host emits question/resolved. That
        // frame promotes the next queued batch, if any, and is the source of
        // truth for whether cancellation actually took effect.
        this.overlay = undefined
        void this.cancelQuestion(overlay.rpcId)
      }
      this.requestFrame()
      return
    }
    if (overlay.kind === 'picker') {
      const result = reducePickerOverlay(overlay.state, key)
      if (result.kind === 'continue') {
        this.overlay = { ...overlay, state: result.state }
      } else if (result.kind === 'picked') {
        this.overlay = undefined
        void this.applyModelSelection(overlay.sessionId, result.selection)
      } else {
        this.overlay = undefined
      }
      this.requestFrame()
      return
    }
    // image viewer
    if (key.kind === 'escape' || (key.kind === 'char' && key.char.toLowerCase() === 'q')) {
      this.term.clearImages()
      this.overlay = undefined
      this.requestFrame()
      return
    }
    if (key.kind === 'char' && key.char.toLowerCase() === 'y') {
      this.copyText(overlay.alt)
      this.notice('copied', 'info')
    }
  }

  private async respondQuestion(sessionId: SessionId, rpcId: RpcId, answer: AskUserQuestionAnswer): Promise<void> {
    const receipt = await this.client.respond(rpcId, { sessionId, answer })
    if (!receipt.accepted) this.notice(`answer not accepted: ${receipt.reason}`, 'warn')
    else this.notice('answered', 'info')
  }

  private async cancelQuestion(rpcId: RpcId): Promise<void> {
    const receipt = await this.client.respondError(rpcId, {
      code: 'cancelled',
      message: 'the user cancelled ask_user_question',
      details: {},
    })
    if (!receipt.accepted) {
      this.notice(`question cancellation not accepted: ${receipt.reason}`, 'warn')
      // The host did not accept the cancellation, so leave the pending card
      // answerable instead of making the user hunt for it in the sidebar.
      this.maybeOpenQuestion()
      return
    }
    this.notice('question cancelled', 'info')
  }

  private async openPicker(): Promise<void> {
    const focused = this.focused()
    if (focused === undefined || this.overlay !== undefined) return
    const result = await this.client.call('session.models', { sessionId: focused.id })
    if (!result.ok) {
      this.notice(`models unavailable: ${result.error.message}`, 'error')
      return
    }
    const current = currentModelOf(result.value)
    if (current !== undefined) this.store.applyModelSelection(focused.id, current)
    const models = mapModelCatalog(result.value)
    if (models.length === 0) {
      this.notice('the host advertises no models', 'warn')
      return
    }
    this.overlay = { kind: 'picker', sessionId: focused.id, state: createPickerOverlay(models) }
    this.requestFrame()
  }

  /** Merge Deck chrome actions with the live host registry when `/` is typed. */
  private async maybeOpenCommandPalette(): Promise<void> {
    if (this.slashOpenInFlight || this.overlay !== undefined) return
    if (!this.draft.startsWith('/') || /\s/u.test(this.draft)) return
    const focused = this.focused()
    if (focused === undefined) return
    this.slashOpenInFlight = true
    const result = await this.client.call('commands/list', { args: { agentId: focused.id } })
    this.slashOpenInFlight = false
    if (this.overlay !== undefined || this.store.focusedId !== focused.id) return
    if (!this.draft.startsWith('/') || /\s/u.test(this.draft)) return
    const filter = this.draft.slice(1)
    const hostCommands = result.ok ? result.value : []
    if (!result.ok) this.notice(`host commands unavailable: ${result.error.message}`, 'warn')
    this.replaceDraft('')
    this.overlay = {
      kind: 'commands',
      sessionId: focused.id,
      state: createCommandPalette(mergeCommandCatalog(DECK_COMMANDS, hostCommands), filter),
    }
    this.requestFrame()
  }

  private runSlashEntry(sessionId: SessionId, command: SlashCommandEntry): void {
    if (command.input !== undefined) {
      this.replaceDraft(`/${normalizedCommandName(command.name)} `)
      this.requestFrame()
      return
    }
    const action = command.action
    if (action !== undefined) {
      this.runDeckCommand(action)
      return
    }
    void this.runCommand(sessionId, `/${normalizedCommandName(command.name)}`)
  }

  private runDeckCommand(action: DeckCommandAction, input = ''): void {
    switch (action) {
      case 'model': void this.openPicker(); return
      case 'modes': void this.openModes(); return
      case 'sessions': this.openSwitcher(); return
      case 'clear': {
        const focused = this.focused()
        if (focused !== undefined) this.store.clearTranscriptView(focused.id)
        this.scrollOffset = 0
        this.notice('visible transcript cleared', 'info')
        return
      }
      case 'rename': {
        const focused = this.focused()
        if (focused === undefined) return
        if (input.length === 0) { this.notice('usage: /rename <title>', 'warn'); return }
        void this.renameSession(focused.id, input)
        return
      }
      case 'new': void this.createSession(); return
      case 'fork': void this.fork(); return
      case 'help': this.showHelp = true; this.requestFrame(); return
      case 'quit': void this.quit(); return
    }
  }

  private async applyModelSelection(
    sessionId: SessionId,
    selection: { provider: string; model: string; reasoningEffort?: string },
  ): Promise<void> {
    const result = await this.client.call('session.selectModel', { sessionId, ...selection })
    if (!result.ok) {
      this.notice(`model change failed: ${result.error.message}`, 'error')
      return
    }
    const selected = result.value.selected
    this.store.applyModelSelection(sessionId, {
      provider: selected.provider,
      model: selected.model,
      ...selected.reasoningEffort === undefined ? {} : { effort: selected.reasoningEffort },
    })
    this.notice(`model: ${selected.provider} · ${shortModelId(selected.model)}`, 'info')
  }

  private async openLatestImage(): Promise<void> {
    const focused = this.focused()
    if (focused === undefined || this.overlay !== undefined) return
    const items = focused.transcript.items
    let image: { attachmentId?: string; alt: string } | undefined
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i]
      if (item !== undefined && item.kind === 'image') {
        image = { ...item.attachmentId === undefined ? {} : { attachmentId: item.attachmentId }, alt: item.alt }
        break
      }
    }
    if (image === undefined) { this.notice('no image in this session', 'info'); return }
    if (!this.caps.kittyGraphics) { this.notice('this terminal cannot render images (try Ghostty)', 'warn'); return }
    if (image.attachmentId === undefined) { this.notice('image has no durable attachment', 'warn'); return }
    const result = await this.client.call('session.attachment', {
      sessionId: focused.id,
      attachmentId: image.attachmentId,
    })
    if (!result.ok) {
      this.notice(`attachment fetch failed: ${result.error.message}`, 'error')
      return
    }
    const data = Uint8Array.from(Buffer.from(result.value.data, 'base64'))
    this.overlay = { kind: 'image', alt: image.alt, data, transmitted: false }
    this.requestFrame()
  }

  /** Returns the session whose approval should be answered, preferring the focused one. */
  private pendingApprovalTarget(): SessionState | undefined {
    const focused = this.focused()
    if (focused?.pendingApproval !== undefined) return focused
    return this.store.sessions.find((s) => pendingApprovalsOf(s).length > 0)
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
    const end = graphemeBoundaryAtOrBefore(this.draft, this.cursor)
    let i = end
    while (i > 0) {
      const start = previousGraphemeBoundary(this.draft, i)
      if (codePointSlice(this.draft, start, i) !== ' ') break
      i = start
    }
    while (i > 0) {
      const start = previousGraphemeBoundary(this.draft, i)
      if (codePointSlice(this.draft, start, i) === ' ') break
      i = start
    }
    chars.splice(i, end - i)
    this.draft = chars.join('')
    this.cursor = i
    if (end !== i) this.draftRevision += 1
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
    if (clean.length > 0) {
      this.cursor += [...clean].length
      this.draftRevision += 1
    }
    this.requestFrame()
    if (this.draft.startsWith('/') && !/\s/u.test(this.draft)) void this.maybeOpenCommandPalette()
  }

  private replaceDraft(text: string): void {
    this.draft = text
    this.cursor = codePointLength(text)
    this.draftRevision += 1
  }

  private backspace(): void {
    const previous = previousGraphemeBoundary(this.draft, this.cursor)
    if (previous === this.cursor) return
    const chars = [...this.draft]
    chars.splice(previous, this.cursor - previous)
    this.draft = chars.join('')
    this.cursor = previous
    this.draftRevision += 1
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
    this.selection = undefined
    this.drag = undefined
    void this.loadHistory(id)
    void this.loadModelSelection(id)
    this.maybeOpenQuestion()
    this.requestFrame()
  }

  /**
   * Nothing on the wire announces which model a session is using — there is no
   * projection for it — so the header would otherwise show the host-wide
   * default forever. `session.models` is the only source, and it is asked once
   * per session.
   */
  private async loadModelSelection(id: SessionId): Promise<void> {
    if (this.modelFetched.has(id)) return
    this.modelFetched.add(id)
    const result = await this.client.call('session.models', { sessionId: id })
    if (!result.ok) {
      this.modelFetched.delete(id)
      return
    }
    const current = currentModelOf(result.value)
    if (current !== undefined) this.store.applyModelSelection(id, current)
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
    // The tail page carries a one-shot cut over every projection — titles,
    // context pressure, session stats. Nothing else replays it, so a cold
    // session would otherwise show no title until its next live projection.
    const projections = result.value.projections
    if (projections !== undefined) {
      for (const [key, value] of Object.entries(projections.values)) {
        this.store.applyMux(
          { type: 'session/projection', sessionId: id, key, value, seq: projections.asOfSeq },
          crypto.randomUUID(),
        )
      }
    }
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
    const originalDraft = this.draft
    const originalCursor = this.cursor
    const text = originalDraft.trim()
    const focused = this.focused()
    // Enter on an empty draft reopens a dismissed question card instead of
    // being a no-op: the agent is blocked until it gets an answer.
    if (text === '' && focused?.pendingQuestion !== undefined) {
      this.maybeOpenQuestion()
      return
    }
    if (text === '' || focused === undefined) return
    this.draft = ''
    this.cursor = 0
    this.draftRevision += 1
    const clearedRevision = this.draftRevision
    this.scrollOffset = 0
    this.requestFrame()
    const slash = parseSlashCommand(text)
    if (slash !== undefined) {
      const local = DECK_COMMANDS.find((command) => normalizedCommandName(command.name) === slash.name)
      if (local?.action !== undefined) {
        this.runDeckCommand(local.action, slash.input)
        return
      }
      const accepted = await this.runCommand(focused.id, text)
      if (!accepted && this.draftRevision === clearedRevision) {
        this.draft = originalDraft
        this.cursor = originalCursor
        this.draftRevision += 1
        this.requestFrame()
      }
      return
    }
    const result = await this.client.call('session.prompt', {
      sessionId: focused.id,
      mode,
      content: [{ type: 'text', text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    if (!result.ok) {
      // Keep the optimistic clear, but make a failed prompt retryable when the
      // user has not edited the composer while the RPC was in flight. A newer
      // draft/caret wins and must never be overwritten by this recovery.
      if (this.draftRevision === clearedRevision) {
        this.draft = originalDraft
        this.cursor = originalCursor
        this.draftRevision += 1
        this.requestFrame()
      }
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
        this.copyText(item.text)
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
    const sidebarHidden = this.store.sessions.length <= 1
    return Math.max(1, computeLayout(this.screen.columns, this.screen.rows, { sidebarHidden }).transcript.height)
  }

  private focused(): SessionState | undefined {
    return this.store.focusedId === undefined ? undefined : this.store.get(this.store.focusedId)
  }

  /** Flattens session mode state into the header's chip cluster. */
  private modeSummary(session: SessionState): ModeSummary {
    const { model, permissions, plan, agentPreset } = session.modes
    const preset = this.agentPresets?.find((p) => p.id === agentPreset)?.name ?? agentPreset
    return {
      ...model === undefined ? {} : {
        provider: model.provider,
        model: model.model,
        ...model.effort === undefined ? {} : { effort: model.effort },
      },
      ...permissions === undefined ? {} : { permission: permissions.currentValue },
      ...plan === undefined ? {} : { plan },
      ...preset === undefined ? {} : { preset },
    }
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
      this.screen.hideCursor()
      return
    }

    const sidebarHidden = this.store.sessions.length <= 1
    const baseLayout = computeLayout(columns, rows, { sidebarHidden })
    const draftRows = Math.min(4, Math.max(1, Math.ceil(
      Math.max(1, stringWidth(this.draft) + 3) / Math.max(1, baseLayout.composer.width - 2),
    )))
    const layout: Layout = computeLayout(columns, rows, { composerHeight: draftRows, sidebarHidden })
    const focused = this.focused()

    renderHeader(this.screen, {
      rect: layout.header,
      host: this.host,
      connection: this.connectionState,
      sessionTitle: focused === undefined ? undefined : this.titleOf(focused),
      theme: this.theme,
      glyphs: this.glyphs,
      ...focused === undefined ? {} : { telemetry: focused.telemetry },
      ...focused === undefined ? {} : { modes: this.modeSummary(focused) },
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
      const retrying = focused.transcript.retrying
      lines = layoutTranscript(focused.transcript.items, {
        width: layout.transcript.width,
        theme: this.theme,
        glyphs: this.glyphs,
        spinnerFrame: this.spinnerFrame,
        expandTools: this.expandTools,
        queue: focused.queue,
        ...retrying === undefined ? {} : { retrying: { count: retrying.count, ...retrying.reason === undefined ? {} : { reason: retrying.reason } } },
      })
      if (lines.length === 0) {
        lines = [
          { spans: [{ text: 'No messages yet.', style: this.theme.subtle }] },
          { spans: [{ text: '/ commands  ·  Ctrl+K sessions  ·  Ctrl+G help', style: this.theme.dim }] },
        ]
      }
    }
    const { maxScroll } = renderTranscript(this.screen, {
      rect: layout.transcript,
      lines,
      scrollOffset: this.scrollOffset,
      theme: this.theme,
    })
    if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll
    this.lastLayout = layout
    this.lastLines = lines
    this.paintSelection(layout, lines)

    this.screen.fill(
      layout.composer.row - 1,
      layout.composer.col,
      layout.composer.width,
      1,
      this.glyphs.hline,
      this.theme.border,
    )
    const caret = renderComposer(this.screen, {
      rect: layout.composer,
      draft: this.draft,
      cursor: this.cursor,
      mode: 'queue',
      busy: focused?.running ?? false,
      theme: this.theme,
      glyphs: this.glyphs,
    })

    const focusedForHints = this.focused()
    const approvalForHints = this.pendingApprovalTarget()
    const approvalCount = approvalForHints === undefined ? 0 : pendingApprovalsOf(approvalForHints).length
    const questionCount = focusedForHints === undefined ? 0 : pendingQuestionsOf(focusedForHints).length
    renderFooter(this.screen, {
      rect: layout.footer,
      // The hint row is how the user learns the keyboard has changed mode.
      hints: approvalForHints !== undefined
        ? approvalHints(approvalCount)
        : questionCount > 0 && (this.overlay === undefined || this.overlay.kind === 'question')
          ? questionHints(questionCount)
          : KEY_HINTS,
      message: this.message,
      theme: this.theme,
    })

    if (this.showHelp) {
      renderHelp(this.screen, layout.transcript, this.theme, BINDINGS)
    }

    let imageLayout: ImageOverlayLayout | undefined
    if (this.overlay !== undefined) {
      if (this.overlay.kind === 'modes') {
        renderModes(this.screen, layout.transcript, this.overlay.state, this.theme, this.glyphs)
      } else if (this.overlay.kind === 'switcher') {
        renderSwitcher(this.screen, layout.transcript, this.overlay.state, this.theme, this.glyphs)
      } else if (this.overlay.kind === 'question') {
        renderQuestionOverlay(this.screen, layout.transcript, this.overlay.state, this.theme, this.glyphs)
      } else if (this.overlay.kind === 'picker') {
        renderPickerOverlay(this.screen, layout.transcript, this.overlay.state, this.theme, this.glyphs)
      } else if (this.overlay.kind === 'commands') {
        renderCommandPalette(this.screen, layout.transcript, this.overlay.state, this.theme, this.glyphs)
      } else {
        imageLayout = this.overlay.layout ?? layoutImageOverlay(layout.transcript, this.overlay.alt)
        this.overlay.layout = imageLayout
        renderImageOverlayChrome(this.screen, imageLayout, this.theme, this.glyphs)
      }
    }

    this.screen.end()

    // Kitty graphics ride outside the cell diff: transmit once, after the
    // chrome frame has been flushed, at the panel's inner origin.
    if (this.overlay !== undefined && this.overlay.kind === 'image' && !this.overlay.transmitted && imageLayout !== undefined) {
      this.overlay.transmitted = true
      process.stdout.write(cursorTo(imageLayout.imageCell.row, imageLayout.imageCell.col))
      this.term.image(this.overlay.data, {
        columns: imageLayout.imageCell.columns,
        rows: imageLayout.imageCell.rows,
      })
    }
    if (this.overlay === undefined) this.screen.showCursorAt(caret.row, caret.col)
    else this.screen.hideCursor()
  }

  /**
   * Overpaint the selected slice of each visible line in reverse video.
   * Reuses screenToPoint so highlighting and extraction share one mapping.
   */
  private paintSelection(layout: Layout, lines: readonly RenderedLine[]): void {
    const sel = this.drag?.selection ?? this.selection
    if (sel === undefined || isEmptySelection(sel) || this.overlay !== undefined) return
    const rect = layout.transcript
    for (let row = rect.row; row < rect.row + rect.height; row += 1) {
      const point = screenToPoint(rect, this.scrollOffset, lines.length, row, rect.col)
      if (point === undefined) continue
      const line = lines[point.line]
      if (line === undefined) continue
      const width = stringWidth(line.spans.map((span) => span.text).join(''))
      const range = selectedRange(sel, point.line, width)
      if (range === undefined || range.to <= range.from) continue
      const slice = extractSelection([...lines], {
        anchor: { line: point.line, column: range.from },
        head: { line: point.line, column: range.to },
      })
      if (slice.length === 0) continue
      this.screen.put(row, rect.col + range.from, slice, sgr(7))
    }
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
    this.syncProgressHeartbeat(state)
    const label = focused === undefined ? 'deck' : `deck · ${this.titleOf(focused)}`
    this.term.title(blocked ? `${label} · approval needed` : running ? `${label} · working` : label)
  }

  /**
   * Ghostty clears a progress bar it has not heard from in about 15 seconds, so
   * a long quiet turn would lose its indicator even though the agent is still
   * working. Re-assert the current state once a second, and only while there is
   * one to assert.
   */
  private syncProgressHeartbeat(state: number): void {
    if (state === 0) {
      if (this.progressTimer !== undefined) {
        clearInterval(this.progressTimer)
        this.progressTimer = undefined
      }
      return
    }
    if (this.progressTimer !== undefined) return
    this.progressTimer = setInterval(() => {
      if (this.lastProgress === 2 || this.lastProgress === 3) this.term.progress(this.lastProgress)
    }, 1000)
    this.progressTimer.unref?.()
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
    if (this.progressTimer !== undefined) clearInterval(this.progressTimer)
    if (this.messageTimer !== undefined) clearTimeout(this.messageTimer)
    this.term.progress(0)
    if (this.overlay?.kind === 'image') this.term.clearImages()
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

function normalizedCommandName(name: string): string {
  return name.replace(/^\/+/, '')
}

function parseSlashCommand(line: string): { name: string; input: string } | undefined {
  const match = /^\/([a-z][a-z0-9_-]*)(?:\s+(.*))?$/iu.exec(line)
  if (match === null || match[1] === undefined) return undefined
  return { name: match[1].toLocaleLowerCase(), input: match[2]?.trim() ?? '' }
}

function mergeCommandCatalog(
  locals: readonly SlashCommandEntry[],
  host: readonly CommandDescriptor[],
): SlashCommandEntry[] {
  const out: SlashCommandEntry[] = []
  const seen = new Set<string>()
  const firstScreen = new Set(['model', 'modes', 'sessions', 'new'])
  const ordered = [
    ...locals.filter((command) => firstScreen.has(normalizedCommandName(command.name))),
    ...host,
    ...locals.filter((command) => !firstScreen.has(normalizedCommandName(command.name))),
  ]
  for (const command of ordered) {
    const name = normalizedCommandName(command.name)
    if (name.length === 0 || seen.has(name)) continue
    seen.add(name)
    out.push({ ...command, name })
  }
  return out
}

function codePointLength(text: string): number {
  return [...text].length
}

function codePointSlice(text: string, start: number, end?: number): string {
  return [...text].slice(start, end).join('')
}

/** Cursor indices stay code-point based for the renderer, but movement is grapheme based. */
function previousGraphemeBoundary(text: string, cursor: number): number {
  let offset = 0
  for (const cluster of graphemes(text)) {
    const next = offset + codePointLength(cluster)
    if (cursor <= next) return offset
    offset = next
  }
  return offset
}

function graphemeBoundaryAtOrBefore(text: string, cursor: number): number {
  let offset = 0
  for (const cluster of graphemes(text)) {
    const next = offset + codePointLength(cluster)
    if (cursor < next) return offset
    offset = next
  }
  return offset
}

function nextGraphemeBoundary(text: string, cursor: number): number {
  let offset = 0
  for (const cluster of graphemes(text)) {
    const next = offset + codePointLength(cluster)
    if (cursor < next) return next
    offset = next
  }
  return offset
}

/**
 * `thinkingmachines/inkling` reads as `inkling`. The vendor prefix is the same
 * on every model from one route and the route is already shown beside it.
 */
function shortModelId(model: string): string {
  const cut = model.lastIndexOf('/')
  return cut === -1 ? model : model.slice(cut + 1)
}

/** Pulls `current` out of a `session.models` value, which is typed unknown. */
function currentModelOf(value: unknown): { provider: string; model: string; effort?: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const current = (value as { current?: unknown }).current
  if (typeof current !== 'object' || current === null) return undefined
  const { provider, model, reasoningEffort } = current as {
    provider?: unknown
    model?: unknown
    reasoningEffort?: unknown
  }
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined
  return {
    provider,
    model,
    ...typeof reasoningEffort === 'string' ? { effort: reasoningEffort } : {},
  }
}

/**
 * Map the host's advisory model directory onto the picker's structural input.
 * Shape verified against a live rc.7 host:
 * `{ current: {provider, model}, groups: [{ id, name, models: [{ id, name,
 * reasoning?: { efforts: [{id, name}], defaultEffort? } }] }] }`.
 * Defensive throughout — the value is typed unknown on the wire.
 */
function mapModelCatalog(value: unknown): PickerModel[] {
  if (typeof value !== 'object' || value === null) return []
  const root = value as { current?: unknown; groups?: unknown }
  const current = (typeof root.current === 'object' && root.current !== null)
    ? root.current as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
    : undefined
  if (!Array.isArray(root.groups)) return []
  const out: PickerModel[] = []
  for (const group of root.groups) {
    if (typeof group !== 'object' || group === null) continue
    const g = group as { id?: unknown; name?: unknown; models?: unknown }
    if (typeof g.id !== 'string' || !Array.isArray(g.models)) continue
    for (const model of g.models) {
      if (typeof model !== 'object' || model === null) continue
      const m = model as { id?: unknown; name?: unknown; reasoning?: unknown }
      if (typeof m.id !== 'string') continue
      const reasoning = (typeof m.reasoning === 'object' && m.reasoning !== null)
        ? m.reasoning as { efforts?: unknown; defaultEffort?: unknown }
        : undefined
      const efforts = Array.isArray(reasoning?.efforts)
        ? reasoning.efforts
          .map((e) => (typeof e === 'object' && e !== null && typeof (e as { id?: unknown }).id === 'string')
            ? (e as { id: string }).id
            : undefined)
          .filter((id): id is string => id !== undefined)
        : []
      out.push({
        provider: g.id,
        ...typeof g.name === 'string' ? { providerName: g.name } : {},
        id: m.id,
        ...typeof m.name === 'string' ? { name: m.name } : {},
        ...efforts.length > 0 ? { efforts } : {},
        ...typeof reasoning?.defaultEffort === 'string' ? { defaultEffort: reasoning.defaultEffort } : {},
        ...current?.provider === g.id && current.model === m.id ? { current: true } : {},
        ...current?.provider === g.id
          && current.model === m.id
          && typeof current.reasoningEffort === 'string'
          ? { currentEffort: current.reasoningEffort }
          : {},
      })
    }
  }
  return out
}
