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
  type StoreChange,
} from '../model/store.ts'
import type { HostDescription, ResponseValue, RpcResult, SessionId } from '../protocol/contract.ts'
import { detectCapabilities, type TerminalCapabilities } from '../term/capabilities.ts'
import { Screen } from '../term/screen.ts'
import { InputReader, type Key } from '../term/input.ts'
import { TerminalIntegration } from '../term/ghostty.ts'
import {
  graphemeBoundaryAtOrBefore,
  graphemes,
  nextGraphemeBoundary,
  previousGraphemeBoundary,
  stringWidth,
} from '../term/width.ts'
import { createGlyphs, createTheme, type Glyphs, type Theme } from './theme.ts'
import { computeLayout, viewportTooSmall, type Layout } from './layout.ts'
import { codePointLength, codePointSlice } from './render.ts'
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
  createQueueOverlay,
  createRewindOverlay,
  layoutImageOverlay,
  reduceCommandPalette,
  reducePickerOverlay,
  reduceQuestionOverlay,
  reduceQueueOverlay,
  reduceRewindOverlay,
  renderCommandPalette,
  renderInfoOverlay,
  renderImageOverlayChrome,
  renderPickerOverlay,
  renderQuestionOverlay,
  renderQueueOverlay,
  renderRewindOverlay,
  updateQueueOverlayItems,
  type CommandPaletteState,
  type DeckCommandAction,
  type InfoOverlayState,
  type ImageOverlayLayout,
  type PickerModel,
  type PickerOverlayState,
  type QuestionOverlayState,
  type QueueOverlayItem,
  type QueueOverlayState,
  type RewindOverlayState,
  type SlashCommandEntry,
} from './overlay.ts'
import { loadPrefs, savePrefs } from '../model/prefs.ts'
import {
  createDashboard,
  reduceDashboard,
  renderDashboard,
  updateDashboardSessions,
  visibleDashboardRows,
  type DashboardSession,
  type DashboardState,
} from './dashboard.ts'
import { doctorFindings, doctorFix, doctorFixLines, doctorLines, type DoctorInput } from './doctor.ts'
import { reduceVimComposer, type VimInsertMode } from './vim.ts'
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
import type { AgentPresetEntry, AskUserQuestionAnswer, CommandDescriptor, QueuedInboxItem, RpcId } from '../protocol/contract.ts'
import { cursorTo, sgr } from '../term/ansi.ts'
import { appendFileSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  buildHarnessOverlay,
  discoverHarnesses,
  harnessLabel,
  isHarnessId,
  isSessionHarness,
  spawnHarnessTurn,
  harnessAssistantText,
  type HarnessTurnResult,
  type OverlayPlan,
  type SessionHarness,
} from '../harness.ts'

/** Frame budget. 24fps is plenty for text and leaves the CPU alone while idle. */
const FRAME_INTERVAL_MS = 42
/** Spinner cadence, only ticking while at least one session runs. */
const SPINNER_INTERVAL_MS = 90

const KEY_HINTS = [
  { key: '/', label: 'commands' },
  { key: 'tab', label: 'switch' },
  { key: '^k', label: 'sessions' },
  { key: '^\\', label: 'dashboard' },
  { key: '^s', label: 'modes · harness' },
  { key: '^g', label: 'help' },
]

const VIM_HINTS = [
  { key: 'j/k', label: 'scroll' },
  { key: 'g/G', label: 'top/bottom' },
  { key: 'i', label: 'insert' },
  { key: 'esc esc', label: 'rewind' },
]

const ESC_REWIND_MS = 700
const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp)$/i
const DOCTOR_FOOTER = 'f fix · ↑↓ scroll · ⏎/esc close'

function approvalHints(count: number, target: string, tool: string): readonly { key: string; label: string }[] {
  const more = count > 1 ? ` · ${String(count - 1)} more pending` : ''
  return [
    { key: 'a/y/⏎', label: `allow ${tool} in ${target}${more}` },
    { key: 'r/n/esc', label: 'reject' },
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
  | { kind: 'switcher'; state: SwitcherState; live: boolean }
  | { kind: 'modes'; sessionId: SessionId; state: ModesState }
  | { kind: 'commands'; sessionId: SessionId; state: CommandPaletteState }
  | { kind: 'info'; state: InfoOverlayState }
  | { kind: 'rewind'; sessionId: SessionId; state: RewindOverlayState }
  | { kind: 'queue'; sessionId: SessionId; state: QueueOverlayState }
  | { kind: 'dashboard'; state: DashboardState }

const DECK_COMMANDS: readonly SlashCommandEntry[] = [
  { name: 'model', description: 'Switch model and reasoning effort', action: 'model' },
  { name: 'effort', description: 'Adjust reasoning effort', action: 'model' },
  { name: 'modes', description: 'Model, harness, preset, permission, and plan', action: 'modes' },
  { name: 'harness', description: 'Switch the PATH coding harness for this session', action: 'harness' },
  { name: 'preset', description: 'Switch the agent preset', action: 'modes' },
  { name: 'permissions', description: 'Inspect or switch permission mode', action: 'modes' },
  { name: 'sessions', description: 'Search and switch sessions', action: 'sessions' },
  { name: 'resume', description: 'Resume an existing session', action: 'sessions' },
  { name: 'archive', description: 'Open session manager and archive with Delete', action: 'sessions' },
  { name: 'clear', description: 'Clear the visible transcript', action: 'clear' },
  { name: 'rename', description: 'Rename the focused session', input: { hint: '<title>' }, action: 'rename' },
  { name: 'new', description: 'Start a new session', action: 'new' },
  { name: 'fork', description: 'Fork the focused session', action: 'fork' },
  { name: 'rewind', description: 'Fork the focused session at a previous turn', action: 'rewind' },
  { name: 'cancel', description: 'Interrupt the running turn', action: 'cancel' },
  { name: 'interrupt', description: 'Interrupt the running turn', action: 'cancel' },
  { name: 'dashboard', description: 'Peek, reply, dispatch, search, pin, and rename sessions', action: 'dashboard' },
  { name: 'agents-dashboard', description: 'Peek, reply, dispatch, search, pin, and rename sessions', action: 'dashboard' },
  { name: 'queue', description: 'Edit, remove, or steer pending messages', action: 'queue' },
  { name: 'dequeue', description: 'Remove a pending message', input: { hint: '<id>' }, action: 'remove-queued' },
  { name: 'steer-queued', description: 'Promote a queued message to steering', input: { hint: '<id>' }, action: 'steer-queued' },
  { name: 'doctor', description: 'Check terminal, host, and clipboard capabilities; /doctor fix applies in-process repairs', action: 'doctor' },
  { name: 'vim-mode', description: 'Toggle vim keys: composer i/a/h/l, Esc Esc parks the transcript', action: 'vim' },
  { name: 'vim', description: 'Toggle vim-style scrollback keys', action: 'vim' },
  { name: 'status', description: 'Show session, model, mode, and queue status', action: 'status' },
  { name: 'context', description: 'Show context-window and token breakdown', action: 'cost' },
  { name: 'cost', description: 'Show token and cache usage', action: 'cost' },
  { name: 'tokens', description: 'Show token and cache usage', action: 'cost' },
  { name: 'skills', description: 'List skills available to this session', action: 'skills' },
  { name: 'agents', description: 'List subagents and their activity', action: 'agents' },
  { name: 'interrupt-agent', description: 'Interrupt a continuable subagent', input: { hint: '<id>' }, action: 'interrupt-agent' },
  { name: 'workspaces', description: 'List registered dsh workspaces', action: 'workspaces' },
  { name: 'search', description: 'Search persisted session content', input: { hint: '<query>' }, action: 'search' },
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
  { keys: 'option+return', label: 'steer at the next step boundary (does not cancel the turn)' },
  { keys: 'tab', label: 'next session' },
  { keys: 'ctrl+k', label: 'session manager: search, Delete archive, ^r rename, ^n new' },
  { keys: 'ctrl+\\', label: 'dashboard: peek, reply, dispatch, search, pin, rename' },
  { keys: '/doctor', label: 'diagnostics; /doctor fix (or f) applies in-process repairs' },
  { keys: '/vim-mode', label: 'composer vim (i/a/h/l); Esc Esc parks the transcript' },
  { keys: '/queue', label: 'edit, remove, or steer pending messages' },
  { keys: 'alt+1 … alt+9', label: 'jump to a session' },
  { keys: 'mouse', label: 'click a session to focus it; drag in the transcript to select and copy; wheel scrolls' },
  { keys: 'shift+drag', label: 'bypass deck — the terminal\u2019s own selection, always available' },
  { keys: 'ctrl+t', label: 'toggle mouse capture (off = native terminal selection)' },
  { keys: 'ctrl+n', label: 'new session in the current directory' },
  { keys: 'ctrl+s', label: 'modes: model, harness, agent preset, permission, plan' },
  { keys: 'ctrl+p', label: 'pick the model and reasoning effort' },
  { keys: 'ctrl+o', label: 'view the latest image inline (Kitty graphics)' },
  { keys: 'ctrl+f', label: 'fork the focused session' },
  { keys: 'ctrl+c', label: 'cancel the running turn, or quit when idle' },
  { keys: 'ctrl+d', label: 'quit' },
  { keys: 'ctrl+y', label: 'copy the last answer to the clipboard' },
  { keys: 'ctrl+e / cmd+right', label: 'move to the end of the draft' },
  { keys: 'ctrl+x', label: 'expand or collapse tool detail' },
  { keys: 'ctrl+r', label: 'expand or collapse reasoning' },
  { keys: 'esc esc', label: 'rewind: fork the session at a previous turn' },
  { keys: 'option+b / option+f', label: 'move one word left / right' },
  { keys: 'option+backspace / ctrl+w', label: 'delete the previous word' },
  { keys: 'ctrl+u', label: 'clear the draft' },
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
  /** Tests inject a stub so a prompt never launches a real vendor CLI. */
  runHarnessTurn?: (plan: OverlayPlan, signal?: AbortSignal) => Promise<HarnessTurnResult>
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
  private theme: Theme
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
  /** Drafts belong to sessions; switching must never send A's text to B. */
  private readonly sessionDrafts = new Map<SessionId, { draft: string; cursor: number; revision: number }>()
  private slashOpenInFlight = false
  private scrollOffset = 0
  private spinnerFrame = 0
  private showHelp = false
  private expandTools = false
  private expandReasoning = false
  private sendMode: 'queue' | 'steer' = 'queue'
  /** Opt-in: `/vim-mode` or `DECK_VIM=1`. Composer vim + optional transcript park. */
  private vimMode = false
  /** Composer insert vs normal; only consulted while vimMode && !scrollbackFocus. */
  private composerVim: VimInsertMode = 'insert'
  /** Last vim delete, for `p`/`P`. */
  private yank: string | undefined
  /** When vimMode is on, Esc from composer NORMAL parks here so j/k/g/G scroll. */
  private scrollbackFocus = false
  /** Last grouping/pin signature written to prefs, so j/k does not hit disk. */
  private dashboardPrefSig = ''
  private lastEscAt = 0
  private lastTitle = ''
  private lastFrameAt = 0
  private chromeOnly = false
  private pendingImages: { mediaType: string; data: string; name: string }[] = []
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
  private readonly olderHistoryInFlight = new Set<SessionId>()
  private lastProgress = -1
  /** Host-wide and immutable for a run, so fetched once and kept. */
  private agentPresets: readonly AgentPresetEntry[] | undefined
  /** Sessions whose model selection has been asked for, so focus asks once. */
  private readonly modelFetched = new Set<SessionId>()
  private readonly subagentModes = new Map<SessionId, 'one-shot' | 'continuable'>()
  /** Last harness chosen in the modes panel; applied to newly created sessions. */
  private lastHarness: SessionHarness = 'dsh'
  /** Live overlay CLI turns, so Ctrl+C / dashboard stop can kill the child. */
  private readonly harnessTurns = new Map<SessionId, AbortController>()

  constructor(options: DeckAppOptions) {
    this.options = options
    const env = options.env ?? process.env
    this.vimMode = envFlag(env, 'DECK_VIM')
    const prefs = loadPrefs(env)
    if (prefs.lastHarness !== undefined) this.lastHarness = prefs.lastHarness
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
    this.store.subscribe((change) => this.onStoreChange(change))
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
    if (this.store.focusedId === undefined) {
      const requestedCwd = resolve(this.options.cwd)
      const currentProject = this.store.allSessions
        .filter((session) => (
          !this.store.isArchived(session.id)
          && session.origin !== 'subagent'
          && session.cwd !== undefined
          && resolve(session.cwd) === requestedCwd
        ))
        .sort((a, b) => {
          if (a.running !== b.running) return a.running ? -1 : 1
          return b.updatedAt - a.updatedAt
        })[0]
      if (currentProject === undefined) await this.createSession()
      else this.focus(currentProject.id)
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

  private onStoreChange(change: StoreChange): void {
    const kind = change.kind
    if (kind === 'approval') {
      const pending = this.store.allSessions.find((s) => s.pendingApproval !== undefined)
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
      } else this.maybeOpenQuestion()
    }
    if (kind === 'question') {
      const pending = this.store.allSessions.find((s) => s.pendingQuestion !== undefined)
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
    // Archived rows stay addressable in the store; only removed sessions
    // leak per-session caches if we do not drop them here.
    if (kind === 'sessions') this.dropStaleSessionCaches()
    this.refreshLiveOverlays()
    if (kind === 'transcript' && 'sessionId' in change && change.sessionId !== this.store.focusedId) {
      if (this.overlay?.kind === 'dashboard') {
        this.requestFrame()
        return
      }
      this.requestChromeFrame()
      return
    }
    this.requestFrame()
  }

  private dropStaleSessionCaches(): void {
    for (const id of this.sessionDrafts.keys()) {
      if (this.store.get(id) === undefined) this.sessionDrafts.delete(id)
    }
    for (const id of this.subagentModes.keys()) {
      if (this.store.get(id) === undefined) this.subagentModes.delete(id)
    }
  }

  private refreshLiveOverlays(): void {
    if (this.overlay?.kind === 'switcher' && this.overlay.live) {
      // Store-driven list: titles, unread badges and run states keep moving
      // while the palette is open. Server search results (live: false) are a
      // static snapshot and must not be clobbered.
      this.overlay = {
        ...this.overlay,
        state: updateSwitcherEntries(this.overlay.state, this.switcherEntries()),
      }
      return
    }
    if (this.overlay?.kind === 'dashboard') {
      this.overlay = {
        kind: 'dashboard',
        state: updateDashboardSessions(this.overlay.state, this.dashboardSessions()),
      }
      return
    }
    if (this.overlay?.kind === 'queue') {
      const session = this.store.get(this.overlay.sessionId)
      if (session === undefined) return
      this.overlay = {
        kind: 'queue',
        sessionId: this.overlay.sessionId,
        state: updateQueueOverlayItems(this.overlay.state, queueOverlayItems(session)),
      }
    }
  }

  /** Auto-open the question overlay for any blocked session, unless a modal is already up. */
  private maybeOpenQuestion(): void {
    if (this.overlay !== undefined) return
    if (this.pendingApprovalTarget() !== undefined) return
    const target = this.pendingQuestionTarget()
    const pending = target === undefined ? undefined : pendingQuestionsOf(target)[0]
    if (target === undefined || pending === undefined) return
    this.overlay = {
      kind: 'question',
      sessionId: target.id,
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

    // Ctrl+\ is FS (0x1c), decoded as ctrl+'|'. Toggle the dashboard even
    // when another overlay is up, matching Grok's "leave from any state".
    if (key.kind === 'ctrl' && (key.char === '|' || key.char === '\\')) {
      if (this.overlay?.kind === 'dashboard') {
        this.overlay = undefined
        this.requestFrame()
        this.maybeOpenQuestion()
        return
      }
      if (this.overlay === undefined) {
        this.openDashboard()
        return
      }
    }

    // Ctrl+C follows the macOS/fzf convention: close the current modal first.
    // Questions already own a real Host cancellation path, so route that one
    // through its reducer; the next Ctrl+C can still cancel a running turn.
    if (this.overlay !== undefined && key.kind === 'ctrl' && key.char.toLowerCase() === 'c') {
      if (this.overlay.kind === 'question') this.onOverlayKey(this.overlay, key)
      else {
        if (this.overlay.kind === 'image') this.term.clearImages()
        this.overlay = undefined
        this.requestFrame()
        this.maybeOpenQuestion()
      }
      return
    }

    // A modal overlay owns the remaining keyboard input outright.
    if (this.overlay !== undefined) {
      this.onOverlayKey(this.overlay, key)
      return
    }

    // The approval overlay grabs input: a blocked agent is the one thing worth
    // stealing the keyboard for, and it makes allow/reject a single keystroke.
    if (this.pendingApprovalTarget() !== undefined && this.answerKey(key)) return

    if (this.vimMode && this.scrollbackFocus && key.kind === 'paste') {
      this.scrollbackFocus = false
      this.composerVim = 'insert'
    }
    if (this.vimMode && !this.scrollbackFocus) {
      if (this.applyVimComposer(key)) return
    }

    if (key.kind === 'paste') {
      if (this.tryAttachImage(key.text)) return
      this.insert(key.text)
      return
    }

    if (key.kind === 'modified-enter') {
      if (key.shift && !key.alt && !key.ctrl && !key.super) this.insert('\n')
      else if (key.alt || key.ctrl || key.super) void this.send('steer')
      return
    }

    if (key.kind === 'ctrl') {
      this.onCtrl(key.char)
      return
    }

    if (key.kind === 'alt') {
      if (key.char >= '1' && key.char <= '9') {
        const target = this.sidebarSessions()[Number(key.char) - 1]
        if (target !== undefined) this.focus(target.id)
        return
      }
      if (key.char === '\r' || key.char === '\n') { void this.send('steer'); return }
      if (key.char.toLowerCase() === 'b') { this.moveWordLeft(); return }
      if (key.char.toLowerCase() === 'f') { this.moveWordRight(); return }
      return
    }

    if (key.kind === 'char') {
      if (this.showHelp) { this.showHelp = false; this.requestFrame(); return }
      if (this.vimMode && this.scrollbackFocus) {
        this.onVimScrollback(key.char)
        return
      }
      this.insert(key.char)
      return
    }

    switch (key.kind) {
      case 'enter':
        if (this.vimMode && this.scrollbackFocus) return
        void this.send('queue')
        return
      case 'tab': this.cycleFocus(1); return
      case 'backspace': this.backspace(); return
      case 'word-backspace': this.deleteWord(); return
      case 'delete': this.deleteForward(); return
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
      case 'escape': this.onEscape(); return
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
      case 'e': {
        const end = codePointLength(this.draft)
        if (this.cursor !== end) { this.cursor = end; this.draftRevision += 1 }
        this.requestFrame()
        return
      }
      case 'x': this.expandTools = !this.expandTools; this.requestFrame(); return
      case 'r': this.expandReasoning = !this.expandReasoning; this.requestFrame(); return
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

  private applyVimComposer(key: Key): boolean {
    const yank = this.yank
    const result = reduceVimComposer({
      draft: this.draft,
      cursor: this.cursor,
      mode: this.composerVim,
      ...yank === undefined ? {} : { yank },
    }, key)
    if (result.kind === 'unhandled') return false
    this.draft = result.state.draft
    this.cursor = result.state.cursor
    this.composerVim = result.state.mode
    this.yank = result.state.yank
    this.draftRevision += 1
    if (result.kind === 'park') this.scrollbackFocus = true
    this.requestFrame()
    if (result.kind === 'send') void this.send('queue')
    else if (
      result.kind === 'continue'
      && this.draft.startsWith('/')
      && !/\s/u.test(this.draft)
    ) {
      void this.maybeOpenCommandPalette()
    }
    return true
  }

  private onVimScrollback(char: string): void {
    if (char === 'i' || char === 'a' || char === 'I' || char === 'A') {
      this.scrollbackFocus = false
      this.composerVim = 'insert'
      if (char === 'I') this.cursor = 0
      else if (char === 'A') this.cursor = codePointLength(this.draft)
      else if (char === 'a') this.cursor = nextGraphemeBoundary(this.draft, this.cursor)
      this.requestFrame()
      return
    }
    if (char === 'j') { this.scroll(-1); return }
    if (char === 'k') { this.scroll(1); return }
    if (char === 'g') { this.scroll(this.lastLines.length); return }
    if (char === 'G') { this.scrollOffset = 0; this.requestFrame() }
  }

  private openSwitcher(): void {
    if (this.overlay !== undefined) return
    this.overlay = { kind: 'switcher', live: true, state: createSwitcher(this.switcherEntries(), this.store.focusedId) }
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
      ...s.harness === undefined ? {} : { harness: harnessLabel(s.harness) },
    }))
  }

  // -- modes -----------------------------------------------------------------

  /**
   * The modes panel is the one place every per-session dsh mode is switched.
   * It exists because dsh scatters them across different RPC conventions;
   * one-shot actions such as compact stay in the slash-command palette.
   */
  private async openModes(): Promise<void> {
    const focused = this.focused()
    if (focused === undefined || this.overlay !== undefined) return
    // Normally prefetched on connect; this covers a host that gained presets
    // since, and a connect where the call failed.
    if (this.agentPresets === undefined) {
      const result = await this.client.call('agentPreset.list', {})
      if (result.ok) this.agentPresets = result.value.presets
      // Awaiting above means an approval/question or another overlay may have won.
      if (!this.canOpenOverlayFor(focused.id)) return
    }
    if (!this.canOpenOverlayFor(focused.id)) return
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

    const currentHarness: SessionHarness = session.harness ?? 'dsh'
    const harnessOptions = [
      {
        value: 'dsh',
        label: 'dsh',
        detail: 'DeepSeek Harness (host API)',
        ...currentHarness === 'dsh' ? { current: true } : {},
      },
      ...this.harnessRows().map((row) => ({
        value: row.id,
        label: row.label,
        detail: row.present
          ? (row.resolvedName !== undefined && row.resolvedName !== row.id
            ? `${row.binary ?? row.resolvedName} (${row.resolvedName})`
            : (row.binary ?? 'on PATH'))
          : 'not on PATH',
        ...currentHarness === row.id ? { current: true } : {},
        ...row.present ? {} : { disabled: 'not on PATH' },
      })),
    ]

    return [
      {
        id: 'model',
        label: 'model',
        value: model === undefined
          ? 'host default'
          : `${model.provider} · ${shortModelId(model.model)}${model.effort === undefined ? '' : ` · ${model.effort}`}`,
      },
      {
        id: 'harness',
        label: 'harness',
        value: harnessLabel(currentHarness),
        optionsTitle: 'harness',
        options: harnessOptions,
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
    ]
  }

  /** Refresh the open panel from the store, so a switch shows its new value. */
  private refreshModes(): void {
    if (this.overlay?.kind !== 'modes') return
    const session = this.store.get(this.overlay.sessionId)
    if (session === undefined) return
    this.overlay = { ...this.overlay, state: updateModesRows(this.overlay.state, this.modeRows(session)) }
  }

  private harnessRows() {
    return discoverHarnesses({ env: this.options.env ?? process.env })
  }

  private chooseHarness(sessionId: SessionId, value: string): void {
    if (!isSessionHarness(value)) {
      this.notice(`unknown harness ${value}`, 'error')
      return
    }
    if (value !== 'dsh') {
      const row = this.harnessRows().find((item) => item.id === value)
      if (row === undefined || !row.present) {
        this.notice(`${value} is not on PATH`, 'error')
        return
      }
    }
    this.store.setHarness(sessionId, value === 'dsh' ? undefined : value)
    this.lastHarness = value
    savePrefs({ lastHarness: value }, this.options.env ?? process.env)
    this.notice(`harness: ${harnessLabel(value)}`, 'info')
  }

  private async chooseMode(sessionId: SessionId, row: ModeRowId, value: string): Promise<void> {
    if (row === 'harness') {
      this.chooseHarness(sessionId, value)
      return
    }
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
      this.overlay = { ...this.overlay, state: updateSwitcherEntries(this.overlay.state, this.switcherEntries()) }
    }
    if (this.overlay?.kind === 'dashboard') {
      this.overlay = {
        kind: 'dashboard',
        state: updateDashboardSessions(this.overlay.state, this.dashboardSessions()),
      }
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

    // Shift+click is reserved for the terminal's native selection where the
    // emulator withholds or still delivers the report; never start a Deck drag.
    if (key.kind === 'mouse' && key.shift) return

    if (key.kind === 'wheel') {
      if (inRect(layout.transcript, key.row, key.col) || (layout.sidebar !== undefined && inRect(layout.sidebar, key.row, key.col))) {
        this.scroll(key.direction === 'up' ? 3 : -3)
      }
      return
    }

    if (key.action === 'down' && key.button === 'left') {
      if (layout.sidebar !== undefined && inRect(layout.sidebar, key.row, key.col)) {
        const hit = sidebarHitTest(this.sidebarSessions(), this.store.focusedId, layout.sidebar, key.row)
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
   * (works across SSH where the local clipboard binary does not exist).
   */
  private copyText(text: string): void {
    const argv = clipboardArgv()
    if (argv !== undefined) {
      try {
        const child = spawn(argv[0] ?? 'true', argv.slice(1), { stdio: ['pipe', 'ignore', 'ignore'] })
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
          break
        case 'cancelled':
          this.overlay = undefined
          break
      }
      this.requestFrame()
      if (this.overlay === undefined) this.maybeOpenQuestion()
      return
    }
    if (overlay.kind === 'switcher') {
      const result = reduceSwitcher(overlay.state, key)
      switch (result.kind) {
        case 'continue': this.overlay = { ...overlay, state: result.state }; break
        case 'focus': this.overlay = undefined; this.focus(result.id); break
        case 'archive': this.overlay = { ...overlay, state: result.state }; void this.archiveSession(result.id); break
        case 'rename': this.overlay = undefined; void this.renameSession(result.id, result.title); break
        case 'create': this.overlay = undefined; void this.createSession(); break
        case 'cancelled': this.overlay = undefined; break
      }
      this.requestFrame()
      if (this.overlay === undefined) this.maybeOpenQuestion()
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
      if (this.overlay === undefined) this.maybeOpenQuestion()
      return
    }
    if (overlay.kind === 'info') {
      if (
        overlay.state.title === 'doctor'
        && key.kind === 'char'
        && key.char.toLowerCase() === 'f'
      ) {
        this.applyDoctorFix()
        return
      }
      if (key.kind === 'up' || key.kind === 'down' || key.kind === 'pageup' || key.kind === 'pagedown') {
        const delta = key.kind === 'up' ? -1 : key.kind === 'down' ? 1 : key.kind === 'pageup' ? -8 : 8
        this.overlay = {
          ...overlay,
          state: { ...overlay.state, offset: Math.max(0, (overlay.state.offset ?? 0) + delta) },
        }
        this.requestFrame()
        return
      }
      if (
        key.kind === 'escape'
        || key.kind === 'enter'
        || (key.kind === 'char' && key.char.toLowerCase() === 'q')
      ) {
        this.overlay = undefined
        this.requestFrame()
        this.maybeOpenQuestion()
      }
      return
    }
    if (overlay.kind === 'rewind') {
      const result = reduceRewindOverlay(overlay.state, key)
      if (result.kind === 'continue') {
        this.overlay = { ...overlay, state: result.state }
      } else if (result.kind === 'picked') {
        this.overlay = undefined
        void this.fork(result.seq)
      } else {
        this.overlay = undefined
      }
      this.requestFrame()
      if (this.overlay === undefined) this.maybeOpenQuestion()
      return
    }
    if (overlay.kind === 'queue') {
      const result = reduceQueueOverlay(overlay.state, key)
      switch (result.kind) {
        case 'continue':
          this.overlay = { ...overlay, state: result.state }
          break
        case 'cancelled':
          this.overlay = undefined
          break
        case 'remove':
          this.overlay = { ...overlay, state: result.state }
          void this.updateQueuedMessage(result.id, 'remove')
          break
        case 'steer':
          this.overlay = { ...overlay, state: result.state }
          void this.updateQueuedMessage(result.id, 'steer')
          break
        case 'edit':
          this.overlay = { ...overlay, state: result.state }
          void this.editQueuedMessage(result.id, result.text)
          break
      }
      this.requestFrame()
      if (this.overlay === undefined) this.maybeOpenQuestion()
      return
    }
    if (overlay.kind === 'dashboard') {
      const result = reduceDashboard(overlay.state, key)
      switch (result.kind) {
        case 'continue':
          this.overlay = { kind: 'dashboard', state: result.state }
          this.persistDashboardPrefs(result.state)
          this.maybeLoadDashboardPeek(result.state)
          break
        case 'cancelled':
          this.overlay = undefined
          break
        case 'attach':
          this.overlay = undefined
          this.focus(result.id)
          break
        case 'reply':
          this.overlay = result.attach
            ? undefined
            : { kind: 'dashboard', state: { ...overlay.state, draft: '' } }
          void this.dashboardReply(result.id, result.text, result.attach)
          break
        case 'dispatch':
          this.overlay = result.attach
            ? undefined
            : { kind: 'dashboard', state: { ...overlay.state, draft: '' } }
          void this.dashboardDispatch(result.text, result.attach)
          break
        case 'rename':
          this.overlay = { kind: 'dashboard', state: result.state }
          this.persistDashboardPrefs(result.state)
          void this.renameSession(result.id, result.title)
          break
        case 'cancel':
          this.overlay = { kind: 'dashboard', state: result.state }
          void this.cancelSession(result.id)
          break
        case 'archive':
          this.overlay = { kind: 'dashboard', state: result.state }
          this.persistDashboardPrefs(result.state)
          void this.archiveSession(result.id)
          break
      }
      this.requestFrame()
      if (this.overlay === undefined) this.maybeOpenQuestion()
      return
    }
    // image viewer
    if (key.kind === 'escape' || (key.kind === 'char' && key.char.toLowerCase() === 'q')) {
      this.term.clearImages()
      this.overlay = undefined
      this.requestFrame()
      this.maybeOpenQuestion()
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
    if (!this.canOpenOverlayFor(focused.id)) return
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
    const commandPromise = this.client.call('commands/list', { args: { agentId: focused.id } })
    const skillPromise = focused.origin === 'subagent'
      ? Promise.resolve(undefined)
      : this.client.call('skill.list', { sessionId: focused.id })
    const [result, skills] = await Promise.all([
      commandPromise,
      skillPromise,
    ])
    this.slashOpenInFlight = false
    if (!this.canOpenOverlayFor(focused.id)) return
    if (!this.draft.startsWith('/') || /\s/u.test(this.draft)) return
    const filter = this.draft.slice(1)
    const hostCommands = result.ok ? result.value : []
    const skillCommands: SlashCommandEntry[] = skills !== undefined && skills.ok
      ? skills.value.skills
        .map((skill) => ({
          name: skill.name,
          description: skill.modelInvocable ? skill.description : `user-only · ${skill.description}`,
          skill: true,
        }))
      : []
    if (!result.ok) this.notice(`host commands unavailable: ${result.error.message}`, 'warn')
    this.replaceDraft('')
    this.overlay = {
      kind: 'commands',
      sessionId: focused.id,
      state: createCommandPalette(mergeCommandCatalog(DECK_COMMANDS, hostCommands, skillCommands), filter),
    }
    this.requestFrame()
  }

  private runSlashEntry(sessionId: SessionId, command: SlashCommandEntry): void {
    if (command.skill === true) {
      void this.invokeSkill(sessionId, normalizedCommandName(command.name))
      return
    }
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

  private async invokeSkill(sessionId: SessionId, name: string): Promise<void> {
    if (this.store.get(sessionId)?.origin === 'subagent') {
      this.notice('skills are available on primary sessions only', 'warn')
      return
    }
    const result = await this.client.call('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: `/${name}` }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    if (!result.ok) this.notice(`skill /${name}: ${result.error.message}`, 'error')
    else this.notice(`skill queued: /${name}`, 'info')
  }

  private runDeckCommand(action: DeckCommandAction, input = ''): void {
    switch (action) {
      case 'model': void this.openPicker(); return
      case 'modes': void this.openModes(); return
      case 'harness': void this.openModes(); return
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
      case 'rewind': this.openRewind(); return
      case 'cancel': void this.cancel(); return
      case 'status': this.openStatus(); return
      case 'cost': this.openCost(); return
      case 'skills': void this.openSkills(); return
      case 'agents': void this.openAgents(); return
      case 'workspaces': void this.openWorkspaces(); return
      case 'search': void this.openSessionSearch(input); return
      case 'interrupt-agent': void this.interruptSubagent(input); return
      case 'queue': this.openQueue(); return
      case 'remove-queued': void this.updateQueuedMessage(input, 'remove'); return
      case 'steer-queued': void this.updateQueuedMessage(input, 'steer'); return
      case 'dashboard': this.openDashboard(); return
      case 'doctor':
        if (input.trim().toLowerCase() === 'fix') this.applyDoctorFix()
        else this.openDoctor()
        return
      case 'vim': this.toggleVim(); return
      case 'help': this.showHelp = true; this.requestFrame(); return
      case 'quit': void this.quit(); return
    }
  }

  private openInfo(title: string, lines: readonly string[], footer?: string): void {
    if (this.overlay !== undefined && this.overlay.kind !== 'info') return
    if (this.overlay === undefined) {
      if (this.pendingApprovalTarget() !== undefined) return
      if (this.focused()?.pendingQuestion !== undefined) return
    }
    const state: InfoOverlayState = {
      title,
      lines: lines.length > 0 ? lines : ['Nothing to show.'],
      offset: 0,
      ...footer === undefined ? {} : { footer },
    }
    this.overlay = { kind: 'info', state }
    this.requestFrame()
  }

  private canOpenOverlayFor(sessionId: SessionId): boolean {
    if (this.overlay !== undefined || this.store.focusedId !== sessionId) return false
    if (this.pendingApprovalTarget() !== undefined) return false
    return this.store.get(sessionId)?.pendingQuestion === undefined
  }

  private openStatus(): void {
    const session = this.focused()
    if (session === undefined) return
    const model = session.modes.model
    const permission = session.modes.permissions?.currentValue ?? 'unknown'
    const plan = session.modes.plan
    this.openInfo('status', [
      `Project: ${this.projectOf(session)}`,
      `Session: ${this.titleOf(session)} (${session.id})`,
      `Harness: ${session.harness === undefined ? 'dsh' : harnessLabel(session.harness)}`,
      `State: ${session.running ? 'running' : 'idle'} · queued ${String(session.queue.length)} · unread ${String(session.unread)}`,
      `Model: ${model === undefined ? 'host default' : `${model.provider}/${model.model}${model.effort === undefined ? '' : ` · ${model.effort}`}`}`,
      `Preset: ${session.modes.agentPreset ?? 'default'}`,
      `Permission: ${permission}`,
      `Plan: ${plan === undefined ? 'unknown' : plan.pending ? 'pending' : plan.active ? 'on' : 'off'}`,
    ])
  }

  private openCost(): void {
    const session = this.focused()
    if (session === undefined) return
    const usage = session.transcript.usage
    const breakdown = session.telemetry.breakdown
    const window = session.telemetry.contextWindow
    const used = breakdown === undefined
      ? undefined
      : breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
    const pct = used === undefined || window === undefined || window <= 0
      ? 'unknown'
      : `${String(Math.round((used / window) * 100))}% (${String(used)} / ${String(window)})`
    this.openInfo('tokens & context', [
      `Context: ${pct}`,
      `Input: ${String(usage.inputTokens ?? 0)}`,
      `Output: ${String(usage.outputTokens ?? 0)}`,
      `Reasoning: ${String(usage.reasoningTokens ?? 0)}`,
      `Cache read: ${String(usage.cacheReadTokens ?? 0)}`,
      `Cache write: ${String(usage.cacheWriteTokens ?? 0)}`,
      ...(breakdown === undefined ? [] : [
        `Loaded context: system ${String(breakdown.systemTokens)} · tools ${String(breakdown.toolsTokens)} · messages ${String(breakdown.messageTokens)}`,
      ]),
      'Deck reports token usage only; provider billing remains authoritative.',
    ])
  }

  private async openSkills(): Promise<void> {
    const session = this.focused()
    if (session === undefined) return
    if (session.origin === 'subagent') {
      this.notice('skills are available on primary sessions only', 'warn')
      return
    }
    const result = await this.client.call('skill.list', { sessionId: session.id })
    if (!result.ok) { this.notice(`skills unavailable: ${result.error.message}`, 'warn'); return }
    if (!this.canOpenOverlayFor(session.id)) return
    this.openInfo('skills', result.value.skills.map((skill) => (
      `/${skill.name}${skill.modelInvocable ? '' : ' (user-only)'} — ${skill.description}`
    )))
  }

  private async openAgents(): Promise<void> {
    const session = this.focused()
    if (session === undefined) return
    const result = await this.client.call('subagent.list', { parentSessionId: session.id })
    if (!result.ok) { this.notice(`subagents unavailable: ${result.error.message}`, 'warn'); return }
    if (!this.canOpenOverlayFor(session.id)) return
    this.openInfo('subagents', result.value.entries.map((entry) => entry.kind === 'diagnostic'
      ? `${entry.id.slice(0, 8)} · ${entry.reason}`
      : `${entry.activity === 'running' ? '●' : '○'} ${entry.label ?? entry.id.slice(0, 8)} · ${entry.mode} · ${entry.id}`))
  }

  private async interruptSubagent(input: string): Promise<void> {
    const session = this.focused()
    if (session === undefined) return
    if (input.trim().length === 0) { this.notice('usage: /interrupt-agent <id-or-prefix>', 'warn'); return }
    const listed = await this.client.call('subagent.list', { parentSessionId: session.id })
    if (!listed.ok) { this.notice(`subagents unavailable: ${listed.error.message}`, 'warn'); return }
    const query = input.trim()
    const child = listed.value.entries.find((entry) => entry.kind === 'child'
      && entry.mode === 'continuable'
      && (entry.id === query || entry.id.startsWith(query) || entry.label === query))
    if (child === undefined || child.kind !== 'child' || child.mode !== 'continuable') {
      this.notice(`no continuable subagent matches “${query}”`, 'warn')
      return
    }
    const result = await this.client.call('subagent.interrupt', {
      parentSessionId: session.id,
      childSessionId: child.id,
      mode: 'continuable',
    })
    if (!result.ok) this.notice(`subagent interrupt failed: ${result.error.message}`, 'error')
    else this.notice(`interrupt requested: ${child.label ?? child.id.slice(0, 8)}`, 'info')
  }

  private async openWorkspaces(): Promise<void> {
    const sessionId = this.store.focusedId
    if (sessionId === undefined) return
    const result = await this.client.call('workspace.list', {})
    if (!result.ok) { this.notice(`workspaces unavailable: ${result.error.message}`, 'warn'); return }
    if (!this.canOpenOverlayFor(sessionId)) return
    this.openInfo('workspaces', result.value.items.map((workspace) => (
      `${workspace.title} · ${workspace.path} · ${String(workspace.sessionIds.length)} sessions`
    )))
  }

  private async openSessionSearch(input: string): Promise<void> {
    const query = input.trim()
    if (query.length === 0) { this.notice('usage: /search <query>', 'warn'); return }
    const result = await this.client.call('session.search', { query })
    const focused = this.focused()
    if (focused === undefined || !this.canOpenOverlayFor(focused.id)) return
    if (!result.ok) {
      const state = createSwitcher(this.switcherEntries(), this.store.focusedId)
      this.overlay = { kind: 'switcher', live: true, state: { ...state, filter: query, cursor: 0 } }
      this.notice(`server search unavailable; filtering titles locally`, 'warn')
      this.requestFrame()
      return
    }
    const entries: SwitcherEntry[] = result.value.items.flatMap((item) => {
      const session = this.store.get(item.sessionId)
      if (session === undefined) return []
      return [{
        id: session.id,
        title: `${this.titleOf(session)} · ${item.snippet}`,
        ...session.cwd === undefined ? {} : { cwd: session.cwd },
        running: session.running,
        unread: session.unread,
        blocked: session.pendingApproval !== undefined || session.pendingQuestion !== undefined,
        updatedAt: session.updatedAt,
      }]
    })
    this.overlay = { kind: 'switcher', live: false, state: createSwitcher(entries, this.store.focusedId) }
    if (result.value.hasMore) this.notice('showing the first 20 search results', 'info')
    this.requestFrame()
  }

  private openQueue(): void {
    const session = this.focused()
    if (session === undefined || this.overlay !== undefined) return
    this.overlay = { kind: 'queue', sessionId: session.id, state: createQueueOverlay(queueOverlayItems(session)) }
    this.requestFrame()
  }

  private openDashboard(): void {
    if (this.overlay !== undefined) return
    this.scrollbackFocus = false
    const prefs = loadPrefs(this.options.env ?? process.env).dashboard
    const options = {
      ...prefs?.grouping !== undefined ? { grouping: prefs.grouping } : {},
      ...prefs?.pinned !== undefined ? { pinned: prefs.pinned } : {},
      ...prefs?.pinOrder !== undefined ? { pinOrder: prefs.pinOrder } : {},
    }
    const state = createDashboard(this.dashboardSessions(), this.store.focusedId, options)
    this.dashboardPrefSig = dashboardPrefSignature(state)
    this.overlay = { kind: 'dashboard', state }
    this.maybeLoadDashboardPeek(state)
    this.requestFrame()
  }

  private persistDashboardPrefs(state: DashboardState): void {
    const sig = dashboardPrefSignature(state)
    if (sig === this.dashboardPrefSig) return
    this.dashboardPrefSig = sig
    savePrefs({
      dashboard: {
        grouping: state.grouping,
        pinned: [...state.pinned],
        pinOrder: [...state.pinOrder],
      },
    }, this.options.env ?? process.env)
  }

  private doctorInput(): DoctorInput {
    const env = { ...(this.options.env ?? process.env) }
    if (this.vimMode) env.DECK_VIM = '1'
    else delete env.DECK_VIM
    const native = clipboardArgv()?.[0]
    return {
      caps: this.caps,
      ...this.host === undefined ? {} : { host: this.host },
      env,
      mouseEnabled: this.mouseEnabled,
      nodeVersion: process.version,
      platform: process.platform,
      isTTY: process.stdin.isTTY === true,
      cwd: this.options.cwd,
      ...native === undefined ? { clipboardRoute: 'osc52' } : { clipboardRoute: native },
    }
  }

  private openDoctor(): void {
    this.openInfo('doctor', doctorLines(doctorFindings(this.doctorInput())), DOCTOR_FOOTER)
  }

  private applyDoctorFix(): void {
    const before = this.caps
    const hadUnicode = before.unicodeCore
    const hadTrueColor = before.trueColor
    const result = doctorFix(this.doctorInput())
    before.trueColor = result.caps.trueColor
    before.hyperlinks = result.caps.hyperlinks
    before.kittyGraphics = result.caps.kittyGraphics
    before.notifications = result.caps.notifications
    before.progress = result.caps.progress
    before.clipboard = result.caps.clipboard
    before.syncOutput = result.caps.syncOutput
    before.unicodeCore = result.caps.unicodeCore
    if (!hadUnicode && result.caps.unicodeCore) this.screen.enableUnicodeCore()
    if (hadTrueColor !== result.caps.trueColor) {
      this.theme = createTheme(this.caps, this.options.env ?? process.env)
    }
    if (result.mouseEnabled !== this.mouseEnabled) {
      this.mouseEnabled = result.mouseEnabled
      this.screen.setMouse(result.mouseEnabled)
    }
    if (result.snippet.length > 0) this.copyText(result.snippet)
    this.openInfo('doctor', doctorFixLines(result), DOCTOR_FOOTER)
    const applied = result.applied.filter((item) => item.applied).length
    this.notice(
      applied > 0
        ? `doctor fix: ${String(applied)} repair${applied === 1 ? '' : 's'}`
        : 'doctor fix: nothing to repair in-process',
      applied > 0 ? 'info' : 'warn',
    )
  }

  private toggleVim(): void {
    this.vimMode = !this.vimMode
    if (!this.vimMode) this.scrollbackFocus = false
    else this.composerVim = 'insert'
    this.notice(
      this.vimMode
        ? 'vim mode on — Esc is NORMAL, Esc again parks the transcript, i returns'
        : 'vim mode off',
      'info',
    )
    this.requestFrame()
  }

  private dashboardSessions(): DashboardSession[] {
    return this.store.sessions.map((session) => {
      const model = session.modes.model
      const tool = session.pendingApproval?.toolName
      const lastError = session.lastError
      return {
        id: session.id,
        title: this.titleOf(session),
        ...session.cwd === undefined ? {} : { cwd: session.cwd },
        running: session.running,
        unread: session.unread,
        blocked: session.pendingApproval !== undefined || session.pendingQuestion !== undefined,
        ...lastError === undefined || lastError.length === 0 ? {} : { lastError },
        updatedAt: session.updatedAt,
        ...model === undefined ? {} : { model: `${model.provider}/${model.model}` },
        items: session.transcript.items,
        ...tool === undefined ? {} : { pendingTool: tool },
        ...session.harness === undefined ? {} : { harness: harnessLabel(session.harness) },
      }
    })
  }

  private maybeLoadDashboardPeek(state: DashboardState): void {
    const row = visibleDashboardRows(state)[state.cursor]
    if (row === undefined || row.kind !== 'session') return
    const live = this.store.get(row.session.id)
    if (live !== undefined && !live.historyLoaded) void this.loadHistory(row.session.id)
  }

  private async dashboardReply(sessionId: SessionId, text: string, attach: boolean): Promise<void> {
    const ok = await this.promptSession(sessionId, text, 'queue')
    if (attach) this.focus(sessionId)
    else if (ok) this.notice('queued on selected session', 'info')
    if (this.overlay?.kind === 'dashboard') {
      this.overlay = {
        kind: 'dashboard',
        state: updateDashboardSessions(this.overlay.state, this.dashboardSessions()),
      }
      this.requestFrame()
    }
  }

  private async dashboardDispatch(text: string, attach: boolean): Promise<void> {
    const id = await this.createSession({ focus: attach })
    if (id === undefined) return
    await this.promptSession(id, text, 'queue')
    if (this.overlay?.kind === 'dashboard') {
      this.overlay = {
        kind: 'dashboard',
        state: updateDashboardSessions(
          { ...this.overlay.state, cursor: 0, draft: '' },
          this.dashboardSessions(),
        ),
      }
      this.requestFrame()
    }
  }

  private async promptSession(sessionId: SessionId, text: string, mode: 'queue' | 'steer'): Promise<boolean> {
    const session = this.store.get(sessionId)
    if (session === undefined) return false
    if (session.harness !== undefined) return this.promptHarness(session, text)
    const childMode = await this.subagentMode(session)
    if (session.origin === 'subagent' && childMode !== 'continuable') {
      this.notice('one-shot subagents are read-only after completion', 'warn')
      return false
    }
    const content = [{ type: 'text' as const, text }]
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const result = session.origin === 'subagent' && session.parentSessionId !== undefined
      ? await this.client.call('subagent.prompt', {
        parentSessionId: session.parentSessionId,
        childSessionId: session.id,
        mode: 'continuable',
        content,
        clientTimeZone: tz,
      })
      : await this.client.call('session.prompt', {
        sessionId,
        mode,
        content,
        clientTimeZone: tz,
      })
    if (!result.ok) {
      this.notice(result.error.message, 'error')
      return false
    }
    return true
  }

  private async promptHarness(session: SessionState, text: string): Promise<boolean> {
    const harness = session.harness
    if (harness === undefined) return false
    const env = this.options.env ?? process.env
    const row = this.harnessRows().find((item) => item.id === harness)
    if (row === undefined || !row.present || row.binary === undefined) {
      this.notice(`${harnessLabel(harness)} is not on PATH`, 'error')
      return false
    }
    if (session.modes.model === undefined) await this.loadModelSelection(session.id)
    const model = this.store.get(session.id)?.modes.model
    if (model === undefined) {
      this.notice('select a dsh model first (ctrl+s / ctrl+p) — Deck will pass it to the harness', 'warn')
      return false
    }
    const selection = {
      provider: model.provider,
      model: model.model,
      ...model.effort === undefined ? {} : { effort: model.effort },
    }
    const plan = buildHarnessOverlay({
      harness,
      binary: row.binary,
      selection,
      overlayHome: overlayHomeFor(env, harness, session.id),
      env,
      cwd: session.cwd ?? this.options.cwd,
      prompt: text,
    })
    const ac = new AbortController()
    this.harnessTurns.set(session.id, ac)
    this.store.setRunning(session.id, true)
    this.notice(`${harnessLabel(harness)} · ${model.provider}/${shortModelId(model.model)}`, 'info')
    try {
      const run = this.options.runHarnessTurn ?? (
        (overlay: OverlayPlan, signal?: AbortSignal) => (
          signal === undefined
            ? spawnHarnessTurn(overlay)
            : spawnHarnessTurn(overlay, { signal })
        )
      )
      const result = await run(plan, ac.signal)
      if (result.aborted === true || ac.signal.aborted) {
        this.store.setRunning(session.id, false)
        return false
      }
      if (result.code !== 0) {
        const err = result.stderr.trim() || result.stdout.trim() || `${harnessLabel(harness)} exited ${String(result.code)}`
        this.store.appendHarnessTurn(session.id, { user: text, error: err })
        this.notice(err, 'error')
        return false
      }
      const assistant = harnessAssistantText(harness, result.stdout)
      this.store.appendHarnessTurn(session.id, {
        user: text,
        assistant: assistant.length > 0 ? assistant : '(empty)',
      })
      return true
    } catch (error) {
      if (ac.signal.aborted) {
        this.store.setRunning(session.id, false)
        return false
      }
      const message = error instanceof Error ? error.message : String(error)
      this.store.appendHarnessTurn(session.id, { user: text, error: message })
      this.notice(message, 'error')
      return false
    } finally {
      this.harnessTurns.delete(session.id)
    }
  }

  private async editQueuedMessage(itemId: string, text: string): Promise<void> {
    const session = this.focused()
    if (session === undefined) return
    const result = await this.client.call('session.updateQueue', {
      sessionId: session.id,
      itemId,
      action: { kind: 'edit', content: [{ type: 'text', text }] },
    })
    if (!result.ok) this.notice(`queue update failed: ${result.error.message}`, 'error')
    else this.notice('pending message updated', 'info')
  }

  private async updateQueuedMessage(input: string, kind: 'remove' | 'steer'): Promise<void> {
    const session = this.focused()
    if (session === undefined) return
    const query = input.trim()
    if (query.length === 0) {
      this.notice(`usage: /${kind === 'remove' ? 'dequeue' : 'steer-queued'} <id-or-prefix>`, 'warn')
      return
    }
    const item = session.queue.find((candidate) => candidate.placement !== 'context'
      && (candidate.id === query || candidate.id.startsWith(query)))
    if (item === undefined) { this.notice(`no pending message matches “${query}”`, 'warn'); return }
    const result = await this.client.call('session.updateQueue', {
      sessionId: session.id,
      itemId: item.id,
      action: { kind },
    })
    if (!result.ok) this.notice(`queue update failed: ${result.error.message}`, 'error')
    else this.notice(kind === 'remove' ? 'pending message removed' : 'message promoted to steering', 'info')
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
    if (!this.canOpenOverlayFor(focused.id)) return
    const data = Uint8Array.from(Buffer.from(result.value.data, 'base64'))
    this.overlay = { kind: 'image', alt: image.alt, data, transmitted: false }
    this.requestFrame()
  }

  /** Returns the session whose approval should be answered, preferring the focused one. */
  private pendingApprovalTarget(): SessionState | undefined {
    const focused = this.focused()
    if (focused?.pendingApproval !== undefined) return focused
    return this.store.allSessions.find((s) => pendingApprovalsOf(s).length > 0)
  }

  private pendingQuestionTarget(): SessionState | undefined {
    const focused = this.focused()
    if (focused !== undefined && pendingQuestionsOf(focused).length > 0) return focused
    return this.store.allSessions.find((s) => pendingQuestionsOf(s).length > 0)
  }

  private onEscape(): void {
    if (this.showHelp) {
      this.showHelp = false
      this.requestFrame()
      return
    }
    const now = Date.now()
    const double = now - this.lastEscAt <= ESC_REWIND_MS
    this.lastEscAt = now
    if (this.vimMode && this.scrollbackFocus) {
      if (double && this.draft.length === 0 && this.overlay === undefined) this.openRewind()
      return
    }
    if (this.vimMode && this.draft.length === 0 && this.overlay === undefined) {
      if (double) {
        this.openRewind()
        return
      }
      this.scrollbackFocus = true
      this.requestFrame()
      return
    }
    if (double && this.draft.length === 0 && this.overlay === undefined) {
      this.openRewind()
      return
    }
    this.requestFrame()
  }

  private openRewind(): void {
    const focused = this.focused()
    if (focused === undefined || this.overlay !== undefined) return
    const turns = rewindTurns(focused.transcript.items)
    if (turns.length === 0) {
      this.notice('nothing to rewind', 'warn')
      return
    }
    this.overlay = { kind: 'rewind', sessionId: focused.id, state: createRewindOverlay(turns) }
    this.requestFrame()
  }

  private tryAttachImage(raw: string): boolean {
    const trimmed = raw.trim()
    if (trimmed.length === 0 || /[\r\n]/.test(trimmed) || !IMAGE_PATH.test(trimmed)) return false
    try {
      const data = readFileSync(trimmed)
      if (data.byteLength === 0 || data.byteLength > 8 * 1024 * 1024) return false
      const name = trimmed.split(/[\\/]/).pop() ?? 'image'
      const mediaType = mediaTypeOf(trimmed)
      this.pendingImages.push({ mediaType, data: data.toString('base64'), name })
      this.notice(`attached ${name}`, 'info')
      return true
    } catch {
      return false
    }
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

  private moveWordLeft(): void {
    let i = graphemeBoundaryAtOrBefore(this.draft, this.cursor)
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
    if (i !== this.cursor) { this.cursor = i; this.draftRevision += 1 }
    this.requestFrame()
  }

  private moveWordRight(): void {
    let i = graphemeBoundaryAtOrBefore(this.draft, this.cursor)
    const end = codePointLength(this.draft)
    while (i < end) {
      const next = nextGraphemeBoundary(this.draft, i)
      if (codePointSlice(this.draft, i, next) === ' ') break
      i = next
    }
    while (i < end) {
      const next = nextGraphemeBoundary(this.draft, i)
      if (codePointSlice(this.draft, i, next) !== ' ') break
      i = next
    }
    if (i !== this.cursor) { this.cursor = i; this.draftRevision += 1 }
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

  private deleteForward(): void {
    const next = nextGraphemeBoundary(this.draft, this.cursor)
    if (next === this.cursor) return
    const chars = [...this.draft]
    chars.splice(this.cursor, next - this.cursor)
    this.draft = chars.join('')
    this.draftRevision += 1
    this.requestFrame()
  }

  private scroll(lines: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset + lines)
    if (lines > 0) {
      const focused = this.focused()
      const maxScroll = Math.max(0, this.lastLines.length - this.visibleTranscriptRows())
      if (focused?.hasMoreHistory === true && this.scrollOffset >= maxScroll) {
        void this.loadOlderHistory(focused.id)
      }
    }
    this.requestFrame()
  }

  private cycleFocus(direction: number): void {
    const list = this.sidebarSessions()
    if (list.length === 0) return
    const index = list.findIndex((s) => s.id === this.store.focusedId)
    const next = list[(index + direction + list.length) % list.length]
    if (next !== undefined) this.focus(next.id)
  }

  // -- actions -------------------------------------------------------------

  private focus(id: SessionId): void {
    const previousId = this.store.focusedId
    if (previousId !== undefined && previousId !== id) {
      this.sessionDrafts.set(previousId, {
        draft: this.draft,
        cursor: this.cursor,
        revision: this.draftRevision,
      })
    }
    this.store.focus(id)
    if (previousId !== id) {
      const saved = this.sessionDrafts.get(id)
      this.draft = saved?.draft ?? ''
      this.cursor = saved?.cursor ?? 0
      this.draftRevision = saved?.revision ?? 0
    }
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
    if (this.store.get(id)?.origin === 'subagent') return
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
    const childMode = await this.subagentMode(session)
    if (session.origin === 'subagent' && (session.parentSessionId === undefined || childMode === undefined)) {
      this.historyInFlight.delete(id)
      this.notice('subagent history is unavailable from this parent', 'warn')
      return
    }
    const result = session.origin === 'subagent' && session.parentSessionId !== undefined && childMode !== undefined
      ? await this.client.call('subagent.history', {
        parentSessionId: session.parentSessionId,
        childSessionId: session.id,
        mode: childMode,
        maxMessages: 80,
      })
      : await this.client.call('session.history', { sessionId: id, maxMessages: 80 })
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

  private async loadOlderHistory(id: SessionId): Promise<void> {
    const session = this.store.get(id)
    if (session === undefined || !session.hasMoreHistory || this.olderHistoryInFlight.has(id)) return
    const beforeSeq = session.transcript.items.reduce<number | undefined>((min, item) => {
      const seq = 'seq' in item && typeof item.seq === 'number' ? item.seq : undefined
      if (seq === undefined) return min
      return min === undefined ? seq : Math.min(min, seq)
    }, undefined)
    if (beforeSeq === undefined || beforeSeq <= 0) return
    this.olderHistoryInFlight.add(id)
    const childMode = await this.subagentMode(session)
    if (session.origin === 'subagent' && (session.parentSessionId === undefined || childMode === undefined)) {
      this.olderHistoryInFlight.delete(id)
      return
    }
    const result = session.origin === 'subagent' && session.parentSessionId !== undefined && childMode !== undefined
      ? await this.client.call('subagent.history', {
        parentSessionId: session.parentSessionId,
        childSessionId: session.id,
        mode: childMode,
        beforeSeq,
        maxMessages: 80,
      })
      : await this.client.call('session.history', { sessionId: id, beforeSeq, maxMessages: 80 })
    this.olderHistoryInFlight.delete(id)
    if (!result.ok) { this.notice(`older history failed: ${result.error.message}`, 'error'); return }
    this.store.applyHistoryPage(id, result.value.events, result.value.hasMore)
    this.notice(result.value.hasMore ? 'loaded older history' : 'loaded the beginning of the session', 'info')
    this.requestFrame()
  }

  private async createSession(options?: { focus?: boolean }): Promise<SessionId | undefined> {
    const result = await this.client.call('session.create', { cwd: this.options.cwd })
    if (!result.ok) {
      this.notice(`could not create a session: ${result.error.message}`, 'error')
      return undefined
    }
    // Make the new conversation current immediately. The Host status/list
    // frame follows asynchronously; waiting for it leaves the old transcript
    // selected after the user explicitly asked for a new one.
    this.store.applySessionList([{
      sessionId: result.value.sessionId,
      cwd: this.options.cwd,
      updatedAt: Date.now(),
      running: false,
      blank: false,
    }])
    if (this.lastHarness !== 'dsh' && isHarnessId(this.lastHarness)) {
      const available = this.harnessRows().some((row) => row.id === this.lastHarness && row.present)
      if (available) this.store.setHarness(result.value.sessionId, this.lastHarness)
    }
    if (options?.focus !== false) this.focus(result.value.sessionId)
    this.notice(
      this.lastHarness === 'dsh'
        ? 'new session'
        : `new session · ${harnessLabel(this.lastHarness)}`,
      'info',
    )
    return result.value.sessionId
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
      if (!accepted && this.store.focusedId === focused.id && this.draftRevision === clearedRevision) {
        this.draft = originalDraft
        this.cursor = originalCursor
        this.draftRevision += 1
        this.requestFrame()
      } else if (!accepted && this.store.focusedId !== focused.id) {
        const saved = this.sessionDrafts.get(focused.id)
        if (saved?.revision === clearedRevision) {
          this.sessionDrafts.set(focused.id, {
            draft: originalDraft,
            cursor: originalCursor,
            revision: clearedRevision + 1,
          })
        }
      }
      return
    }
    this.sendMode = mode
    if (focused.harness !== undefined) {
      const ok = await this.promptHarness(focused, text)
      if (!ok && this.store.focusedId === focused.id && this.draftRevision === clearedRevision) {
        this.draft = originalDraft
        this.cursor = originalCursor
        this.draftRevision += 1
        this.requestFrame()
      }
      return
    }
    const childMode = await this.subagentMode(focused)
    if (focused.origin === 'subagent' && childMode !== 'continuable') {
      this.draft = originalDraft
      this.cursor = originalCursor
      this.draftRevision += 1
      this.notice('one-shot subagents are read-only after completion', 'warn')
      this.requestFrame()
      return
    }
    const images = this.pendingImages
    this.pendingImages = []
    const content = [
      ...images.map((image) => ({
        type: 'image' as const,
        mediaType: image.mediaType,
        data: image.data,
        name: image.name,
      })),
      { type: 'text' as const, text },
    ]
    const result = focused.origin === 'subagent' && focused.parentSessionId !== undefined
      ? await this.client.call('subagent.prompt', {
        parentSessionId: focused.parentSessionId,
        childSessionId: focused.id,
        mode: 'continuable',
        content,
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
      : await this.client.call('session.prompt', {
        sessionId: focused.id,
        mode,
        content,
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
    if (!result.ok) {
      // Keep the optimistic clear, but make a failed prompt retryable when the
      // user has not edited the composer while the RPC was in flight. A newer
      // draft/caret wins and must never be overwritten by this recovery.
      if (this.store.focusedId === focused.id && this.draftRevision === clearedRevision) {
        this.draft = originalDraft
        this.cursor = originalCursor
        this.draftRevision += 1
        this.requestFrame()
      } else if (this.store.focusedId !== focused.id) {
        const saved = this.sessionDrafts.get(focused.id)
        if (saved?.revision === clearedRevision) {
          this.sessionDrafts.set(focused.id, {
            draft: originalDraft,
            cursor: originalCursor,
            revision: clearedRevision + 1,
          })
        }
      }
      // A leading '/' is a slash command upstream; surface its own error text.
      this.notice(result.error.message, 'error')
      return
    }
    if ('command' in result.value) {
      const command = result.value.command
      if (command !== undefined && command.text !== undefined) this.notice(command.text, 'info')
    }
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
    if (focused === undefined) {
      this.notice('no running turn to interrupt', 'info')
      return
    }
    await this.cancelSession(focused.id)
  }

  private async cancelSession(sessionId: SessionId): Promise<void> {
    const session = this.store.get(sessionId)
    if (session === undefined || !session.running) {
      this.notice('no running turn to interrupt', 'info')
      return
    }
    if (session.harness !== undefined) {
      const pending = this.harnessTurns.get(sessionId)
      pending?.abort()
      this.store.setRunning(sessionId, false)
      this.notice('cancelled', 'info')
      return
    }
    const childMode = await this.subagentMode(session)
    let result: RpcResult<ResponseValue<'subagent.interrupt'>> | RpcResult<ResponseValue<'session.cancel'>>
    if (session.origin === 'subagent') {
      const parentSessionId = session.parentSessionId
      if (parentSessionId === undefined || childMode !== 'continuable') {
        this.notice('this subagent cannot be interrupted', 'warn')
        return
      }
      result = await this.client.call('subagent.interrupt', {
        parentSessionId,
        childSessionId: session.id,
        mode: 'continuable',
      })
    } else {
      result = await this.client.call('session.cancel', { sessionId: session.id })
    }
    if (!result.ok) this.notice(`cancel failed: ${result.error.message}`, 'error')
    else this.notice('cancelled', 'info')
  }

  private async subagentMode(session: SessionState): Promise<'one-shot' | 'continuable' | undefined> {
    if (session.origin !== 'subagent') return undefined
    const cached = this.subagentModes.get(session.id)
    if (cached !== undefined) return cached
    const parentSessionId = session.parentSessionId
    if (parentSessionId === undefined) return undefined
    const result = await this.client.call('subagent.list', { parentSessionId })
    if (!result.ok) return undefined
    const entry = result.value.entries.find((candidate) => candidate.kind === 'child' && candidate.id === session.id)
    if (entry === undefined || entry.kind !== 'child') return undefined
    this.subagentModes.set(session.id, entry.mode)
    return entry.mode
  }

  private async fork(atSeq?: number): Promise<void> {
    const focused = this.focused()
    if (focused === undefined) return
    const result = await this.client.call('session.fork', {
      sessionId: focused.id,
      ...atSeq === undefined ? {} : { atSeq },
    })
    if (!result.ok) {
      this.notice(`fork failed: ${result.error.message}`, 'error')
      return
    }
    this.focus(result.value.sessionId)
    this.notice(atSeq === undefined ? 'forked' : `rewound from seq ${String(atSeq)}`, 'info')
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

  private requestChromeFrame(): void {
    this.chromeOnly = true
    this.requestFrame()
  }

  private requestFrame(): void {
    if (this.stopped || this.framePending) return
    this.framePending = true
    const wait = Math.max(0, FRAME_INTERVAL_MS - (Date.now() - this.lastFrameAt))
    this.frameTimer = setTimeout(() => {
      this.framePending = false
      this.frameTimer = undefined
      this.lastFrameAt = Date.now()
      this.render()
    }, wait)
    this.frameTimer.unref?.()
  }

  private visibleTranscriptRows(): number {
    const sidebarHidden = this.sidebarSessions().length <= 1
    return Math.max(1, computeLayout(this.screen.columns, this.screen.rows, { sidebarHidden }).transcript.height)
  }

  private focused(): SessionState | undefined {
    return this.store.focusedId === undefined ? undefined : this.store.get(this.store.focusedId)
  }

  /**
   * The always-visible rail is local to the focused project. Ctrl+K remains
   * the global session manager, so old workspaces stay reachable without
   * crowding every project into the main cockpit.
   */
  private sidebarSessions(): readonly SessionState[] {
    const sessions = this.store.sessions
    const focused = this.focused()
    const projectCwd = resolve(focused?.cwd ?? this.options.cwd)
    const visible = new Set(sessions
      .filter((session) => session.cwd !== undefined && resolve(session.cwd) === projectCwd)
      .map((session) => session.id))
    if (focused !== undefined) visible.add(focused.id)
    // Subagents may omit cwd; inherit project membership from their parent.
    let changed = true
    while (changed) {
      changed = false
      for (const session of sessions) {
        if (visible.has(session.id) || session.parentSessionId === undefined) continue
        if (visible.has(session.parentSessionId)) {
          visible.add(session.id)
          changed = true
        }
      }
    }
    return sessions.filter((session) => visible.has(session.id))
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
      ...session.harness === undefined ? {} : { harness: harnessLabel(session.harness) },
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

  private projectOf(session: SessionState): string {
    const cwd = session.cwd ?? this.options.cwd
    const trimmed = cwd.replace(/[\\/]+$/, '')
    if (trimmed.length === 0) return cwd
    const parts = trimmed.split(/[\\/]/)
    return parts[parts.length - 1] ?? trimmed
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

    const sidebarSessions = this.sidebarSessions()
    const sidebarHidden = sidebarSessions.length <= 1
    const baseLayout = computeLayout(columns, rows, { sidebarHidden })
    const draftRows = Math.min(4, Math.max(1, Math.ceil(
      Math.max(1, stringWidth(this.draft) + 3) / Math.max(1, baseLayout.composer.width - 2),
    )))
    const layout: Layout = computeLayout(columns, rows, { composerHeight: draftRows, sidebarHidden })
    const focused = this.focused()

    // The header rect can move between centered single-session and full-width
    // multi-session layouts. Repaint the whole physical row first so Ghostty
    // never keeps cells from the previous geometry under the new title.
    this.screen.fill(1, 1, columns, 1, ' ', this.theme.base)
    renderHeader(this.screen, {
      rect: layout.header,
      host: this.host,
      connection: this.connectionState,
      sessionTitle: focused?.title,
      ...focused === undefined ? {} : { project: this.projectOf(focused) },
      theme: this.theme,
      glyphs: this.glyphs,
      ...focused === undefined ? {} : { telemetry: focused.telemetry },
      ...focused === undefined ? {} : { modes: this.modeSummary(focused) },
    })

    if (layout.sidebar !== undefined) {
      renderSidebar(this.screen, {
        rect: layout.sidebar,
        sessions: sidebarSessions,
        focusedId: this.store.focusedId,
        theme: this.theme,
        glyphs: this.glyphs,
        spinnerFrame: this.spinnerFrame,
      })
      for (let row = layout.sidebar.row; row < layout.sidebar.row + layout.sidebar.height; row += 1) {
        this.screen.put(row, layout.sidebar.width + 1, this.glyphs.vline, this.theme.border)
      }
    }

    const skipLayout = this.chromeOnly && this.lastLines.length > 0
    this.chromeOnly = false
    let lines: readonly RenderedLine[] = skipLayout ? this.lastLines : []
    if (focused !== undefined && !skipLayout) {
      const retrying = focused.transcript.retrying
      lines = layoutTranscript(focused.transcript.items, {
        width: layout.transcript.width,
        theme: this.theme,
        glyphs: this.glyphs,
        spinnerFrame: this.spinnerFrame,
        expandTools: this.expandTools,
        expandReasoning: this.expandReasoning,
        queue: focused.queue,
        ...retrying === undefined ? {} : { retrying: { count: retrying.count, ...retrying.reason === undefined ? {} : { reason: retrying.reason } } },
      })
      if (lines.length === 0) {
        lines = [
          { spans: [{ text: 'No messages yet. Type a task or / for commands.', style: this.theme.subtle }] },
          { spans: [{ text: '/ commands  ·  Ctrl+K sessions  ·  Ctrl+\\ dashboard  ·  Ctrl+G help', style: this.theme.dim }] },
        ]
      }
    }
    const { maxScroll } = renderTranscript(this.screen, {
      rect: layout.transcript,
      lines,
      scrollOffset: this.scrollOffset,
      theme: this.theme,
      glyphs: this.glyphs,
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
      mode: this.sendMode,
      busy: focused?.running ?? false,
      theme: this.theme,
      glyphs: this.glyphs,
      ...this.vimMode
        ? { vim: this.scrollbackFocus || this.composerVim === 'normal' ? 'normal' as const : 'insert' as const }
        : {},
    })

    const focusedForHints = this.focused()
    const approvalForHints = this.pendingApprovalTarget()
    const approvalCount = approvalForHints === undefined ? 0 : pendingApprovalsOf(approvalForHints).length
    const questionCount = focusedForHints === undefined ? 0 : pendingQuestionsOf(focusedForHints).length
    renderFooter(this.screen, {
      rect: layout.footer,
      // The hint row is how the user learns the keyboard has changed mode.
      hints: approvalForHints !== undefined
        ? approvalHints(
          approvalCount,
          this.titleOf(approvalForHints),
          approvalForHints.pendingApproval?.toolName ?? 'tool',
        )
        : questionCount > 0 && (this.overlay === undefined || this.overlay.kind === 'question')
          ? questionHints(questionCount)
          : this.vimMode && this.scrollbackFocus && this.overlay === undefined
            ? VIM_HINTS
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
        renderSwitcher(this.screen, layout.transcript, this.overlay.state, this.theme, this.glyphs, this.spinnerFrame)
      } else if (this.overlay.kind === 'rewind') {
        renderRewindOverlay(this.screen, layout.transcript, this.overlay.state, this.theme, this.glyphs)
      } else if (this.overlay.kind === 'queue') {
        renderQueueOverlay(this.screen, layout.transcript, this.overlay.state, this.theme, this.glyphs)
      } else if (this.overlay.kind === 'dashboard') {
        renderDashboard(this.screen, layout.transcript, this.overlay.state, this.theme, this.glyphs, this.spinnerFrame)
      } else if (this.overlay.kind === 'question') {
        renderQuestionOverlay(this.screen, layout.transcript, this.overlay.state, this.theme, this.glyphs)
      } else if (this.overlay.kind === 'picker') {
        renderPickerOverlay(this.screen, layout.transcript, this.overlay.state, this.theme, this.glyphs)
      } else if (this.overlay.kind === 'commands') {
        renderCommandPalette(this.screen, layout.transcript, this.overlay.state, this.theme, this.glyphs)
      } else if (this.overlay.kind === 'info') {
        renderInfoOverlay(this.screen, layout.transcript, this.overlay.state, this.theme, this.glyphs)
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
    if (
      this.overlay === undefined
      && !(this.vimMode && (this.scrollbackFocus || this.composerVim === 'normal'))
    ) {
      this.screen.showCursorAt(caret.row, caret.col)
    } else {
      this.screen.hideCursor()
    }
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
    const anyRunning = this.store.allSessions.some((s) => s.running)
    if (anyRunning && this.spinnerTimer === undefined) {
      this.spinnerTimer = setInterval(() => {
        this.spinnerFrame += 1
        const focused = this.focused()
        if (focused?.running === true) this.requestFrame()
        else this.requestChromeFrame()
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
    const blocked = this.store.allSessions.some((s) => s.pendingApproval !== undefined)
    const running = this.store.allSessions.some((s) => s.running)
    const state = blocked ? 2 : running ? 3 : 0
    if (state !== this.lastProgress) {
      this.term.progress(state === 0 ? 0 : (state as 2 | 3))
      this.lastProgress = state
    }
    this.syncProgressHeartbeat(state)
    const label = focused === undefined
      ? 'deck'
      : `deck · ${this.projectOf(focused)}${focused.title === undefined ? '' : ` · ${focused.title}`}`
    const titled = blocked ? `${label} · approval needed` : running ? `${label} · working` : label
    if (titled !== this.lastTitle) {
      this.term.title(titled)
      this.lastTitle = titled
    }
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

function envFlag(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = env[key]
  if (value === undefined) return false
  const v = value.trim().toLowerCase()
  return v === '1' || v === 'true'
}

function queueOverlayItems(session: SessionState): QueueOverlayItem[] {
  const items: QueueOverlayItem[] = []
  for (const item of session.queue) {
    if (item.placement === 'context') continue
    const text = promptText(item.message)
    items.push({
      id: item.id,
      placement: item.placement,
      preview: text.length === 0 ? '(non-text message)' : text,
      text,
    })
  }
  return items
}

function promptText(message: QueuedInboxItem['message']): string {
  if (typeof message.content === 'string') return message.content.replace(/\s+/g, ' ').trim()
  return message.content
    .filter((block): block is Extract<(typeof message.content)[number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function clipboardArgv(): string[] | undefined {
  if (process.platform === 'darwin') return ['pbcopy']
  if (process.platform === 'win32') return ['clip']
  if (process.env.WAYLAND_DISPLAY) return ['wl-copy']
  if (process.env.DISPLAY) return ['xclip', '-selection', 'clipboard']
  return ['wl-copy']
}

function mediaTypeOf(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  return 'application/octet-stream'
}

function rewindTurns(items: SessionState['transcript']['items']): { seq: number; turn: number; preview: string }[] {
  const turns: { seq: number; turn: number; preview: string }[] = []
  for (const item of items) {
    if (item.kind !== 'user') continue
    const turn = turns.length + 1
    const preview = item.text.replace(/\s+/g, ' ').trim()
    turns.push({ seq: item.seq, turn, preview: preview.length > 0 ? preview : '(empty)' })
  }
  return turns
}

function dashboardPrefSignature(state: DashboardState): string {
  return `${state.grouping}\0${state.pinned.join(',')}\0${state.pinOrder.join(',')}`
}

function parseSlashCommand(line: string): { name: string; input: string } | undefined {
  const match = /^\/([a-z][a-z0-9_-]*)(?:\s+(.*))?$/iu.exec(line)
  if (match === null || match[1] === undefined) return undefined
  return { name: match[1].toLocaleLowerCase(), input: match[2]?.trim() ?? '' }
}

function mergeCommandCatalog(
  locals: readonly SlashCommandEntry[],
  host: readonly CommandDescriptor[],
  skills: readonly SlashCommandEntry[] = [],
): SlashCommandEntry[] {
  const out: SlashCommandEntry[] = []
  const seen = new Set<string>()
  const firstScreen = new Set(['model', 'modes', 'harness', 'sessions', 'dashboard', 'new'])
  const ordered = [
    ...locals.filter((command) => firstScreen.has(normalizedCommandName(command.name))),
    ...host,
    ...locals.filter((command) => !firstScreen.has(normalizedCommandName(command.name))),
    ...skills,
  ]
  for (const command of ordered) {
    const name = normalizedCommandName(command.name)
    if (name.length === 0 || seen.has(name)) continue
    seen.add(name)
    out.push({ ...command, name })
  }
  return out
}

/**
 * `thinkingmachines/inkling` reads as `inkling`. The vendor prefix is the same
 * on every model from one route and the route is already shown beside it.
 */
function overlayHomeFor(env: NodeJS.ProcessEnv, harness: string, sessionId: string): string {
  const home = env.DECK_HOME
  const root = typeof home === 'string' && home.length > 0 ? home : join(homedir(), '.deck')
  return join(root, 'harness', harness, sessionId)
}

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
