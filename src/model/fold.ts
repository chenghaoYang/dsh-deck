/**
 * Pure fold from the durable session event log into a renderable transcript.
 *
 * Streaming accumulation mirrors BlockAssembler index semantics
 * (packages/llm/llm/src/assembler.ts): first-seen `order`, ensure-on-delta,
 * first block-end wins, straggler deltas after close are ignored.
 *
 * Human-visible surface follows isAppendSurfaceEvent
 * (packages/core/session/src/surface.ts): replacement copies (compaction)
 * stay model-only and must not erase conversation the user already saw.
 */

import type {
  AssistantChunkData,
  AssistantMessageData,
  CallId,
  ContentBlock,
  FinishReason,
  HistoryEntry,
  Message,
  SessionEvent,
  StreamChunk,
  TokenUsage,
  ToolCallData,
  ToolEventView,
  ToolResultData,
  TurnEndData,
  TurnStartData,
} from '../protocol/contract.ts'

export type TurnPhase = 'idle' | 'thinking' | 'streaming' | 'tool' | 'done' | 'error'

export interface ToolCallEntry {
  callId: CallId
  name: string
  /** Raw JSON string as the model emitted it; may be partial while streaming. */
  argumentsRaw: string
  /** Parsed lazily; undefined while unparseable. */
  args?: Record<string, unknown>
  status: 'pending' | 'awaiting-approval' | 'running' | 'ok' | 'error' | 'cancelled'
  resultText?: string
  isError?: boolean
  startedAt?: number
  endedAt?: number
}

export type TranscriptItem =
  | { kind: 'user'; seq: number; time: number; text: string }
  | { kind: 'reasoning'; seq: number; turn: number; step: number; text: string; streaming: boolean }
  | { kind: 'assistant'; seq: number; turn: number; step: number; text: string; streaming: boolean }
  | { kind: 'tool'; seq: number; turn: number; step: number; call: ToolCallEntry }
  | { kind: 'image'; seq: number; turn: number; step: number; attachmentId?: string; mediaType?: string; alt: string }
  | { kind: 'turn-end'; seq: number; turn: number; reason: string; elapsedMs?: number; usage?: TokenUsage }
  | { kind: 'error'; seq: number; text: string }
  | { kind: 'notice'; seq: number; text: string }

export interface TranscriptState {
  items: TranscriptItem[]
  lastSeq: number
  phase: TurnPhase
  currentTurn?: number
  usage: TokenUsage
  /** Wall-clock ms the current turn has been running, or undefined when idle. */
  turnStartedAt?: number
  retrying?: { count: number; reason?: string; at: number }
}

/** Per-turn token accumulator. Not part of the public idle-state contract. */
type FoldState = TranscriptState & { turnUsage?: TokenUsage }

/** Types this fold understands. Anything else is unknown / future vocabulary. */
const HANDLED_TYPES = new Set<string>([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'assistant/chunk',
  'assistant/message',
  'tool/call',
  'tool/result',
  'llm/retry',
  'llm/retry-started',
])

/**
 * Block index / closed flags are not part of the public TranscriptItem
 * contract. They ride object identity so tests and the UI see SPEC shapes.
 */
const BLOCK_INDEX = new WeakMap<object, number>()
const BLOCK_CLOSED = new WeakMap<object, true>()

export function emptyTranscript(): TranscriptState {
  return {
    items: [],
    lastSeq: -1,
    phase: 'idle',
    usage: {},
  }
}

/** Applies one durable event. Pure: returns a new state, mutates nothing. */
export function applyEvent(
  state: TranscriptState,
  event: SessionEvent,
  view?: ToolEventView,
): TranscriptState {
  void view
  try {
    return applyEventInner(state, event)
  } catch {
    // Malformed events must never throw or corrupt the transcript.
    if (typeof event.seq === 'number' && event.seq > state.lastSeq) {
      return bumpSeq(state, event.seq)
    }
    return state
  }
}

/** Replays a history page (ascending seq). Overlapping seqs are no-ops. */
export function applyHistory(
  state: TranscriptState,
  entries: readonly HistoryEntry[],
): TranscriptState {
  let current = state
  for (const entry of entries) {
    current = applyEvent(current, entry.event, entry.view)
  }
  return current
}

function applyEventInner(state: TranscriptState, event: SessionEvent): TranscriptState {
  if (typeof event.seq !== 'number' || !Number.isFinite(event.seq) || event.seq <= state.lastSeq) {
    return state
  }

  const type = event.type
  if (!HANDLED_TYPES.has(type)) {
    if (event.ignorable === false) {
      return settle(bumpSeq({
        ...state,
        items: appendItem(state.items, {
          kind: 'notice',
          seq: event.seq,
          text: `Unrecognized event "${type}"`,
        }),
      }, event.seq))
    }
    return bumpSeq(state, event.seq)
  }

  switch (type) {
    case 'turn/start':
      return applyTurnStart(state, event)
    case 'turn/end':
      return applyTurnEnd(state, event)
    case 'step/start':
      return bumpSeq(state, event.seq)
    case 'step/end':
      return bumpSeq(clearRetrying(state), event.seq)
    case 'user/message':
      return applyUserMessage(state, event)
    case 'assistant/chunk':
      return applyAssistantChunk(state, event)
    case 'assistant/message':
      return applyAssistantMessage(state, event)
    case 'tool/call':
      return applyToolCall(state, event)
    case 'tool/result':
      return applyToolResult(state, event)
    case 'llm/retry':
    case 'llm/retry-started':
      return applyRetry(state, event)
    default:
      return bumpSeq(state, event.seq)
  }
}

function applyTurnStart(state: TranscriptState, event: SessionEvent): TranscriptState {
  const data = asRecord(event.data) as TurnStartData | undefined
  const turn = asFiniteNumber(data?.turn)
  const next: FoldState = {
    ...state,
    lastSeq: event.seq,
    phase: 'streaming',
    items: state.items,
    usage: state.usage,
    turnStartedAt: event.time,
    turnUsage: {},
  }
  if (turn !== undefined) next.currentTurn = turn
  return next
}

function applyTurnEnd(state: TranscriptState, event: SessionEvent): TranscriptState {
  const data = asRecord(event.data) as TurnEndData | undefined
  const turn = asFiniteNumber(data?.turn) ?? state.currentTurn ?? 0
  const reason = formatReason(data?.reason)
  const items = state.items.slice()

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item?.kind !== 'tool') continue
    if (item.turn !== turn) continue
    const status = item.call.status
    if (status === 'pending' || status === 'awaiting-approval' || status === 'running') {
      items[i] = tagCopy(item, {
        ...item,
        call: toolEntry({
          ...item.call,
          status: 'cancelled',
          endedAt: event.time,
        }),
      })
    }
  }

  const turnEnd: Extract<TranscriptItem, { kind: 'turn-end' }> = {
    kind: 'turn-end',
    seq: event.seq,
    turn,
    reason,
  }
  if (state.turnStartedAt !== undefined && Number.isFinite(event.time)) {
    turnEnd.elapsedMs = Math.max(0, event.time - state.turnStartedAt)
  }
  const turnOnly = turnUsageOf(state)
  if (hasUsage(turnOnly)) turnEnd.usage = turnOnly
  items.push(turnEnd)
  if (data?.reason?.kind === 'error') {
    items.push({ kind: 'error', seq: event.seq, text: reason })
  }

  // Drop live-only fields — spreading state would keep them and settle()
  // would treat the turn as still live. SPEC: turn/end goes idle.
  const {
    turnStartedAt: _ended,
    retrying: _retry,
    turnUsage: _used,
    ...rest
  } = state as FoldState
  void _ended
  void _retry
  void _used
  const next: TranscriptState = {
    ...rest,
    lastSeq: event.seq,
    items,
    phase: 'idle',
    usage: state.usage,
    currentTurn: turn,
  }
  return next
}

function applyUserMessage(state: TranscriptState, event: SessionEvent): TranscriptState {
  // Replacement copies are model-only (compaction checkpoint). Keep the
  // original append-origin conversation the user already saw.
  if (isReplacementOp(event.surfaceOp)) return bumpSeq(state, event.seq)

  // The harness injects plugin-sourced user-role messages every turn (runtime
  // context snapshots, skills catalogs). They are model food, not conversation:
  // rendering them buries what the human actually typed. MessageSourceMap in
  // upstream packages/llm/llm/src/message.ts: human input is kind 'user';
  // an absent source is tolerated for imported or older logs.
  const data = asRecord(event.data)
  const container = asRecord(data?.message) ?? data
  const sourceKind = asRecord(container?.source)?.kind
  if (typeof sourceKind === 'string' && sourceKind !== 'user') return bumpSeq(state, event.seq)

  const text = messageText(event.data)
  let items = appendItem(state.items, { kind: 'user', seq: event.seq, time: event.time, text })
  const turn = state.currentTurn ?? 0
  for (const block of messageBlocks(event.data)) {
    const image = imageItemFromBlock(event.seq, turn, 0, block)
    if (image !== undefined) items = appendItem(items, image)
  }
  return settle(bumpSeq({ ...state, items }, event.seq))
}

function applyAssistantChunk(state: TranscriptState, event: SessionEvent): TranscriptState {
  state = clearRetrying(state)
  const data = asRecord(event.data) as AssistantChunkData | undefined
  const turn = asFiniteNumber(data?.turn)
  const step = asFiniteNumber(data?.step)
  const chunk = data?.chunk
  if (turn === undefined || step === undefined || !isRecord(chunk) || typeof chunk.type !== 'string') {
    return bumpSeq(state, event.seq)
  }
  state = ensureOpenTurn(state, event, turn)

  switch (chunk.type) {
    case 'block-start':
      return applyBlockStart(state, event, turn, step, chunk)
    case 'text-delta':
    case 'reasoning-delta':
      return applyTextDelta(state, event, turn, step, chunk)
    case 'tool-call-delta':
      return applyToolCallDelta(state, event, turn, step, chunk)
    case 'block-end':
      return applyBlockEnd(state, event, turn, step, chunk)
    case 'usage':
    case 'finish':
      // Usage is folded from the authoritative assistant/message so a chunk
      // plus the committed message cannot double-count. Finish is superseded
      // by turn/end / assistant/message.
      return bumpSeq(state, event.seq)
    default:
      return bumpSeq(state, event.seq)
  }
}

function applyBlockStart(
  state: TranscriptState,
  event: SessionEvent,
  turn: number,
  step: number,
  chunk: StreamChunk & { type: 'block-start' },
): TranscriptState {
  const index = asFiniteNumber(chunk.index)
  if (index === undefined) return bumpSeq(state, event.seq)
  if (findBlock(state.items, turn, step, index) !== -1) {
    return bumpSeq(state, event.seq)
  }
  const item = createEmptyBlock(event.seq, turn, step, index, chunk.blockType)
  if (item === undefined) return bumpSeq(state, event.seq)
  return settle(bumpSeq({ ...state, items: appendItem(state.items, item) }, event.seq))
}

function applyTextDelta(
  state: TranscriptState,
  event: SessionEvent,
  turn: number,
  step: number,
  chunk: StreamChunk & { type: 'text-delta' | 'reasoning-delta' },
): TranscriptState {
  const index = asFiniteNumber(chunk.index)
  const text = typeof chunk.text === 'string' ? chunk.text : ''
  if (index === undefined) return bumpSeq(state, event.seq)

  const kind = chunk.type === 'text-delta' ? 'assistant' : 'reasoning'
  const at = findBlock(state.items, turn, step, index)
  if (at === -1) {
    const created = createEmptyBlock(event.seq, turn, step, index, kind === 'assistant' ? 'text' : 'reasoning')
    if (created === undefined || (created.kind !== 'assistant' && created.kind !== 'reasoning')) {
      return bumpSeq(state, event.seq)
    }
    const filled = tagBlock({ ...created, text, seq: event.seq, streaming: true }, index, false)
    return settle(bumpSeq({ ...state, items: appendItem(state.items, filled) }, event.seq))
  }

  const existing = state.items[at]
  if (existing === undefined || isClosed(existing)) return bumpSeq(state, event.seq)
  if (existing.kind !== 'assistant' && existing.kind !== 'reasoning') {
    return bumpSeq(state, event.seq)
  }

  const updated = tagBlock({
    ...existing,
    kind,
    seq: event.seq,
    text: existing.kind === kind ? existing.text + text : text,
    streaming: true,
  }, index, false)
  return settle(bumpSeq({ ...state, items: replaceAt(state.items, at, updated) }, event.seq))
}

function applyToolCallDelta(
  state: TranscriptState,
  event: SessionEvent,
  turn: number,
  step: number,
  chunk: StreamChunk & { type: 'tool-call-delta' },
): TranscriptState {
  const index = asFiniteNumber(chunk.index)
  if (index === undefined) return bumpSeq(state, event.seq)
  const callId = typeof chunk.id === 'string' ? chunk.id : `call-${index}`
  const delta = typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''

  const at = findBlock(state.items, turn, step, index)
  if (at === -1) {
    const created: TranscriptItem = {
      kind: 'tool',
      seq: event.seq,
      turn,
      step,
      call: toolEntry({
        callId,
        name: typeof chunk.name === 'string' ? chunk.name : '',
        argumentsRaw: delta,
        status: 'pending',
        startedAt: event.time,
      }),
    }
    return settle(bumpSeq({
      ...state,
      items: appendItem(state.items, tagBlock(created, index, false)),
    }, event.seq))
  }

  const existing = state.items[at]
  if (existing === undefined || isClosed(existing) || existing.kind !== 'tool') {
    return bumpSeq(state, event.seq)
  }

  const name = chunk.name ?? existing.call.name
  const updated: TranscriptItem = {
    kind: 'tool',
    seq: event.seq,
    turn,
    step,
    call: toolEntry({
      ...existing.call,
      callId: existing.call.callId || callId,
      ...typeof name === 'string' ? { name } : {},
      argumentsRaw: existing.call.argumentsRaw + delta,
    }),
  }
  return settle(bumpSeq({
    ...state,
    items: replaceAt(state.items, at, tagBlock(updated, index, false)),
  }, event.seq))
}

function applyBlockEnd(
  state: TranscriptState,
  event: SessionEvent,
  turn: number,
  step: number,
  chunk: StreamChunk & { type: 'block-end' },
): TranscriptState {
  const index = asFiniteNumber(chunk.index)
  if (index === undefined) return bumpSeq(state, event.seq)
  const at = findBlock(state.items, turn, step, index)
  const block = chunk.block
  const committed = blockFromContent(event.seq, turn, step, index, block, false)
  if (committed === undefined) {
    if (at !== -1) {
      const existing = state.items[at]
      if (existing !== undefined) {
        return settle(bumpSeq({
          ...state,
          items: replaceAt(state.items, at, tagBlock(existing, index, true)),
        }, event.seq))
      }
    }
    return bumpSeq(state, event.seq)
  }

  if (at === -1) {
    return settle(bumpSeq({
      ...state,
      items: appendItem(state.items, tagBlock(committed, index, true)),
    }, event.seq))
  }

  const existing = state.items[at]
  if (existing !== undefined && isClosed(existing)) return bumpSeq(state, event.seq)

  // First close wins — keep streamed identity (callId) when the committed
  // block is a tool-call that omitted fields.
  let nextItem = committed
  if (existing?.kind === 'tool' && committed.kind === 'tool') {
    nextItem = {
      kind: 'tool',
      seq: event.seq,
      turn,
      step,
      call: toolEntry({
        ...committed.call,
        callId: committed.call.callId || existing.call.callId,
        name: committed.call.name || existing.call.name,
        argumentsRaw: committed.call.argumentsRaw || existing.call.argumentsRaw,
        ...existing.call.startedAt !== undefined ? { startedAt: existing.call.startedAt } : {},
      }),
    }
  }
  return settle(bumpSeq({
    ...state,
    items: replaceAt(state.items, at, tagBlock(nextItem, index, true)),
  }, event.seq))
}

function applyAssistantMessage(state: TranscriptState, event: SessionEvent): TranscriptState {
  state = clearRetrying(state)
  // Model-only replacement copies (compaction) must not rewrite the human
  // transcript. Official UI matches assistant/message only via isAppendSurfaceEvent.
  if (isReplacementOp(event.surfaceOp)) return bumpSeq(state, event.seq)

  const data = asRecord(event.data) as AssistantMessageData | undefined
  const turn = asFiniteNumber(data?.turn)
  const step = asFiniteNumber(data?.step)
  if (turn === undefined || step === undefined || data?.message === undefined) {
    return bumpSeq(state, event.seq)
  }

  state = ensureOpenTurn(state, event, turn)
  const blocks = messageBlocks(data.message)
  // Empty-content assistant/message exists only to host usage
  // (deriveEventMessage in packages/core/session/src/surface.ts).
  const committed: TranscriptItem[] = []
  for (const [index, block] of blocks.entries()) {
    const item = blockFromContent(event.seq, turn, step, index, block, false)
    if (item !== undefined) committed.push(item)
  }

  const items = spliceStepBlocks(state.items, turn, step, committed)
  const next: FoldState = {
    ...state,
    lastSeq: event.seq,
    items,
    usage: data.usage !== undefined ? addUsage(state.usage, data.usage) : state.usage,
  }
  if (data.usage !== undefined) next.turnUsage = addUsage(turnUsageOf(state), data.usage)
  if (state.currentTurn !== undefined) next.currentTurn = state.currentTurn
  if (state.turnStartedAt !== undefined) next.turnStartedAt = state.turnStartedAt
  return settle(next)
}

function applyToolCall(state: TranscriptState, event: SessionEvent): TranscriptState {
  const data = asRecord(event.data) as ToolCallData | undefined
  const callId = typeof data?.callId === 'string' ? data.callId : undefined
  const name = typeof data?.name === 'string' ? data.name : ''
  const argumentsRaw = typeof data?.arguments === 'string' ? data.arguments : ''
  const turn = asFiniteNumber(data?.turn) ?? state.currentTurn ?? 0
  const step = asFiniteNumber(data?.step) ?? 0
  if (callId === undefined) return bumpSeq(state, event.seq)
  state = ensureOpenTurn(state, event, turn)

  const at = findTool(state.items, callId)
  const call = toolEntry({
    callId,
    name,
    argumentsRaw,
    status: 'pending',
    startedAt: event.time,
  })

  if (at === -1) {
    const item: TranscriptItem = { kind: 'tool', seq: event.seq, turn, step, call }
    return settle(bumpSeq({ ...state, items: appendItem(state.items, item) }, event.seq))
  }

  const existing = state.items[at]
  if (existing?.kind !== 'tool') return bumpSeq(state, event.seq)
  const updated: TranscriptItem = {
    kind: 'tool',
    seq: event.seq,
    turn: existing.turn,
    step: existing.step,
    call: toolEntry({
      ...existing.call,
      name: name || existing.call.name,
      argumentsRaw,
      status: existing.call.status === 'ok' || existing.call.status === 'error'
        ? existing.call.status
        : 'pending',
      startedAt: existing.call.startedAt ?? event.time,
    }),
  }
  const index = BLOCK_INDEX.get(existing)
  const closed = isClosed(existing)
  return settle(bumpSeq({
    ...state,
    items: replaceAt(state.items, at, index === undefined ? updated : tagBlock(updated, index, closed)),
  }, event.seq))
}

function applyToolResult(state: TranscriptState, event: SessionEvent): TranscriptState {
  const data = asRecord(event.data) as (ToolResultData & Record<string, unknown>) | undefined
  if (data === undefined) return bumpSeq(state, event.seq)

  const callId = toolResultCallId(data)
  const resultText = toolResultText(data)
  const isError = toolResultIsError(data)
  const turn = asFiniteNumber(data.turn) ?? state.currentTurn ?? 0
  const step = asFiniteNumber(data.step) ?? 0
  if (callId === undefined) return bumpSeq(state, event.seq)

  const at = findTool(state.items, callId)
  const status = isError ? 'error' : 'ok'
  if (at === -1) {
    const item: TranscriptItem = {
      kind: 'tool',
      seq: event.seq,
      turn,
      step,
      call: toolEntry({
        callId,
        name: '',
        argumentsRaw: '',
        status,
        resultText,
        isError,
        endedAt: event.time,
      }),
    }
    return settle(bumpSeq({ ...state, items: appendItem(state.items, item) }, event.seq))
  }

  const existing = state.items[at]
  if (existing?.kind !== 'tool') return bumpSeq(state, event.seq)
  const updated: TranscriptItem = {
    kind: 'tool',
    seq: event.seq,
    turn: existing.turn,
    step: existing.step,
    call: toolEntry({
      ...existing.call,
      status,
      resultText,
      isError,
      endedAt: event.time,
    }),
  }
  const index = BLOCK_INDEX.get(existing)
  return settle(bumpSeq({
    ...state,
    items: replaceAt(state.items, at, index === undefined ? updated : tagBlock(updated, index, true)),
  }, event.seq))
}

function applyRetry(state: TranscriptState, event: SessionEvent): TranscriptState {
  const data = asRecord(event.data)
  const reason = retryReason(data)
  const prev = state.retrying
  const retrying: NonNullable<TranscriptState['retrying']> = {
    count: (prev?.count ?? 0) + 1,
    at: event.time,
  }
  const kept = reason ?? prev?.reason
  if (kept !== undefined) retrying.reason = kept
  return settle(bumpSeq({ ...state, retrying }, event.seq))
}

function createEmptyBlock(
  seq: number,
  turn: number,
  step: number,
  index: number,
  blockType: string,
): TranscriptItem | undefined {
  if (blockType === 'text' || blockType === 'assistant') {
    return tagBlock({ kind: 'assistant', seq, turn, step, text: '', streaming: true }, index, false)
  }
  if (blockType === 'reasoning') {
    return tagBlock({ kind: 'reasoning', seq, turn, step, text: '', streaming: true }, index, false)
  }
  if (blockType === 'tool-call') {
    return tagBlock({
      kind: 'tool',
      seq,
      turn,
      step,
      call: toolEntry({ callId: '', name: '', argumentsRaw: '', status: 'pending' }),
    }, index, false)
  }
  return undefined
}

function blockFromContent(
  seq: number,
  turn: number,
  step: number,
  index: number,
  block: unknown,
  streaming: boolean,
): TranscriptItem | undefined {
  if (!isRecord(block) || typeof block.type !== 'string') return undefined
  if (block.type === 'text' && typeof block.text === 'string') {
    return tagBlock({ kind: 'assistant', seq, turn, step, text: block.text, streaming }, index, !streaming)
  }
  if (block.type === 'reasoning' && typeof block.text === 'string') {
    return tagBlock({ kind: 'reasoning', seq, turn, step, text: block.text, streaming }, index, !streaming)
  }
  if (block.type === 'tool-call') {
    const callId = typeof block.id === 'string' ? block.id : `call-${index}`
    const name = typeof block.name === 'string' ? block.name : ''
    const argumentsRaw = typeof block.arguments === 'string' ? block.arguments : ''
    return tagBlock({
      kind: 'tool',
      seq,
      turn,
      step,
      call: toolEntry({ callId, name, argumentsRaw, status: 'pending' }),
    }, index, !streaming)
  }
  if (block.type === 'image') {
    const image = imageItemFromBlock(seq, turn, step, block)
    return image === undefined ? undefined : tagBlock(image, index, !streaming)
  }
  return undefined
}

/**
 * A history tail page of a long turn may omit `turn/start`. Treat the first
 * in-flight chunk/message/call as opening the turn so phase can leave idle.
 */
function ensureOpenTurn(state: TranscriptState, event: SessionEvent, turn: number): TranscriptState {
  if (state.turnStartedAt !== undefined) {
    if (state.currentTurn === undefined) return { ...state, currentTurn: turn }
    return state
  }
  const next: FoldState = {
    ...state,
    currentTurn: turn,
    turnStartedAt: event.time,
    turnUsage: turnUsageOf(state),
    phase: state.phase === 'idle' ? 'streaming' : state.phase,
  }
  return next
}

function settle(state: TranscriptState): TranscriptState {
  if (state.turnStartedAt === undefined) return state

  let outstanding = false
  let hasReasoning = false
  let hasAssistantText = false
  const turn = state.currentTurn
  for (const item of state.items) {
    if (item.kind === 'tool') {
      const status = item.call.status
      if (status === 'pending' || status === 'awaiting-approval' || status === 'running') {
        outstanding = true
      }
    }
    if (turn !== undefined && 'turn' in item && item.turn !== turn) continue
    if (item.kind === 'reasoning') hasReasoning = true
    if (item.kind === 'assistant' && item.text.length > 0) hasAssistantText = true
  }

  let phase: TurnPhase = 'streaming'
  if (outstanding) phase = 'tool'
  else if (hasReasoning && !hasAssistantText) phase = 'thinking'
  if (phase === state.phase) return state
  return { ...state, phase }
}

function bumpSeq(state: TranscriptState, seq: number): TranscriptState {
  if (state.lastSeq === seq) return state
  return { ...state, lastSeq: seq }
}

function appendItem(items: readonly TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
  return [...items, item]
}

function replaceAt(
  items: readonly TranscriptItem[],
  index: number,
  item: TranscriptItem,
): TranscriptItem[] {
  const next = items.slice()
  next[index] = item
  return next
}

function spliceStepBlocks(
  items: readonly TranscriptItem[],
  turn: number,
  step: number,
  replacements: readonly TranscriptItem[],
): TranscriptItem[] {
  const next: TranscriptItem[] = []
  let placed = false
  for (const item of items) {
    if (isStepBlock(item, turn, step)) {
      if (!placed) {
        next.push(...replacements)
        placed = true
      }
    } else {
      next.push(item)
    }
  }
  if (!placed) next.push(...replacements)
  return next
}

function isStepBlock(item: TranscriptItem, turn: number, step: number): boolean {
  return (item.kind === 'reasoning' || item.kind === 'assistant' || item.kind === 'tool' || item.kind === 'image')
    && item.turn === turn
    && item.step === step
}

function findBlock(items: readonly TranscriptItem[], turn: number, step: number, index: number): number {
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item === undefined || !isStepBlock(item, turn, step)) continue
    if (BLOCK_INDEX.get(item) === index) return i
  }
  return -1
}

function findTool(items: readonly TranscriptItem[], callId: string): number {
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item?.kind === 'tool' && item.call.callId === callId) return i
  }
  return -1
}

function tagBlock(item: TranscriptItem, index: number, closed: boolean): TranscriptItem {
  BLOCK_INDEX.set(item, index)
  if (closed) BLOCK_CLOSED.set(item, true)
  return item
}

function tagCopy(from: TranscriptItem, to: TranscriptItem): TranscriptItem {
  const index = BLOCK_INDEX.get(from)
  if (index !== undefined) BLOCK_INDEX.set(to, index)
  if (BLOCK_CLOSED.has(from)) BLOCK_CLOSED.set(to, true)
  return to
}

function isClosed(item: TranscriptItem): boolean {
  return BLOCK_CLOSED.has(item)
}

function toolEntry(partial: ToolCallEntry): ToolCallEntry {
  const args = parseArgs(partial.argumentsRaw)
  const entry: ToolCallEntry = {
    callId: partial.callId,
    name: partial.name,
    argumentsRaw: partial.argumentsRaw,
    status: partial.status,
  }
  if (args !== undefined) entry.args = args
  if (partial.resultText !== undefined) entry.resultText = partial.resultText
  if (partial.isError !== undefined) entry.isError = partial.isError
  if (partial.startedAt !== undefined) entry.startedAt = partial.startedAt
  if (partial.endedAt !== undefined) entry.endedAt = partial.endedAt
  return entry
}

/** Lazy parse. Mid-stream fragments are often invalid JSON; never throw. */
function parseArgs(raw: string): Record<string, unknown> | undefined {
  if (raw === '') return undefined
  try {
    const value: unknown = JSON.parse(raw)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch {
    // arguments is a raw JSON string; partial fragments stay unparsed.
  }
  return undefined
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const keys = [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
  ] as const
  const out: TokenUsage = {}
  for (const key of keys) {
    const value = (a[key] ?? 0) + (b[key] ?? 0)
    if (value !== 0) out[key] = value
  }
  return out
}

function formatReason(reason: FinishReason | unknown): string {
  const rec = asRecord(reason)
  if (rec === undefined) return 'unknown'
  const kind = typeof rec.kind === 'string' ? rec.kind : 'unknown'
  if (kind === 'error') {
    const error = asRecord(rec.error)
    if (typeof error?.message === 'string' && error.message !== '') return `error: ${error.message}`
    if (typeof rec.message === 'string' && rec.message !== '') return `error: ${rec.message}`
  }
  return kind
}

/**
 * Replacement surfaceOp — compaction and other model-only copies.
 * Absent or `'append'` is the human-visible path.
 */
function isReplacementOp(value: unknown): boolean {
  if (value === undefined || value === 'append') return false
  if (!isRecord(value)) return false
  return value.op === 'replace'
}

function messageBlocks(message: Message | unknown): ContentBlock[] {
  const rec = asRecord(message)
  if (rec === undefined) return []
  const content = rec.content
  if (typeof content === 'string') {
    return content === '' ? [] : [{ type: 'text', text: content }]
  }
  if (!Array.isArray(content)) return []
  const blocks: ContentBlock[] = []
  for (const block of content) {
    if (isRecord(block) && typeof block.type === 'string') {
      blocks.push(block as ContentBlock)
    }
  }
  return blocks
}

function messageText(data: unknown): string {
  const rec = asRecord(data)
  if (rec === undefined) return ''
  if (typeof rec.content === 'string' || Array.isArray(rec.content)) {
    return contentToText(rec.content)
  }
  if (typeof rec.text === 'string') return rec.text
  return contentToText(rec)
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block.type === 'tool-result') {
      const inner = contentToText(block.content)
      if (inner !== '') parts.push(inner)
    }
  }
  return parts.join('')
}

function toolResultCallId(data: Record<string, unknown>): string | undefined {
  const message = asRecord(data.message)
  if (message !== undefined) {
    const source = asRecord(message.source)
    if (typeof source?.callId === 'string') return source.callId
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isRecord(block) && typeof block.toolCallId === 'string') return block.toolCallId
      }
    }
  }
  if (typeof data.callId === 'string') return data.callId
  return undefined
}

function toolResultText(data: Record<string, unknown>): string {
  const message = asRecord(data.message)
  if (message === undefined) return ''
  return contentToText(message.content)
}

function toolResultIsError(data: Record<string, unknown>): boolean {
  if (data.error !== undefined && data.error !== null) return true
  const message = asRecord(data.message)
  if (message === undefined || !Array.isArray(message.content)) return false
  for (const block of message.content) {
    if (isRecord(block) && block.type === 'tool-result' && block.isError === true) return true
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function clearRetrying(state: TranscriptState): TranscriptState {
  if (state.retrying === undefined) return state
  const { retrying: _drop, ...rest } = state
  void _drop
  return rest
}

function retryReason(data: Record<string, unknown> | undefined): string | undefined {
  if (data === undefined) return undefined
  const failure = asRecord(data.failure)
  if (typeof failure?.code === 'string' && failure.code !== '') return failure.code
  if (typeof failure?.message === 'string' && failure.message !== '') return failure.message
  if (typeof data.code === 'string' && data.code !== '') return data.code
  return undefined
}

function turnUsageOf(state: TranscriptState): TokenUsage {
  return (state as FoldState).turnUsage ?? {}
}

function hasUsage(usage: TokenUsage): boolean {
  return usage.inputTokens !== undefined
    || usage.outputTokens !== undefined
    || usage.cacheReadTokens !== undefined
    || usage.cacheWriteTokens !== undefined
    || usage.reasoningTokens !== undefined
}

function imageItemFromBlock(
  seq: number,
  turn: number,
  step: number,
  block: unknown,
): Extract<TranscriptItem, { kind: 'image' }> | undefined {
  if (!isRecord(block) || block.type !== 'image') return undefined
  const attachment = asRecord(block.attachment)
  const attachmentId = firstString(
    attachment?.attachmentId,
    attachment?.id,
    block.attachmentId,
  )
  const mediaType = firstString(
    attachment?.mediaType,
    block.mediaType,
    block.mimeType,
  )
  const item: Extract<TranscriptItem, { kind: 'image' }> = {
    kind: 'image',
    seq,
    turn,
    step,
    alt: imageAlt(mediaType),
  }
  if (attachmentId !== undefined) item.attachmentId = attachmentId
  if (mediaType !== undefined) item.mediaType = mediaType
  return item
}

function firstString(...candidates: unknown[]): string | undefined {
  for (const value of candidates) {
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

function imageAlt(mediaType: string | undefined): string {
  if (mediaType === undefined) return 'image'
  const slash = mediaType.lastIndexOf('/')
  const raw = slash >= 0 ? mediaType.slice(slash + 1) : mediaType
  const subtype = raw.split('+')[0]
  return subtype !== undefined && subtype !== '' ? `image (${subtype})` : 'image'
}
