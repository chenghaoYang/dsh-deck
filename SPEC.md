# Deck — internal build spec

`deck` is a terminal-native multi-agent cockpit for **DeepSeek Harness** (`dsh`).
It attaches to a running `dsh web` host over that host's own `/api` protocol and
renders many concurrent agent sessions on one screen, using terminal
capabilities (Ghostty first) that a browser UI cannot reach.

This file is the contract between modules. Each module is owned by exactly one
implementer. **Do not edit files outside your module.** If you need a change in
someone else's module, state it in your final report instead of editing.

## Non-negotiables

1. **Zero runtime dependencies.** Node >= 22.19. Use global `fetch`,
   global `WebSocket`, `node:*` builtins, `Intl.Segmenter`. No npm deps.
2. **TypeScript, ESM, `.ts` extensions in relative imports** (NodeNext +
   `--experimental-strip-types`). Import as `./foo.ts`, never `./foo`.
3. `tsconfig.json` is strict with `noUncheckedIndexedAccess` and
   `exactOptionalPropertyTypes`. Write code that passes it. `erasableSyntaxOnly`
   is on: **no enums, no parameter properties, no namespaces**.
4. Never crash the process on a malformed frame or a failed RPC. Log and degrade.
5. No `any` unless narrowing immediately. Prefer `unknown` + a type guard.
6. Tests are `node:test` + `node:assert/strict` in `test/*.test.ts`, run with
   `npm test`. No test framework.
7. Comments explain constraints and protocol invariants, not narration.

## Verified facts about the host (do not re-derive)

- Unary call: `POST /api/<method>` with body
  `{"type":"client-request","rpcId":<uuid>,"method":"<method>","payload":{...}}`.
  Response body is `{"type":"server-response","rpcId":<same>,"result":{"ok":true,"value":...}}`
  or `result.ok === false` with `{code,message,details}`. HTTP status describes
  only the carrier; business failures are 200 with `ok:false`.
- Answering a server-request: `POST /api/respond` with
  `{"type":"client-response","rpcId":<the server's rpcId, echoed>,"result":{"ok":true,"value":<payload>}}`.
  Response body is an `RpcReceipt`.
- Downlinks: `ws://host/api/events.mux` and `ws://host/api/events.host`.
  **Downlink-only** — never send application data. Each text message is a
  `ServerRequest` whose `payload` is a `MuxFrame` / `HostFrame`. A plain HTTP GET
  on these paths returns **426**, so there is no SSE fallback over the network.
- Trust fence: the host requires a loopback `Host` header. Node's fetch sends
  the right one for `127.0.0.1`. Do not add auth headers; there is no auth.
- Readiness requires all three: both sockets open **and** `host.describe` ok.
  If either socket ends, the whole connection generation is dead — rebuild both
  and refetch history. `since`-based resume is **unimplemented upstream**; do
  not attempt it.
- `session.history` with no `beforeSeq` returns the **tail** page and includes
  the in-flight partial (chunk events for the last unfinalized message).
  Opening history may attach a cold agent, so it can be slow on first call.
- All types are in `src/protocol/contract.ts` (owned by the integrator,
  read-only for everyone else).

## Module map

| Module | Files | Owner |
|---|---|---|
| Contract | `src/protocol/contract.ts` | integrator (read-only) |
| A. Transport | `src/protocol/client.ts`, `src/protocol/connection.ts`, `src/dev/fake-llm.ts`, `test/client.test.ts`, `test/connection.test.ts` | A |
| B. Model | `src/model/fold.ts`, `src/model/store.ts`, `test/fold.test.ts`, `test/store.test.ts` | B |
| C. Terminal | `src/term/ansi.ts`, `src/term/width.ts`, `src/term/screen.ts`, `src/term/capabilities.ts`, `src/term/ghostty.ts`, `src/term/input.ts`, `test/width.test.ts`, `test/screen.test.ts` | C |
| D. UI | `src/ui/*`, `bin/deck.ts` | integrator |

---

## Module A — Transport

### `src/protocol/client.ts`

```ts
export interface DeckClientOptions {
  /** e.g. "http://127.0.0.1:3080" */ baseUrl: string
  /** bounded unary deadline, default 30_000 */ timeoutMs?: number
}

export class DeckClient {
  constructor(options: DeckClientOptions)
  /** Mints the rpcId, wraps the envelope, verifies the echo, returns the result slot. */
  call<K extends RpcMethodName>(
    method: K, payload: RequestPayload<K>, signal?: AbortSignal,
  ): Promise<RpcResult<ResponseValue<K>>>
  /** Answers a server-request. `rpcId` MUST be the one the host sent. */
  respond(rpcId: RpcId, value: unknown, signal?: AbortSignal): Promise<RpcReceipt>
}
```

- Reject with a *result*, never a throw, for business errors. Transport
  exceptions fold into `{ok:false,error:{code:'internal',...}}` (mirror
  upstream `transportError`).
- Verify `response.rpcId === request.rpcId`; a mismatch is an `internal` error.
- Default timeout via `AbortSignal.timeout`, merged with the caller's signal
  using `AbortSignal.any`.

### `src/protocol/connection.ts`

Owns one connection *generation*: two sockets plus the readiness handshake, with
automatic reconnect and backoff.

```ts
export type ConnectionState = 'connecting' | 'ready' | 'reconnecting' | 'closed'

export interface ConnectionEvents {
  state(state: ConnectionState, detail?: string): void
  /** Host description captured by the handshake that opened this generation. */
  ready(host: HostDescription, generation: number): void
  mux(frame: MuxFrame, rpcId: RpcId): void
  host(frame: HostFrame, rpcId: RpcId): void
  /** Generation lost; the consumer must discard live state and refetch history. */
  lost(reason: string, generation: number): void
}

export class Connection {
  constructor(client: DeckClient, baseUrl: string, events: Partial<ConnectionEvents>)
  start(): void
  close(): void
  get state(): ConnectionState
  get generation(): number
}
```

- Both sockets must be open and `host.describe` must succeed before `ready`.
- Reconnect with jittered exponential backoff, 250ms → 8s cap. Reset on ready.
- A malformed frame is logged and skipped; it must not end the stream.
- `rpcId` must be surfaced to the consumer: answerable frames
  (`approval/requested`, `question/requested`) are answered with it.
- No zod. Validate structurally: reject non-object frames and frames without a
  string `type`; pass the rest through as the union type.

### `src/dev/fake-llm.ts`

A dependency-free OpenAI-compatible `POST /chat/completions` SSE server so the
whole product is testable and demoable with **no API key**. `dsh`'s DeepSeek
adapter calls `${DEEPSEEK_BASE_URL}/chat/completions`.

- CLI: `node src/dev/fake-llm.ts --port 4310 [--scenario <name>]`.
- Emit realistic OpenAI SSE: `data: {...}\n\n` chunks with
  `choices[0].delta.content`, `choices[0].delta.reasoning_content` for thinking,
  `choices[0].delta.tool_calls[]` for tools, a final chunk with `finish_reason`
  and `usage`, then `data: [DONE]\n\n`.
- Scenarios, selected by scanning the incoming `messages` for a keyword so a
  human can drive them by typing a prompt:
  - default: a short reasoning burst, then a few sentences of text, streamed
    token-by-token with ~25ms gaps so streaming is visible.
  - `tools`: emit a `bash` tool call (`{"command":"ls -la"}`) so the approval
    path and tool cards can be exercised, then text after the tool result.
  - `long`: ~200 lines of text, to test scrollback and repaint cost.
  - `slow`: 8s of reasoning before any text, to test the progress indicator.
  - `error`: return HTTP 500 with an OpenAI-shaped error body.
- Respond to `GET /health` with `{"ok":true}`.
- Honor client disconnect (stop emitting when the request aborts).

Report the exact command sequence to run `dsh web` against it.

---

## Module B — Model

### `src/model/fold.ts`

Pure functions turning the durable event log into a renderable transcript. No
I/O, no terminal, no protocol client. This is the most test-heavy module.

```ts
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
  | { kind: 'turn-end'; seq: number; turn: number; reason: string }
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
}

export function emptyTranscript(): TranscriptState
/** Applies one durable event. Pure: returns a new state, mutates nothing. */
export function applyEvent(state: TranscriptState, event: SessionEvent, view?: ToolEventView): TranscriptState
/** Replays a history page (ascending seq). */
export function applyHistory(state: TranscriptState, entries: readonly HistoryEntry[]): TranscriptState
```

Rules, derived from the upstream event vocabulary:

- Ignore any event whose `seq <= state.lastSeq` (idempotent replay; the tail
  page and the live stream overlap).
- `assistant/chunk` carries a `StreamChunk`. Accumulate `text-delta` into the
  current `assistant` item for that `(turn, step, index)` and `reasoning-delta`
  into a `reasoning` item. `tool-call-delta` appends `argumentsDelta` to the
  matching `ToolCallEntry.argumentsRaw`, creating it on first sight.
- `assistant/message` is authoritative: **replace** the accumulated streaming
  text for that `(turn, step)` with the committed message content and set
  `streaming: false`. This is what makes a mid-stream reconnect self-heal.
  Fold `usage` into `state.usage` additively.
- `tool/call` sets status `pending` and fills `name`/`argumentsRaw` verbatim.
- `tool/result` resolves the matching `callId` to `ok`/`error` and extracts a
  short text summary from the result message's content blocks.
- `turn/start` → phase `streaming`, record `turnStartedAt`, set `currentTurn`.
  `turn/end` → append `turn-end` and go `idle`; map
  `reason.kind` to a display string.
- Reasoning arriving with no text yet → phase `thinking`. An outstanding tool
  call → phase `tool`.
- Unknown event types: ignore silently unless `ignorable === false`, in which
  case append a `notice`. Never throw on an unrecognized type — the harness is
  in developer preview and adds event types.

### `src/model/store.ts`

Holds every session's state and reduces protocol frames into it. Still no
terminal and no I/O.

```ts
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

export class DeckStore {
  get sessions(): readonly SessionState[]   // sorted: running first, then updatedAt desc
  get(id: SessionId): SessionState | undefined
  focusedId?: SessionId
  focus(id: SessionId): void

  applyMux(frame: MuxFrame, rpcId: RpcId): void
  applyHost(frame: HostFrame, rpcId: RpcId): void
  applySessionList(items: readonly SessionSummary[]): void
  applyHistoryPage(id: SessionId, entries: readonly HistoryEntry[], hasMore: boolean): void
  /** Called when a connection generation is lost: clears live-only state. */
  resetLiveState(): void

  /** Coalesced change notification; the UI subscribes once and repaints. */
  subscribe(listener: (event: StoreChange) => void): () => void
}

export type StoreChange =
  | { kind: 'sessions' }
  | { kind: 'transcript'; sessionId: SessionId }
  | { kind: 'approval'; sessionId: SessionId }
  | { kind: 'status'; sessionId: SessionId }
```

- Session titles arrive through `session/projection` frames under a title key
  (upstream routes titles through the generic projection pair). Apply
  higher-seq-wins per `(sessionId, key)` and treat a string value as the title.
  Do **not** assume the key name; accept any key containing `title`.
- `unread` increments on transcript activity for a non-focused session and
  resets to 0 on `focus`.
- Hide `blank` sessions from the visible list but keep them addressable —
  upstream reuses a blank session for "new session".
- Notifications must be coalesced (microtask) so a token storm cannot cause one
  repaint per delta.

---

## Module C — Terminal

Rendering primitives and terminal capability handling. **No knowledge of dsh, no
protocol imports.** This module could be published on its own.

### `src/term/width.ts`

```ts
/** Display columns for one grapheme cluster: 0, 1, or 2. */
export function graphemeWidth(cluster: string): number
/** Display columns for a string, grapheme-segmented. */
export function stringWidth(text: string): number
/** Truncate to at most `columns` display columns, appending `ellipsis` if cut. */
export function truncate(text: string, columns: number, ellipsis?: string): string
/** Hard-wrap into lines of at most `columns` columns, breaking at word boundaries when possible. */
export function wrap(text: string, columns: number): string[]
/** Strip ANSI SGR/CSI/OSC sequences. */
export function stripAnsi(text: string): string
```

Correctness bar: CJK ideographs and fullwidth forms are 2 columns; combining
marks and most variation selectors are 0; emoji presentation sequences and
regional-indicator pairs are 2. Use `Intl.Segmenter('en',{granularity:'grapheme'})`
for clustering and a compact range table for East Asian Width. Tests must cover
`"中文"` = 4, `"a\u0301"` = 1, `"👨‍👩‍👧‍👦"` = 2, `"🇯🇵"` = 2, and mixed
CJK/Latin truncation. This user runs a Nerd Font with CJK, so Private Use Area
glyphs (U+E000–U+F8FF, U+F0000+) must be width 1.

### `src/term/ansi.ts`

Pure string builders. No writes.

```ts
export const CSI = '\u001b['
export const OSC = '\u001b]'
export const ST = '\u001b\\'
export function sgr(...codes: (number | string)[]): string
export function fg256(n: number): string
export function bg256(n: number): string
export function rgb(r: number, g: number, b: number): string
export function cursorTo(row: number, col: number): string   // 1-based
export function eraseLine(): string
export function eraseDisplay(): string
export function hideCursor(): string
export function showCursor(): string
export function altScreen(on: boolean): string
export function beginSync(): string   // DECSET 2026
export function endSync(): string
export function hyperlink(uri: string, label: string, id?: string): string  // OSC 8
export function setTitle(text: string): string                              // OSC 0/2
export const RESET: string
```

### `src/term/capabilities.ts`

Detect what the host terminal supports, with an explicit override so the product
never *depends* on detection being right.

```ts
export interface TerminalCapabilities {
  isGhostty: boolean
  termProgram?: string
  termProgramVersion?: string
  trueColor: boolean
  hyperlinks: boolean        // OSC 8
  kittyGraphics: boolean     // APC _G
  notifications: boolean     // OSC 777 / OSC 9
  progress: boolean          // OSC 9;4
  clipboard: boolean         // OSC 52
  syncOutput: boolean        // DECSET 2026
  unicodeCore: boolean       // mode 2027
}
export function detectCapabilities(env?: NodeJS.ProcessEnv): TerminalCapabilities
```

- Ghostty sets `TERM_PROGRAM=ghostty` and `TERM_PROGRAM_VERSION`; `TERM` is
  usually `xterm-ghostty`. Treat those as the primary signal.
- Support `DECK_CAPS` as a comma list to force flags on/off, e.g.
  `DECK_CAPS=+kittyGraphics,-progress`. Also honor `NO_COLOR`.
- Never block startup on a query/response probe: a terminal that does not answer
  must not hang the app. If you implement a DA1/XTGETTCAP probe at all, it must
  be behind a short timeout (<150ms) and purely additive.

### `src/term/screen.ts`

Double-buffered cell renderer. This is what makes streaming cheap: build a
virtual frame, diff against the last one, emit only changed cells.

```ts
export interface Cell { char: string; style: string; width: 1 | 2 }

export class Screen {
  constructor(out: NodeJS.WriteStream, caps: TerminalCapabilities)
  get columns(): number
  get rows(): number
  /** Enter alt screen, hide cursor, install resize + exit handlers. */
  open(): void
  /** Restore the terminal exactly as found. Idempotent; safe from a signal handler. */
  close(): void
  onResize(listener: (columns: number, rows: number) => void): () => void

  /** Start a new virtual frame. */
  begin(): void
  /** Write text at a position with a style; clipped to bounds, wide chars respected. */
  put(row: number, col: number, text: string, style?: string): void
  fill(row: number, col: number, width: number, height: number, char?: string, style?: string): void
  /** Diff and flush, wrapped in synchronized-output markers when supported. */
  end(): void
}
```

- A double-width cell occupies two buffer cells; the second is a continuation
  marker that must never be written independently.
- Always wrap a flush in `beginSync()`/`endSync()` when `caps.syncOutput`.
- `close()` must run on `exit`, `SIGINT`, `SIGTERM`, and on an uncaught
  exception, and must leave the terminal usable (show cursor, leave alt screen,
  reset SGR, clear any progress state). A crash that leaves an invisible cursor
  is a product defect.

### `src/term/ghostty.ts`

The differentiator: terminal features a web UI cannot have. Every function must
be a no-op when the capability is absent.

```ts
export class TerminalIntegration {
  constructor(out: NodeJS.WriteStream, caps: TerminalCapabilities)
  /** OSC 9;4 — taskbar/tab progress. state: 0 clear, 1 set, 2 error, 3 indeterminate. */
  progress(state: 0 | 1 | 2 | 3, percent?: number): void
  /** OSC 777 with an OSC 9 fallback. */
  notify(title: string, body: string): void
  /** OSC 52 clipboard write, base64. */
  copy(text: string): void
  /** OSC 133 semantic marks so the terminal's jump-to-prompt walks agent turns. */
  markPromptStart(): void
  markOutputStart(): void
  markCommandEnd(exitCode?: number): void
  /** OSC 8 link to a file, using an editor URI scheme when configured. */
  fileLink(path: string, line?: number, label?: string): string
  /** Kitty graphics: transmit and place a PNG inline at the cursor. */
  image(png: Uint8Array, opts?: { columns?: number; rows?: number }): string | undefined
  title(text: string): void
  dispose(): void
}
```

Exact sequences — use these, do not invent:

- OSC 9;4 progress: `ESC ] 9 ; 4 ; <state> ; <percent> ESC \`
- OSC 777 notify: `ESC ] 777 ; notify ; <title> ; <body> ESC \`
- OSC 9 notify fallback: `ESC ] 9 ; <body> ESC \`
- OSC 52 copy: `ESC ] 52 ; c ; <base64> ESC \`
- OSC 133: `ESC ] 133 ; A ESC \` (prompt), `; C` (output start), `; D ; <code>` (end)
- OSC 8: `ESC ] 8 ; ; <uri> ESC \ <label> ESC ] 8 ; ; ESC \`
- Kitty graphics, direct PNG transmission: `ESC _ G a=T,f=100,m=<0|1>[,c=<cols>,r=<rows>] ; <base64 chunk> ESC \`
  with chunks of **4096 base64 bytes**, `m=1` on every chunk except the last,
  which uses `m=0`. Only the first chunk carries the control keys.
- Sanitize all OSC payloads: strip `ESC`, `BEL`, and C0 controls from any
  interpolated text. Untrusted model output must never be able to emit its own
  escape sequences through a notification or a title. **Treat this as a security
  requirement**, and test it.

### `src/term/input.ts`

```ts
export type Key =
  | { kind: 'char'; char: string }
  | { kind: 'enter' | 'backspace' | 'tab' | 'escape' | 'up' | 'down' | 'left' | 'right'
      | 'home' | 'end' | 'pageup' | 'pagedown' | 'delete' }
  | { kind: 'ctrl'; char: string }
  | { kind: 'alt'; char: string }
  | { kind: 'paste'; text: string }
  | { kind: 'unknown'; raw: string }

export class InputReader {
  constructor(input: NodeJS.ReadStream)
  start(): void
  stop(): void
  onKey(listener: (key: Key) => void): () => void
}
```

- Raw mode, `setEncoding('utf8')`. Parse CSI arrow/nav keys, `Ctrl+<letter>`,
  `Alt+<letter>` (ESC-prefixed), and **bracketed paste** (`ESC[200~` …
  `ESC[201~`) as a single `paste` key so pasting a big prompt is one event.
- Multi-byte UTF-8 and CJK IME input must survive: buffer partial sequences
  rather than emitting garbage.
- `Ctrl+C` must surface as `{kind:'ctrl',char:'c'}` and not kill the process
  behind the UI's back.

---

---

## Module D — UI widgets

Pure presentation. Widgets never touch the network, never call the store's
mutators, and never write to stdout directly — they draw through a `RenderTarget`
(satisfied by `Screen`). The app shell (`src/ui/app.ts`, `bin/deck.ts`) is owned
by the integrator and is **not** part of this module.

`src/ui/theme.ts` and `src/ui/layout.ts` already exist and are read-only here.

### Shared

```ts
// src/ui/render.ts
export interface RenderTarget {
  put(row: number, col: number, text: string, style?: string): void
  fill(row: number, col: number, width: number, height: number, char?: string, style?: string): void
}
export interface Span { text: string; style: string }
export interface RenderedLine {
  spans: Span[]
  /** Set on the first line of a turn so the shell can emit OSC 133 turn marks. */
  anchor?: { kind: 'turn'; turn: number }
}
/** Paint spans starting at a column, clipping to `width` display columns. */
export function paintLine(target: RenderTarget, row: number, col: number, width: number, line: RenderedLine): void
export function padTo(text: string, columns: number): string
```

### `src/ui/transcript.ts`

The important one. Split layout from paint so scrolling and wrapping are testable.

```ts
export interface TranscriptLayoutOptions {
  width: number
  theme: Theme
  glyphs: Glyphs
  /** Animation tick for the spinner on a streaming item. */
  spinnerFrame: number
  /** Render full tool arguments/results rather than a one-line summary. */
  expandTools: boolean
}
/** Pure: transcript items -> wrapped, styled lines, oldest first. */
export function layoutTranscript(items: readonly TranscriptItem[], options: TranscriptLayoutOptions): RenderedLine[]

export interface TranscriptProps {
  rect: Rect
  lines: readonly RenderedLine[]
  /** Lines scrolled up from the bottom; 0 pins to the newest line. */
  scrollOffset: number
  theme: Theme
}
/** Paints the visible window and returns what the shell needs for the scrollbar. */
export function renderTranscript(target: RenderTarget, props: TranscriptProps): { maxScroll: number; visible: number }
```

Presentation rules:

- `user` items: `▸ ` prefix in the user color, wrapped with a hanging indent.
- `assistant` items: body text in the text color. Render fenced code blocks with
  a subtle left rule and no syntax highlighting (highlighting is out of scope).
- `reasoning` items: dim, prefixed `·`, and **collapsed to the last 3 lines while
  streaming** so a long think does not push the answer off screen. When the item
  is no longer streaming, collapse it to a single dim summary line
  `· thought for N lines` unless `expandTools` is set.
- `tool` items: a card. First line `⚙ <name> <one-line arg summary>`; then status.
  The arg summary is derived per known tool: for `bash` show the `command`, for
  file tools show the path, otherwise show compact JSON, always truncated to the
  available width. Tool result text is shown as at most 6 lines with a
  `… +N more lines` tail unless `expandTools`.
- `tool` items whose status is `awaiting-approval`: highlight in the warn color
  and append the affordance `[a] allow  [r] reject`.
- `turn-end`: a dim full-width rule carrying the reason and, if known, elapsed
  time and token usage.
- `error`: error color, prefixed with the error glyph.
- Streaming items get a trailing spinner glyph from `glyphs.running[spinnerFrame % len]`.
- Set `anchor` on the first line of each turn.

### `src/ui/sidebar.ts`

```ts
export interface SidebarProps {
  rect: Rect
  sessions: readonly SessionState[]
  focusedId: string | undefined
  theme: Theme
  glyphs: Glyphs
  spinnerFrame: number
}
export function renderSidebar(target: RenderTarget, props: SidebarProps): void
```

- One row per session: status glyph, a 1-based index for quick-jump, the title
  (or a dimmed `untitled` / the cwd basename), and an unread badge.
- Status glyph: spinner while running, `○` idle, `✖` on `lastError`, and the
  approval glyph `⚠` in the warn color when `pendingApproval` is set — an
  approval waiting in a background session must be visible without switching to it.
- The focused row is marked with `glyphs.bar` and the selected color.
- Subagent sessions (`origin === 'subagent'`) are indented one column under
  their parent when the parent is present in the list.
- Truncate titles with `truncate()` from `src/term/width.ts`; never split a wide
  character.

### `src/ui/composer.ts`

```ts
export interface ComposerProps {
  rect: Rect
  draft: string
  /** Caret index into `draft`, in code points. */
  cursor: number
  mode: 'queue' | 'steer'
  busy: boolean
  theme: Theme
  glyphs: Glyphs
}
/** Returns the absolute cursor position the shell should park the terminal caret at. */
export function renderComposer(target: RenderTarget, props: ComposerProps): { row: number; col: number }
```

- Soft-wrap the draft across `rect.height` rows; when it overflows, show the tail
  containing the caret.
- Show the mode on the right (`queue ⏎` or `steer ⏎`), dimmed when `busy` is false.
- Correct caret column for CJK: use `stringWidth()` of the text before the caret.

### `src/ui/statusbar.ts`

```ts
export interface HeaderProps {
  rect: Rect
  host: HostDescription | undefined
  connection: 'connecting' | 'ready' | 'reconnecting' | 'closed'
  sessionTitle: string | undefined
  theme: Theme
  glyphs: Glyphs
}
export function renderHeader(target: RenderTarget, props: HeaderProps): void

export interface FooterProps {
  rect: Rect
  hints: readonly { key: string; label: string }[]
  message: { text: string; kind: 'info' | 'warn' | 'error' } | undefined
  theme: Theme
}
export function renderFooter(target: RenderTarget, props: FooterProps): void
```

- Header: product name, host model/provider, connection state as a colored dot,
  and the focused session's title. Degrade gracefully when `host` is undefined.
- Footer: transient message when present, otherwise the key hints, elided from
  the right when the width runs out.

### `src/ui/help.ts`

```ts
export function renderHelp(target: RenderTarget, rect: Rect, theme: Theme, bindings: readonly { keys: string; label: string }[]): void
```

A centered panel with a border, drawn over the body.

### Tests — `test/ui.test.ts`

Use a recording `RenderTarget` that captures `put` calls; assert on content and
positions, not on exact escape bytes.

- No widget ever writes outside its `Rect`. Write a target that throws on an
  out-of-bounds write and run every widget against a 40x10 and a 200x60 viewport.
- `layoutTranscript` wraps CJK text without splitting a wide character and
  without exceeding `width` display columns on any line (assert with
  `stringWidth`).
- A streaming reasoning item longer than 3 lines is collapsed to 3.
- A tool item with `status: 'awaiting-approval'` includes the allow/reject affordance.
- Sidebar shows the approval glyph for a background session with a pending approval.
- Composer caret column is correct after CJK text.

---

## Appendix — vocabulary observed on a live host

Captured from `dsh` 0.1.0-rc.7 by creating a session, prompting it, and recording
both downlinks. Treat this as ground truth over any doc, and note how much of it
is **not** in the published contract: the fold must tolerate unknown event types
by design.

### Durable event types seen in one ordinary turn

```
permission/preset -> sandbox/mode -> approval/policy -> agent/inbox/spliced
  -> turn/start -> agent/inbox/spliced -> step/start -> user/message
  -> session/title -> request/header -> request/context
  -> session/title-llm-request -> assistant/chunk × N
  -> [llm/retry, llm/retry-started on failure]
  -> step/end -> turn/end
```

Beyond the documented set, these are real and must not break the fold:
`permission/preset`, `sandbox/mode`, `approval/policy`, `agent/inbox/spliced`,
`session/title`, `request/context`, `session/title-llm-request`, `llm/retry`,
`llm/retry-started`.

Notable payloads:

- `turn/start`: `{"turn":1}`
- `turn/end` on failure: `{"turn":1,"reason":{"kind":"error","error":{"message":"…","code":"STREAM_CLOSED"}}}`
  — so `FinishReason` carries a **nested** `error` object, and `code` is a
  string like `TRANSPORT` / `STREAM_CLOSED`.
- `request/header`: carries the whole resolved call — `config.provider`,
  `config.model`, `config.maxTokens`, `config.reasoningEffort`,
  `adapterDefaults`, the full `system` prompt, and the tool schemas.
- The host issues a **separate LLM call to title the session**
  (`session/title-llm-request`), so a model backend sees more than one request
  per prompt.
- `llm/retry` fires repeatedly on a failing provider before the turn ends. A
  cockpit should surface "retrying" rather than looking frozen.

### `session/projection` keys (higher-seq-wins per key)

This is the real telemetry surface, and it is a gift for a cockpit header:

| key | value | use |
|---|---|---|
| `title` | `"hello there"` (plain string) | session title — confirms matching on a key containing `title` |
| `sessionListMetadata` | `{blank, lastPromptAt}` | list ordering and the blank bit |
| `sessionStats` | `{turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens}` | time-to-first-token and decode throughput |
| `contextPressure` | `{contextWindow}` | how close the session is to its window |
| `contextBreakdown` | `{systemTokens, toolsTokens, messageTokens}` | what is actually consuming context |
| `subagentTiming` | `{settledMs}` | subagent latency |

`contextBreakdown` on a real turn read `{systemTokens: 1592, toolsTokens: 6409,
messageTokens: 1945}` — the tool schemas cost more than three times the
conversation, which is exactly the kind of thing a supervisor wants to see.

### Other verified behaviour

- `session/queue` arrives with the pending item immediately on `session.prompt`,
  then again as `[]` once the agent claims it.
- `host/session-status` flips `running` true/false around the turn.
- `host/agent-error` carries provider failures with no turn position.
- `user/message` appeared 3× in one turn (surface + inbox bookkeeping), so the
  fold must key user items by `seq` and not assume one per prompt.

## Definition of done, per module

- `npm run typecheck` clean.
- `npm test` passes, with the specific cases named above present.
- Every public symbol in your section exists with the exact name and signature.
- A short report: what you built, what you verified and how, what you could not
  verify, and any change you need in another module.
