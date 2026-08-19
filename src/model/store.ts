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
  CallId,
  HistoryEntry,
  HostFrame,
  MuxFrame,
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
  pendingApproval?: PendingApproval
  queue: QueuedInboxItem[]
  /** Unseen activity since the user last focused this session. */
  unread: number
  lastError?: string
}

export interface PendingApproval {
  rpcId: RpcId
  approvalId: ApprovalRequestId
  toolName: string
  callId?: CallId
  reason?: string
  at: number
}

export type StoreChange =
  | { kind: 'sessions' }
  | { kind: 'transcript'; sessionId: SessionId }
  | { kind: 'approval'; sessionId: SessionId }
  | { kind: 'status'; sessionId: SessionId }

export class DeckStore {
  focusedId?: SessionId

  private readonly byId = new Map<SessionId, SessionState>()
  /** Higher-seq-wins cells keyed by `${sessionId}\0${key}`. */
  private readonly projections = new Map<string, { seq: number; value: unknown }>()
  private readonly listeners = new Set<(event: StoreChange) => void>()
  private readonly pending = new Map<string, StoreChange>()
  private scheduled = false

  get sessions(): readonly SessionState[] {
    return [...this.byId.values()]
      .filter((session) => !session.blank)
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
      case 'question/resolved':
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
      default:
        return
    }
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
        queue: prev?.queue ?? [],
        unread: prev?.unread ?? 0,
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
        queue: [],
        unread: session.unread,
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
    const next: SessionState = { ...session, transcript, pendingApproval: pending }
    this.byId.set(frame.sessionId, next)
    this.emit({ kind: 'approval', sessionId: frame.sessionId })
    if (transcript !== session.transcript) this.emit({ kind: 'transcript', sessionId: frame.sessionId })
  }

  private applyApprovalResolved(
    frame: Extract<MuxFrame, { type: 'approval/resolved' }>,
  ): void {
    const session = this.byId.get(frame.sessionId)
    if (session === undefined) return
    const callId = session.pendingApproval?.callId
    const { pendingApproval: _drop, ...rest } = session
    void _drop
    let transcript = rest.transcript
    if (callId !== undefined) {
      const status = frame.outcome === 'allowed-once' ? 'running' : 'cancelled'
      transcript = patchToolStatus(transcript, callId, status)
    }
    const next: SessionState = { ...rest, transcript, queue: rest.queue }
    this.byId.set(frame.sessionId, next)
    this.emit({ kind: 'approval', sessionId: frame.sessionId })
    if (transcript !== session.transcript) this.emit({ kind: 'transcript', sessionId: frame.sessionId })
  }

  private applyProjection(sessionId: SessionId, key: string, value: unknown, seq: number): void {
    if (!key.toLowerCase().includes('title')) return
    const cell = `${sessionId}\0${key}`
    const prev = this.projections.get(cell)
    if (prev !== undefined && seq <= prev.seq) return
    this.projections.set(cell, { seq, value })
    if (typeof value !== 'string') return
    const session = this.ensure(sessionId)
    if (session.title === value) return
    this.byId.set(sessionId, { ...session, title: value })
    this.emit({ kind: 'sessions' })
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
      queue: prev?.queue ?? [],
      unread: prev?.unread ?? 0,
    }
    copyOptional(next, prev, frame)
    this.byId.set(frame.sessionId, next)
    this.emit({ kind: 'sessions' })
  }

  private ensure(id: SessionId): SessionState {
    const existing = this.byId.get(id)
    if (existing !== undefined) return existing
    const created: SessionState = {
      id,
      running: false,
      blank: false,
      updatedAt: 0,
      transcript: emptyTranscript(),
      historyLoaded: false,
      hasMoreHistory: false,
      queue: [],
      unread: 0,
    }
    this.byId.set(id, created)
    this.emit({ kind: 'sessions' })
    return created
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
  src: { cwd?: string; origin?: 'subagent'; parentSessionId?: SessionId; title?: string },
): void {
  if (src.cwd !== undefined) next.cwd = src.cwd
  else if (prev?.cwd !== undefined) next.cwd = prev.cwd
  if (src.origin !== undefined) next.origin = src.origin
  else if (prev?.origin !== undefined) next.origin = prev.origin
  if (src.parentSessionId !== undefined) next.parentSessionId = src.parentSessionId
  else if (prev?.parentSessionId !== undefined) next.parentSessionId = prev.parentSessionId
  if (src.title !== undefined) next.title = src.title
  else if (prev?.title !== undefined) next.title = prev.title
  if (prev?.pendingApproval !== undefined) next.pendingApproval = prev.pendingApproval
  if (prev?.lastError !== undefined) next.lastError = prev.lastError
}
