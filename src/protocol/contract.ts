/**
 * The subset of the DeepSeek Harness Host `/api` contract that Deck consumes.
 *
 * Hand-mirrored from dsh 0.1.0-rc.7/rc.8 rather than imported: the upstream
 * types live behind `@deepseek-ai/dsh-host-apiproxy` subpath exports that drag
 * cordis and zod in, and Deck must run against a host it did not build. Every
 * shape here was verified against a live `dsh web` host.
 *
 * Upstream sources:
 *   packages/host/apiproxy/src/api/rpc.ts       — four-quadrant envelopes
 *   packages/host/apiproxy/src/api/events.ts    — MuxFrame / HostFrame
 *   packages/host/apiproxy/src/api/sessions.ts  — session.* payloads
 *   packages/host/apiproxy/src/api/approvals.ts — approval answer payload
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export type SessionId = string
export type RpcId = string
export type CallId = string
export type MessageId = string
export type ApprovalRequestId = string

// ---------------------------------------------------------------------------
// Envelopes. Unary is POST /api/<method>; answers to server-requests are POST
// /api/respond and MUST echo the server's rpcId rather than minting a new one.
// ---------------------------------------------------------------------------

export interface ClientRequest {
  type: 'client-request'
  rpcId: RpcId
  method: string
  payload: unknown
}

export interface ServerResponse {
  type: 'server-response'
  rpcId: RpcId
  result: RpcResult<unknown>
}

export interface ServerRequest {
  type: 'server-request'
  rpcId: RpcId
  method: string
  payload: unknown
}

export interface ClientResponse {
  type: 'client-response'
  rpcId: RpcId
  result: RpcResult<unknown>
}

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }

export interface RpcError {
  code: string
  message: string
  details: unknown
}

/** HTTP body of the POST carrying a client-response. Not an RpcMessage. */
export type RpcReceipt = { accepted: true } | { accepted: false; reason: 'not-pending' | 'bad-response' }

// ---------------------------------------------------------------------------
// Model content. `arguments` on a tool call is a raw JSON string, not an
// object — the harness never parses it on the model's behalf.
// ---------------------------------------------------------------------------

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'image'; [k: string]: unknown }
  | { type: 'tool-call'; id: CallId; name: string; arguments: string }
  | { type: 'tool-result'; [k: string]: unknown }

export interface Message {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: ContentBlock[] | string
  [k: string]: unknown
}

export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason }

/** Disjoint by contract: billed input is inputTokens + cacheRead + cacheWrite. */
export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface FinishReason {
  kind: 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error' | string
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// Durable session events. `seq` equals the event's index in the log, so
// higher-seq-wins is a total order per session.
// ---------------------------------------------------------------------------

export interface SessionEvent {
  type: string
  seq: number
  time: number
  data: unknown
  ignorable?: boolean
  surfaceOp?: unknown
  sourceEventSeqs?: number[]
}

export interface TurnStartData { turn: number }
export interface TurnEndData { turn: number; reason: FinishReason }
export interface StepData { turn: number; step: number }
export interface AssistantChunkData { turn: number; step: number; chunk: StreamChunk }
export interface AssistantMessageData {
  turn: number
  step: number
  message: Message
  usage?: TokenUsage
  interrupted?: boolean
}
export interface ToolCallData { turn: number; step: number; callId: CallId; name: string; arguments: string }
export interface ToolResultData {
  turn: number
  step: number
  message: Message
  error?: unknown
  meta?: unknown
}
export interface UserMessageData { [k: string]: unknown }

/** Host-computed render intent riding a tool event. Never persisted. */
export type ToolEventView =
  | { for: 'call'; view: Record<string, unknown> }
  | { for: 'result'; view: Record<string, unknown> }

// ---------------------------------------------------------------------------
// Downlink frames. Both streams are WebSocket-only and downlink-only: the
// client sends no application data over them, and a plain GET answers 426.
// ---------------------------------------------------------------------------

export type MuxFrame =
  | { type: 'session/event'; sessionId: SessionId; event: SessionEvent; view?: ToolEventView }
  | { type: 'session/subscribed'; sessionId: SessionId; lastSeq: number }
  | {
    type: 'approval/requested'
    sessionId: SessionId
    approvalId: ApprovalRequestId
    toolName: string
    callId?: CallId
    reason?: string
  }
  | { type: 'approval/resolved'; sessionId: SessionId; approvalId: ApprovalRequestId; outcome: ApprovalOutcome }
  | { type: 'question/requested'; sessionId: SessionId; questions: unknown[] }
  | { type: 'question/resolved'; sessionId: SessionId; questionRpcId: RpcId; outcome: 'answered' | 'cancelled' }
  | { type: 'session/queue'; sessionId: SessionId; items: QueuedInboxItem[] }
  | { type: 'session/jobs'; sessionId: SessionId; jobs: unknown[] }
  | { type: 'session/projection'; sessionId: SessionId; key: string; value: unknown; seq: number }
  | { type: 'stream/error'; error: RpcError }

export type HostFrame =
  | {
    type: 'host/session-added'
    sessionId: SessionId
    blank: boolean
    parentSessionId?: SessionId
    origin?: 'subagent'
    cwd?: string
    agentPreset?: string
  }
  | { type: 'host/session-removed'; sessionId: SessionId }
  | { type: 'host/session-status'; sessionId: SessionId; running: boolean }
  | { type: 'host/agent-error'; sessionId: SessionId; message: string }
  | { type: 'host/workspace-changed'; workspace: unknown }
  | { type: 'host/workspace-removed'; workspaceId: string }
  | { type: 'host/workspace-order-changed'; workspaceIds: string[] }
  | { type: 'host/archived-sessions-changed'; archivedSessionIds: SessionId[] }
  | { type: 'host/remote-event'; event: string; args: unknown[] }
  | { type: 'stream/error'; error: RpcError }

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface QueuedInboxItem {
  id: MessageId
  placement: 'queued' | 'steering' | 'context'
  message: Message
}

// ---------------------------------------------------------------------------
// Unary method payloads and values, keyed by wire method name.
// ---------------------------------------------------------------------------

export interface SessionSummary {
  sessionId: SessionId
  updatedAt: number
  running: boolean
  /** True while no turn has ever run. Clients hide these and reuse them for "new session". */
  blank: boolean
  parentSessionId?: SessionId
  origin?: 'subagent'
  cwd?: string
  agentPreset?: string
}

export interface HistoryEntry {
  event: SessionEvent
  view?: ToolEventView
}

export type PromptContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string; name?: string }

export interface HostDescription {
  version: string
  cwd: string
  provider: string
  model: string
  attachedSessions: number
  home: string
  canOpenPath: boolean
}

export interface ApprovalResponsePayload {
  sessionId: SessionId
  approvalId: ApprovalRequestId
  outcome: 'allowed-once' | 'rejected'
}

/**
 * Method table. Deck deliberately implements a subset; the full map lives at
 * packages/host/apiproxy/src/api/rpc-map.ts upstream.
 */
export interface RpcMethods {
  'host.describe': { payload: {}; value: HostDescription }
  'session.list': { payload: { cursor?: string }; value: { items: SessionSummary[] } }
  'session.create': {
    payload: { cwd?: string; sessionId?: SessionId; agentPreset?: string }
    value: { sessionId: SessionId; agentPreset?: string }
  }
  'session.history': {
    payload: { sessionId: SessionId; beforeSeq?: number; maxMessages?: number }
    value: { events: HistoryEntry[]; hasMore: boolean; projections?: { asOfSeq: number; values: Record<string, unknown> } }
  }
  'session.prompt': {
    payload: { sessionId: SessionId; mode: 'queue' | 'steer'; content: PromptContentPart[]; clientTimeZone?: string }
    value: { accepted: true; command?: { kind: 'success'; text?: string } }
  }
  'session.cancel': { payload: { sessionId: SessionId }; value: { accepted: true } }
  'session.rename': { payload: { sessionId: SessionId; title: string }; value: { title: string; seq: number } }
  'session.fork': { payload: { sessionId: SessionId; atSeq?: number }; value: { sessionId: SessionId } }
  'session.models': { payload: { sessionId: SessionId }; value: unknown }
  'session.updateQueue': { payload: { sessionId: SessionId; itemId: MessageId; action: unknown }; value: { accepted: true } }
}

export type RpcMethodName = keyof RpcMethods
export type RequestPayload<K extends RpcMethodName> = RpcMethods[K]['payload']
export type ResponseValue<K extends RpcMethodName> = RpcMethods[K]['value']

// ---------------------------------------------------------------------------
// Wire paths
// ---------------------------------------------------------------------------

export const API_PATH = '/api'
export const RESPOND_PATH = '/api/respond'
export const MUX_EVENTS_PATH = '/api/events.mux'
export const HOST_EVENTS_PATH = '/api/events.host'
