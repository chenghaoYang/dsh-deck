/**
 * In-memory multi-session store. Reduces mux/host frames into SessionState.
 * No I/O, no terminal — subscribers get coalesced StoreChange events.
 */

import {
  addUsage,
  applyEvent,
  applyHistory,
  emptyTranscript,
  type TranscriptState,
} from './fold.ts'
import type {
  ApprovalRequestId,
  AskUserQuestionItem,
  CallId,
  HistoryEntry,
  HostFrame,
  MuxFrame,
  PermissionsProjection,
  PlanProjection,
  QueuedInboxItem,
  RpcId,
  SessionId,
  SessionSummary,
} from '../protocol/contract.ts'

export interface SessionState {
  id: SessionId
  title?: string
  cwd?: string
  running: boolean
  blank: boolean
  origin?: 'subagent'
  parentSessionId?: SessionId
  updatedAt: number
  transcript: TranscriptState
  /** Loaded lazily; false until the first history fetch resolves. */
  historyLoaded: boolean
  hasMoreHistory: boolean
  /** All answerable approvals in arrival order; the singular field is the active head. */
  pendingApprovals?: readonly PendingApproval[]
  pendingApproval?: PendingApproval
  /** All answerable question batches in arrival order; the singular field is the active head. */
  pendingQuestions?: readonly PendingQuestion[]
  pendingQuestion?: PendingQuestion
  queue: QueuedInboxItem[]
  /** Unseen activity since the user last focused this session. */
  unread: number
  lastError?: string
  telemetry: SessionTelemetry
  modes: SessionModes
}

/**
 * Per-session mode state. Permission and plan arrive as projections, so they
 * replay on history and update live without deck ever polling. The model
 * selection has no projection — nothing on the wire announces it — so it is
 * filled in by whoever last called `session.models` or `session.selectModel`.
 */
export interface SessionModes {
  permissions?: PermissionsProjection
  plan?: PlanProjection
  model?: { provider: string; model: string; effort?: string }
  /** Preset id from the host; its display name needs `agentPreset.list`. */
  agentPreset?: string
}

export interface PendingApproval {
  rpcId: RpcId
  approvalId: ApprovalRequestId
  toolName: string
  callId?: CallId
  reason?: string
  at: number
}

export interface PendingQuestion {
  rpcId: RpcId
  questions: AskUserQuestionItem[]
  at: number
}

export interface SessionTelemetry {
  contextWindow?: number
  breakdown?: { systemTokens: number; toolsTokens: number; messageTokens: number }
  stats?: { turns: number; steps: number; llmMs: number; toolMs: number; ttftMs: number; ttftSteps: number; decodeMs: number; decodeTokens: number }
}

export type StoreChange =
  | { kind: 'sessions' }
  | { kind: 'transcript'; sessionId: SessionId }
  | { kind: 'approval'; sessionId: SessionId }
  | { kind: 'question'; sessionId: SessionId }
  | { kind: 'status'; sessionId: SessionId }

export class DeckStore {
  focusedId?: SessionId

  private readonly byId = new Map<SessionId, SessionState>()
  /** Higher-seq-wins cells keyed by `${sessionId}\0${key}`. */
  private readonly projections = new Map<string, { seq: number; value: unknown }>()
  /** Model selections learned from `session.models` / `session.selectModel`. */
  private readonly modelSelections = new Map<SessionId, { provider: string; model: string; effort?: string }>()
  private readonly listeners = new Set<(event: StoreChange) => void>()
  private readonly pending = new Map<string, StoreChange>()
  private scheduled = false

  /**
   * Durable archive registry. Host snapshots replace it in full
   * (`workspace.list` baseline and `host/archived-sessions-changed`).
   * Survives `resetLiveState`. Archived ids stay in `session.list` on the
   * host; this client hides them from `sessions` unless currently focused.
   */
  private archivedSessionIds = new Set<SessionId>()

  get sessions(): readonly SessionState[] {
    return [...this.byId.values()]
      .filter((session) => !session.blank)
      .filter((session) => !this.archivedSessionIds.has(session.id) || this.focusedId === session.id)
      .sort((a, b) => {
        if (a.running !== b.running) return a.running ? -1 : 1
        if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
  }

  get(id: SessionId): SessionState | undefined {
    return this.byId.get(id)
  }

  focus(id: SessionId): void {
    this.focusedId = id
    const session = this.byId.get(id)
    if (session === undefined) return
    if (session.unread === 0) {
      this.emit({ kind: 'sessions' })
      return
    }
    this.byId.set(id, { ...session, unread: 0 })
    this.emit({ kind: 'sessions' })
  }

  /** Clear only the local view; the durable host log remains available on reconnect. */
  clearTranscriptView(id: SessionId): void {
    const session = this.byId.get(id)
    if (session === undefined) return
    this.byId.set(id, {
      ...session,
      transcript: emptyTranscript(),
      historyLoaded: true,
      hasMoreHistory: false,
    })
    this.emit({ kind: 'transcript', sessionId: id })
  }

  applyMux(frame: MuxFrame, rpcId: RpcId): void {
    switch (frame.type) {
      case 'session/event':
        this.applySessionEvent(frame.sessionId, frame, rpcId)
        return
      case 'session/subscribed':
        this.ensure(frame.sessionId)
        return
      case 'approval/requested':
        this.applyApprovalRequested(frame, rpcId)
        return
      case 'approval/resolved':
        this.applyApprovalResolved(frame)
        return
      case 'session/queue': {
        const session = this.ensure(frame.sessionId)
        this.byId.set(frame.sessionId, { ...session, queue: frame.items.slice() })
        this.emit({ kind: 'sessions' })
        return
      }
      case 'session/projection':
        this.applyProjection(frame.sessionId, frame.key, frame.value, frame.seq)
        return
      case 'question/requested':
        this.applyQuestionRequested(frame, rpcId)
        return
      case 'question/resolved':
        this.applyQuestionResolved(frame)
        return
      case 'session/jobs':
      case 'stream/error':
        return
      default:
        return
    }
  }

  applyHost(frame: HostFrame, rpcId: RpcId): void {
    void rpcId
    switch (frame.type) {
      case 'host/session-added':
        this.mergeAdded(frame)
        return
      case 'host/session-removed': {
        this.byId.delete(frame.sessionId)
        if (this.focusedId === frame.sessionId) delete this.focusedId
        this.emit({ kind: 'sessions' })
        return
      }
      case 'host/session-status': {
        const session = this.ensure(frame.sessionId)
        if (session.running === frame.running) return
        this.byId.set(frame.sessionId, { ...session, running: frame.running })
        this.emit({ kind: 'status', sessionId: frame.sessionId })
        this.emit({ kind: 'sessions' })
        return
      }
      case 'host/agent-error': {
        const session = this.ensure(frame.sessionId)
        const next: SessionState = { ...session, lastError: frame.message }
        this.byId.set(frame.sessionId, next)
        this.emit({ kind: 'status', sessionId: frame.sessionId })
        return
      }
      case 'host/archived-sessions-changed':
        // Full snapshot, not a delta — same replace-in-full rule as the baseline.
        this.replaceArchived(frame.archivedSessionIds)
        return
      default:
        return
    }
  }

  /**
   * Reconnect baseline from `workspace.list` → `{ archivedSessionIds }`.
   * Replaces the registry in full, same as the host snapshot frame.
   */
  applyArchivedBaseline(ids: readonly SessionId[]): void {
    this.replaceArchived(ids)
  }

  applySessionList(items: readonly SessionSummary[]): void {
    for (const item of items) {
      const prev = this.byId.get(item.sessionId)
      const next: SessionState = {
        id: item.sessionId,
        running: item.running,
        blank: item.blank,
        updatedAt: item.updatedAt,
        transcript: prev?.transcript ?? emptyTranscript(),
        historyLoaded: prev?.historyLoaded ?? false,
        hasMoreHistory: prev?.hasMoreHistory ?? false,
        pendingApprovals: prev === undefined ? [] : pendingApprovalsOf(prev),
        pendingQuestions: prev === undefined ? [] : pendingQuestionsOf(prev),
        queue: prev?.queue ?? [],
        unread: prev?.unread ?? 0,
        telemetry: prev?.telemetry ?? {},
        modes: prev?.modes ?? {},
      }
      copyOptional(next, prev, item)
      this.byId.set(item.sessionId, next)
    }
    this.emit({ kind: 'sessions' })
  }

  applyHistoryPage(id: SessionId, entries: readonly HistoryEntry[], hasMore: boolean): void {
    const session = this.ensure(id)
    const merged = mergeHistory(session.transcript, entries)
    const latest = this.byId.get(id) ?? session
    this.byId.set(id, {
      ...latest,
      transcript: merged,
      historyLoaded: true,
      hasMoreHistory: hasMore,
    })
    for (const entry of entries) {
      if (entry.event.type === 'session/title') {
        const title = titleFromEventData(entry.event.data)
        if (title !== undefined) this.applyProjection(id, 'title', title, entry.event.seq)
      }
    }
    this.emit({ kind: 'transcript', sessionId: id })
    this.emit({ kind: 'sessions' })
  }

  /** Called when a connection generation is lost: clears live-only state. */
  resetLiveState(): void {
    for (const [id, session] of this.byId) {
      const next: SessionState = {
        id: session.id,
        running: false,
        blank: session.blank,
        updatedAt: session.updatedAt,
        transcript: emptyTranscript(),
        historyLoaded: false,
        hasMoreHistory: session.hasMoreHistory,
        pendingApprovals: [],
        pendingQuestions: [],
        queue: [],
        unread: session.unread,
        telemetry: session.telemetry,
        // Permission and plan replay from the history projection cut, and the
        // model selection is refetched on focus, so keeping them across a
        // generation boundary avoids a blank header during the refetch.
        modes: session.modes,
      }
      if (session.title !== undefined) next.title = session.title
      if (session.cwd !== undefined) next.cwd = session.cwd
      if (session.origin !== undefined) next.origin = session.origin
      if (session.parentSessionId !== undefined) next.parentSessionId = session.parentSessionId
      this.byId.set(id, next)
      this.emit({ kind: 'transcript', sessionId: id })
      this.emit({ kind: 'status', sessionId: id })
    }
    this.emit({ kind: 'sessions' })
  }

  subscribe(listener: (event: StoreChange) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private applySessionEvent(
    id: SessionId,
    frame: Extract<MuxFrame, { type: 'session/event' }>,
    _rpcId: RpcId,
  ): void {
    const session = this.ensure(id)
    const event = frame.event
    if (event.type === 'session/title') {
      const title = titleFromEventData(event.data)
      if (title !== undefined) this.applyProjection(id, 'title', title, event.seq)
    }

    const prev = session.transcript
    const transcript = applyEvent(prev, event, frame.view)
    if (transcript === prev) return

    const itemsChanged = transcript.items !== prev.items
    const next: SessionState = { ...session, transcript }
    if (itemsChanged && this.focusedId !== id) next.unread = session.unread + 1
    if (itemsChanged && event.time > session.updatedAt) next.updatedAt = event.time
    if (event.type === 'turn/start') {
      next.running = true
      next.blank = false
    } else if (event.type === 'turn/end') {
      next.running = false
    }
    this.byId.set(id, next)
    this.emit({ kind: 'transcript', sessionId: id })
    if (itemsChanged || next.running !== session.running || next.blank !== session.blank) {
      this.emit({ kind: 'sessions' })
    }
    if (next.running !== session.running) this.emit({ kind: 'status', sessionId: id })
  }

  private applyApprovalRequested(
    frame: Extract<MuxFrame, { type: 'approval/requested' }>,
    rpcId: RpcId,
  ): void {
    const session = this.ensure(frame.sessionId)
    const pending: PendingApproval = {
      rpcId,
      approvalId: frame.approvalId,
      toolName: frame.toolName,
      at: Date.now(),
    }
    if (frame.callId !== undefined) pending.callId = frame.callId
    if (frame.reason !== undefined) pending.reason = frame.reason

    let transcript = session.transcript
    if (frame.callId !== undefined) {
      transcript = patchToolStatus(transcript, frame.callId, 'awaiting-approval')
    }
    const approvals = pendingApprovalsOf(session)
    // A mux-open replay repeats the same rpcId. It is not a second ask; other
    // IDs are genuine parallel approvals and must remain answerable.
    if (approvals.some((item) => item.rpcId === pending.rpcId || item.approvalId === pending.approvalId)) return
    const pendingApprovals = [...approvals, pending]
    const next: SessionState = {
      ...session,
      transcript,
      pendingApprovals,
      ...activeApproval(pendingApprovals),
    }
    this.byId.set(frame.sessionId, next)
    this.emit({ kind: 'approval', sessionId: frame.sessionId })
    if (transcript !== session.transcript) this.emit({ kind: 'transcript', sessionId: frame.sessionId })
  }

  private applyApprovalResolved(
    frame: Extract<MuxFrame, { type: 'approval/resolved' }>,
  ): void {
    const session = this.byId.get(frame.sessionId)
    if (session === undefined) return
    const approvals = pendingApprovalsOf(session)
    const index = approvals.findIndex((item) => item.approvalId === frame.approvalId)
    // A stale/unknown resolution must not clear the active approval.
    if (index < 0) return
    const resolved = approvals[index]
    if (resolved === undefined) return
    const pendingApprovals = approvals.slice(0, index).concat(approvals.slice(index + 1))
    const callId = resolved.callId
    let transcript = session.transcript
    if (callId !== undefined) {
      const status = frame.outcome === 'allowed-once' ? 'running' : 'cancelled'
      transcript = patchToolStatus(transcript, callId, status)
    }
    const { pendingApproval: _oldApproval, ...withoutApproval } = session
    void _oldApproval
    const next: SessionState = {
      ...withoutApproval,
      transcript,
      pendingApprovals,
      ...activeApproval(pendingApprovals),
    }
    this.byId.set(frame.sessionId, next)
    this.emit({ kind: 'approval', sessionId: frame.sessionId })
    if (transcript !== session.transcript) this.emit({ kind: 'transcript', sessionId: frame.sessionId })
  }

  private applyQuestionRequested(
    frame: Extract<MuxFrame, { type: 'question/requested' }>,
    rpcId: RpcId,
  ): void {
    const session = this.ensure(frame.sessionId)
    const pending: PendingQuestion = {
      rpcId,
      questions: frame.questions.slice(),
      at: Date.now(),
    }
    const questions = pendingQuestionsOf(session)
    // A reconnect replay has the same rpcId; parallel batches have distinct IDs.
    if (questions.some((item) => item.rpcId === pending.rpcId)) return
    const pendingQuestions = [...questions, pending]
    const next: SessionState = {
      ...session,
      pendingQuestions,
      ...activeQuestion(pendingQuestions),
      updatedAt: pending.at,
    }
    if (this.focusedId !== frame.sessionId) next.unread = session.unread + 1
    this.byId.set(frame.sessionId, next)
    this.emit({ kind: 'question', sessionId: frame.sessionId })
    if (next.unread !== session.unread) this.emit({ kind: 'sessions' })
  }

  private applyQuestionResolved(
    frame: Extract<MuxFrame, { type: 'question/resolved' }>,
  ): void {
    const session = this.byId.get(frame.sessionId)
    if (session === undefined) return
    const questions = pendingQuestionsOf(session)
    const index = questions.findIndex((item) => item.rpcId === frame.questionRpcId)
    if (index < 0) return
    const pendingQuestions = questions.slice(0, index).concat(questions.slice(index + 1))
    const { pendingQuestion: _oldQuestion, ...withoutQuestion } = session
    void _oldQuestion
    this.byId.set(frame.sessionId, {
      ...withoutQuestion,
      pendingQuestions,
      ...activeQuestion(pendingQuestions),
    })
    this.emit({ kind: 'question', sessionId: frame.sessionId })
  }

  /**
   * Records the model a session is actually using. There is no projection for
   * it, so this is the only way the header can stop showing the host-wide
   * default after a per-session switch.
   */
  applyModelSelection(id: SessionId, selection: { provider: string; model: string; effort?: string }): void {
    const prev = this.modelSelections.get(id)
    if (
      prev !== undefined
      && prev.provider === selection.provider
      && prev.model === selection.model
      && prev.effort === selection.effort
    ) return
    this.modelSelections.set(id, selection)
    const session = this.ensure(id)
    this.byId.set(id, { ...session, modes: { ...session.modes, model: selection } })
    this.emit({ kind: 'status', sessionId: id })
  }

  private applyProjection(sessionId: SessionId, key: string, value: unknown, seq: number): void {
    const isTitle = key.toLowerCase().includes('title')
    const isTelemetry = key === 'contextPressure' || key === 'contextBreakdown' || key === 'sessionStats'
    const isMode = key === 'permissions' || key === 'plan'
    if (!isTitle && !isTelemetry && !isMode) return
    const cell = `${sessionId}\0${key}`
    const prev = this.projections.get(cell)
    if (prev !== undefined && seq <= prev.seq) return
    this.projections.set(cell, { seq, value })
    if (isTitle) {
      if (typeof value !== 'string') return
      const session = this.ensure(sessionId)
      if (session.title === value) return
      this.byId.set(sessionId, { ...session, title: value })
      this.emit({ kind: 'sessions' })
      return
    }
    if (isMode) {
      this.applyModeProjection(sessionId, key, value)
      return
    }
    this.applyTelemetryProjection(sessionId, key, value)
  }

  private applyModeProjection(sessionId: SessionId, key: string, value: unknown): void {
    const session = this.ensure(sessionId)
    const modes = applyModeKey(session.modes, key, value)
    if (modes === undefined || modes === session.modes) return
    this.byId.set(sessionId, { ...session, modes })
    this.emit({ kind: 'status', sessionId })
  }

  private applyTelemetryProjection(sessionId: SessionId, key: string, value: unknown): void {
    const session = this.ensure(sessionId)
    const telemetry = applyTelemetryKey(session.telemetry, key, value)
    if (telemetry === undefined || telemetry === session.telemetry) return
    this.byId.set(sessionId, { ...session, telemetry })
    this.emit({ kind: 'status', sessionId })
  }

  private mergeAdded(frame: Extract<HostFrame, { type: 'host/session-added' }>): void {
    const prev = this.byId.get(frame.sessionId)
    const next: SessionState = {
      id: frame.sessionId,
      running: prev?.running ?? false,
      blank: frame.blank,
      updatedAt: prev?.updatedAt ?? Date.now(),
      transcript: prev?.transcript ?? emptyTranscript(),
      historyLoaded: prev?.historyLoaded ?? false,
      hasMoreHistory: prev?.hasMoreHistory ?? false,
      pendingApprovals: prev === undefined ? [] : pendingApprovalsOf(prev),
      pendingQuestions: prev === undefined ? [] : pendingQuestionsOf(prev),
      queue: prev?.queue ?? [],
      unread: prev?.unread ?? 0,
      telemetry: prev?.telemetry ?? {},
      modes: prev?.modes ?? {},
    }
    copyOptional(next, prev, frame)
    this.byId.set(frame.sessionId, next)
    this.emit({ kind: 'sessions' })
  }

  private ensure(id: SessionId): SessionState {
    const existing = this.byId.get(id)
    if (existing !== undefined) return existing
    const known = this.modelSelections.get(id)
    const created: SessionState = {
      id,
      running: false,
      blank: false,
      updatedAt: 0,
      transcript: emptyTranscript(),
      historyLoaded: false,
      hasMoreHistory: false,
      pendingApprovals: [],
      pendingQuestions: [],
      queue: [],
      unread: 0,
      telemetry: {},
      modes: known === undefined ? {} : { model: known },
    }
    this.byId.set(id, created)
    this.emit({ kind: 'sessions' })
    return created
  }

  private replaceArchived(ids: readonly SessionId[]): void {
    const next = new Set<SessionId>(ids)
    if (sameIdSet(this.archivedSessionIds, next)) return
    this.archivedSessionIds = next
    this.emit({ kind: 'sessions' })
  }

  private emit(change: StoreChange): void {
    const key = change.kind === 'sessions' ? 'sessions' : `${change.kind}:${change.sessionId}`
    this.pending.set(key, change)
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      const batch = [...this.pending.values()]
      this.pending.clear()
      for (const listener of this.listeners) {
        for (const event of batch) {
          try {
            listener(event)
          } catch {
            // A subscriber failure must not drop the rest of the batch.
          }
        }
      }
    })
  }
}

/** Return the full approval queue, including compatibility with legacy fixtures. */
export function pendingApprovalsOf(
  session: Pick<SessionState, 'pendingApprovals' | 'pendingApproval'>,
): readonly PendingApproval[] {
  if (session.pendingApprovals !== undefined) return session.pendingApprovals
  return session.pendingApproval === undefined ? [] : [session.pendingApproval]
}

/** Return the full question queue, including compatibility with legacy fixtures. */
export function pendingQuestionsOf(
  session: Pick<SessionState, 'pendingQuestions' | 'pendingQuestion'>,
): readonly PendingQuestion[] {
  if (session.pendingQuestions !== undefined) return session.pendingQuestions
  return session.pendingQuestion === undefined ? [] : [session.pendingQuestion]
}

function activeApproval(items: readonly PendingApproval[]): { pendingApproval?: PendingApproval } {
  const active = items[0]
  return active === undefined ? {} : { pendingApproval: active }
}

function activeQuestion(items: readonly PendingQuestion[]): { pendingQuestion?: PendingQuestion } {
  const active = items[0]
  return active === undefined ? {} : { pendingQuestion: active }
}

function mergeHistory(
  current: TranscriptState,
  entries: readonly HistoryEntry[],
): TranscriptState {
  if (entries.length === 0) return current
  const first = entries[0]
  const last = entries[entries.length - 1]
  if (first === undefined || last === undefined) return current

  let minExisting = Infinity
  for (const item of current.items) {
    if (item.seq < minExisting) minExisting = item.seq
  }

  // Older page: fold independently and prepend. applyEvent would no-op
  // because those seqs are below lastSeq.
  if (current.items.length > 0 && last.event.seq < minExisting) {
    const older = applyHistory(emptyTranscript(), entries)
    return {
      ...current,
      items: [...older.items, ...current.items],
      usage: addUsage(older.usage, current.usage),
    }
  }
  return applyHistory(current, entries)
}

function patchToolStatus(
  transcript: TranscriptState,
  callId: CallId,
  status: 'awaiting-approval' | 'running' | 'cancelled',
): TranscriptState {
  let changed = false
  const items = transcript.items.map((item) => {
    if (item.kind !== 'tool' || item.call.callId !== callId) return item
    if (item.call.status === 'ok' || item.call.status === 'error') return item
    changed = true
    return { ...item, call: { ...item.call, status } }
  })
  return changed ? { ...transcript, items } : transcript
}

function titleFromEventData(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const title = (data as { title?: unknown }).title
  return typeof title === 'string' ? title : undefined
}

function copyOptional(
  next: SessionState,
  prev: SessionState | undefined,
  src: { cwd?: string; origin?: 'subagent'; parentSessionId?: SessionId; title?: string; agentPreset?: string },
): void {
  // The preset id rides on session.list and host/session-added, and is the only
  // mode the host volunteers without being asked.
  if (src.agentPreset !== undefined) next.modes = { ...next.modes, agentPreset: src.agentPreset }
  if (src.cwd !== undefined) next.cwd = src.cwd
  else if (prev?.cwd !== undefined) next.cwd = prev.cwd
  if (src.origin !== undefined) next.origin = src.origin
  else if (prev?.origin !== undefined) next.origin = prev.origin
  if (src.parentSessionId !== undefined) next.parentSessionId = src.parentSessionId
  else if (prev?.parentSessionId !== undefined) next.parentSessionId = prev.parentSessionId
  if (src.title !== undefined) next.title = src.title
  else if (prev?.title !== undefined) next.title = prev.title
  if (prev?.pendingApproval !== undefined) next.pendingApproval = prev.pendingApproval
  if (prev?.pendingQuestion !== undefined) next.pendingQuestion = prev.pendingQuestion
  if (prev?.lastError !== undefined) next.lastError = prev.lastError
  if (prev?.telemetry !== undefined) next.telemetry = prev.telemetry
}

/** `undefined` = malformed, so the previous cell keeps serving the header. */
function applyModeKey(current: SessionModes, key: string, value: unknown): SessionModes | undefined {
  if (key === 'permissions') {
    const permissions = parsePermissions(value)
    if (permissions === undefined) return undefined
    if (samePermissions(current.permissions, permissions)) return current
    return { ...current, permissions }
  }
  if (key === 'plan') {
    const plan = parsePlan(value)
    if (plan === undefined) return undefined
    if (current.plan?.active === plan.active && current.plan.pending === plan.pending) return current
    return { ...current, plan }
  }
  return undefined
}

function parsePermissions(value: unknown): PermissionsProjection | undefined {
  if (!isPlainRecord(value)) return undefined
  const { options, currentValue } = value
  if (typeof currentValue !== 'string' || !Array.isArray(options)) return undefined
  const parsed: { value: string; name: string }[] = []
  for (const option of options) {
    if (!isPlainRecord(option)) return undefined
    if (typeof option.value !== 'string') return undefined
    parsed.push({ value: option.value, name: typeof option.name === 'string' ? option.name : option.value })
  }
  return { options: parsed, currentValue }
}

function parsePlan(value: unknown): PlanProjection | undefined {
  if (!isPlainRecord(value)) return undefined
  const { active, pending } = value
  if (typeof active !== 'boolean' || typeof pending !== 'boolean') return undefined
  return { active, pending }
}

function samePermissions(a: PermissionsProjection | undefined, b: PermissionsProjection): boolean {
  if (a === undefined || a.currentValue !== b.currentValue || a.options.length !== b.options.length) return false
  return a.options.every((option, i) => option.value === b.options[i]?.value && option.name === b.options[i]?.name)
}

function applyTelemetryKey(
  current: SessionTelemetry,
  key: string,
  value: unknown,
): SessionTelemetry | undefined {
  if (key === 'contextPressure') {
    const window = parseContextWindow(value)
    if (window === undefined) return undefined
    if (window === current.contextWindow) return current
    if (window === false) {
      if (current.contextWindow === undefined) return current
      const { contextWindow: _drop, ...rest } = current
      void _drop
      return rest
    }
    return { ...current, contextWindow: window }
  }
  if (key === 'contextBreakdown') {
    const breakdown = parseBreakdown(value)
    if (breakdown === undefined) return undefined
    if (sameBreakdown(current.breakdown, breakdown)) return current
    return { ...current, breakdown }
  }
  if (key === 'sessionStats') {
    const stats = parseStats(value)
    if (stats === undefined) return undefined
    if (sameStats(current.stats, stats)) return current
    return { ...current, stats }
  }
  return undefined
}

/** `false` = valid object without a window (clear); `undefined` = malformed. */
function parseContextWindow(value: unknown): number | false | undefined {
  if (!isPlainRecord(value)) return undefined
  if (!('contextWindow' in value)) return false
  const window = value.contextWindow
  return typeof window === 'number' && Number.isFinite(window) ? window : undefined
}

function parseBreakdown(value: unknown): SessionTelemetry['breakdown'] | undefined {
  if (!isPlainRecord(value)) return undefined
  const systemTokens = asFiniteNumber(value.systemTokens)
  const toolsTokens = asFiniteNumber(value.toolsTokens)
  const messageTokens = asFiniteNumber(value.messageTokens)
  if (systemTokens === undefined || toolsTokens === undefined || messageTokens === undefined) {
    return undefined
  }
  return { systemTokens, toolsTokens, messageTokens }
}

function parseStats(value: unknown): SessionTelemetry['stats'] | undefined {
  if (!isPlainRecord(value)) return undefined
  const turns = asFiniteNumber(value.turns)
  const steps = asFiniteNumber(value.steps)
  const llmMs = asFiniteNumber(value.llmMs)
  const toolMs = asFiniteNumber(value.toolMs)
  const ttftMs = asFiniteNumber(value.ttftMs)
  const ttftSteps = asFiniteNumber(value.ttftSteps)
  const decodeMs = asFiniteNumber(value.decodeMs)
  const decodeTokens = asFiniteNumber(value.decodeTokens)
  if (
    turns === undefined || steps === undefined || llmMs === undefined || toolMs === undefined
    || ttftMs === undefined || ttftSteps === undefined || decodeMs === undefined
    || decodeTokens === undefined
  ) {
    return undefined
  }
  return { turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }
}

function sameBreakdown(
  a: SessionTelemetry['breakdown'] | undefined,
  b: NonNullable<SessionTelemetry['breakdown']>,
): boolean {
  return a !== undefined
    && a.systemTokens === b.systemTokens
    && a.toolsTokens === b.toolsTokens
    && a.messageTokens === b.messageTokens
}

function sameStats(
  a: SessionTelemetry['stats'] | undefined,
  b: NonNullable<SessionTelemetry['stats']>,
): boolean {
  return a !== undefined
    && a.turns === b.turns
    && a.steps === b.steps
    && a.llmMs === b.llmMs
    && a.toolMs === b.toolMs
    && a.ttftMs === b.ttftMs
    && a.ttftSteps === b.ttftSteps
    && a.decodeMs === b.decodeMs
    && a.decodeTokens === b.decodeTokens
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function sameIdSet(a: ReadonlySet<SessionId>, b: ReadonlySet<SessionId>): boolean {
  if (a.size !== b.size) return false
  for (const id of a) {
    if (!b.has(id)) return false
  }
  return true
}
