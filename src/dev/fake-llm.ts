/**
 * Dependency-free OpenAI-compatible SSE stand-in for dsh's DeepSeek adapter.
 * The adapter POSTs to `${DEEPSEEK_BASE_URL}/chat/completions` with
 * `stream: true` and translates `delta.content` / `delta.reasoning_content` /
 * `delta.tool_calls[]`. An empty initial `reasoning_content` must not open a
 * reasoning block (upstream translate.ts).
 *
 * Point a host at this process:
 *   DEEPSEEK_BASE_URL=http://127.0.0.1:4310 DEEPSEEK_API_KEY=fake \
 *     dsh web --no-open --port 3081
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export type FakeLlmScenario = 'default' | 'tools' | 'long' | 'slow' | 'error' | 'escalate' | 'ask'

const SCENARIOS: readonly FakeLlmScenario[] = ['default', 'tools', 'long', 'slow', 'error', 'escalate', 'ask']
const TOKEN_GAP_MS = 25
const SLOW_REASONING_MS = 8_000
const TOOL_ARGS = JSON.stringify({ command: 'ls -la', description: 'List all files' })

/** bash schema: sandbox_permissions ∈ {workspace-write, danger-full-access}; default mode is workspace-write so only danger-full-access is strictly wider. */
export const ESCALATE_SANDBOX_PERMISSIONS = 'danger-full-access'
export const ESCALATE_JUSTIFICATION = 'Need full access to retry a command the workspace-write sandbox would deny outside the workspace.'
export const ESCALATE_ARGS = JSON.stringify({
  command: 'echo escalated-outside-workspace',
  description: 'Echo after sandbox escalation',
  sandbox_permissions: ESCALATE_SANDBOX_PERMISSIONS,
  justification: ESCALATE_JUSTIFICATION,
})

/** Model-facing ask_user_question args (multi_select is the schema name; mux frames use multiSelect). */
export const ASK_QUESTION_ID = 'q_proceed'
export const ASK_OPTION_CONTINUE = 'Continue'
export const ASK_OPTION_STOP = 'Stop'
export const ASK_ARGS = JSON.stringify({
  questions: [{
    id: ASK_QUESTION_ID,
    question: 'Should the agent continue after this checkpoint?',
    header: 'Confirm',
    options: [
      { label: ASK_OPTION_CONTINUE, description: 'Proceed with the remaining work.' },
      { label: ASK_OPTION_STOP, description: 'Stop here and wait.' },
    ],
    multi_select: false,
  }],
})

const DEFAULT_REASONING = 'The user sent a short prompt. I will answer directly without tools.'
const DEFAULT_TEXT = [
  'This is a streamed reply from the deck fake-llm.',
  'It exists so the cockpit can be developed without a real API key.',
  'Tokens arrive one by one so the mux path stays visible.',
].join(' ')

const AFTER_TOOL_TEXT = 'Listed the working directory. The bash tool call completed; here is a short wrap-up.'
const AFTER_ESCALATE_TEXT = 'The escalation completed. The bash call finished after the approval decision.'
const AFTER_ASK_TEXT = 'Received the user answer from ask_user_question and can continue.'
const TITLE_TEXT = 'fake-llm session title'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isScenario(value: string): value is FakeLlmScenario {
  return (SCENARIOS as readonly string[]).includes(value)
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (typeof part === 'string') parts.push(part)
    else if (isRecord(part) && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join(' ')
}

function flattenUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return ''
  const parts: string[] = []
  for (const message of messages) {
    if (isRecord(message) && message.role === 'user') parts.push(flattenContent(message.content))
  }
  return parts.join('\n')
}

function hasToolResult(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false
  return messages.some((message) => isRecord(message) && message.role === 'tool')
}

function extractToolMessages(messages: unknown): unknown[] {
  if (!Array.isArray(messages)) return []
  return messages.filter((message) => isRecord(message) && message.role === 'tool')
}

/** Auxiliary title calls embed the human prompt as JSON; they must never emit tools. */
function isTitleRequest(messages: unknown): boolean {
  const text = flattenUserText(messages)
  return text.includes('Generate the session title from this JSON array of human messages')
}

/**
 * Drive scenarios from the latest human prompt, not the whole history.
 * dsh injects user-role snapshots (runtime context, workspace reminders, title
 * framing) that contain words like "ask" and would steal keyword detection.
 */
function isInjectedUserText(text: string): boolean {
  return text.includes('<system-reminder>')
    || text.includes('Current runtime context. This snapshot supersedes')
    || text.includes('Generate the session title from this JSON array of human messages')
}

function lastHumanPrompt(messages: unknown): string {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!isRecord(message) || message.role !== 'user') continue
    const text = flattenContent(message.content)
    if (isInjectedUserText(text)) continue
    return text
  }
  return ''
}

/** Keywords in the prompt override the CLI default so a human can drive scenarios. */
function detectScenario(messages: unknown, fallback: FakeLlmScenario): FakeLlmScenario {
  const text = lastHumanPrompt(messages).toLowerCase()
  const order: FakeLlmScenario[] = ['error', 'slow', 'long', 'escalate', 'tools', 'ask']
  for (const name of order) {
    if (new RegExp(`\\b${name}\\b`).test(text)) return name
  }
  return fallback
}

function tokenize(text: string): string[] {
  return text.match(/\s+|\S+/g) ?? [text]
}

function chunk(id: string, model: string, created: number, delta: Record<string, unknown>, finish: string | null, usage?: Record<string, unknown>): string {
  const choice: Record<string, unknown> = { index: 0, delta, finish_reason: finish }
  const body: Record<string, unknown> = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [choice],
  }
  if (usage !== undefined) body.usage = usage
  return `data: ${JSON.stringify(body)}\n\n`
}

function usageOf(promptTokens: number, completionTokens: number, reasoningTokens: number): Record<string, unknown> {
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: promptTokens,
    completion_tokens_details: { reasoning_tokens: reasoningTokens },
  }
}

async function pause(ms: number, cancelled: () => boolean): Promise<boolean> {
  if (ms <= 0) return !cancelled()
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cancelled()) return false
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(25, end - Date.now()))
    })
  }
  return !cancelled()
}

function emit(response: ServerResponse, cancelled: () => boolean, data: string): boolean {
  if (cancelled() || response.destroyed || !response.writable) return false
  return response.write(data)
}

async function streamReasoningThenText(
  response: ServerResponse,
  cancelled: () => boolean,
  id: string,
  model: string,
  created: number,
  reasoning: string,
  text: string,
  gapMs: number,
): Promise<void> {
  // DeepSeek's first thinking-mode chunk carries empty reasoning_content;
  // translate.ts must not open a block on it.
  if (!emit(response, cancelled, chunk(id, model, created, {
    role: 'assistant',
    content: null,
    reasoning_content: '',
  }, null))) return

  let completion = 0
  for (const token of tokenize(reasoning)) {
    if (!await pause(gapMs, cancelled)) return
    if (!emit(response, cancelled, chunk(id, model, created, {
      content: null,
      reasoning_content: token,
    }, null))) return
    completion += 1
  }

  for (const token of tokenize(text)) {
    if (!await pause(gapMs, cancelled)) return
    if (!emit(response, cancelled, chunk(id, model, created, { content: token }, null))) return
    completion += 1
  }

  const finish = chunk(id, model, created, { content: '' }, 'stop', usageOf(24, completion, tokenize(reasoning).length))
  if (!emit(response, cancelled, finish)) return
  emit(response, cancelled, 'data: [DONE]\n\n')
}

async function streamTitle(
  response: ServerResponse,
  cancelled: () => boolean,
  id: string,
  model: string,
  created: number,
): Promise<void> {
  if (!emit(response, cancelled, chunk(id, model, created, {
    role: 'assistant',
    content: TITLE_TEXT,
  }, null))) return
  if (!emit(response, cancelled, chunk(id, model, created, { content: '' }, 'stop', usageOf(8, 1, 0)))) return
  emit(response, cancelled, 'data: [DONE]\n\n')
}

async function streamNamedToolCall(
  response: ServerResponse,
  cancelled: () => boolean,
  id: string,
  model: string,
  created: number,
  toolName: string,
  argsJson: string,
  callId: string,
  reasoning: string,
): Promise<void> {
  if (!emit(response, cancelled, chunk(id, model, created, {
    role: 'assistant',
    content: null,
    reasoning_content: '',
  }, null))) return

  for (const token of tokenize(reasoning)) {
    if (!await pause(TOKEN_GAP_MS, cancelled)) return
    if (!emit(response, cancelled, chunk(id, model, created, {
      content: null,
      reasoning_content: token,
    }, null))) return
  }

  const mid = Math.max(1, Math.floor(argsJson.length / 2))
  if (!await pause(TOKEN_GAP_MS, cancelled)) return
  if (!emit(response, cancelled, chunk(id, model, created, {
    tool_calls: [{
      index: 0,
      id: callId,
      type: 'function',
      function: { name: toolName, arguments: argsJson.slice(0, mid) },
    }],
  }, null))) return
  if (!await pause(TOKEN_GAP_MS, cancelled)) return
  if (!emit(response, cancelled, chunk(id, model, created, {
    tool_calls: [{ index: 0, function: { arguments: argsJson.slice(mid) } }],
  }, null))) return
  if (!emit(response, cancelled, chunk(id, model, created, { content: '' }, 'tool_calls', usageOf(48, 8, tokenize(reasoning).length)))) return
  emit(response, cancelled, 'data: [DONE]\n\n')
}

async function streamSlow(
  response: ServerResponse,
  cancelled: () => boolean,
  id: string,
  model: string,
  created: number,
): Promise<void> {
  const reasoning = 'Still thinking through the request, taking care not to rush the answer. '
  const tokens = tokenize(reasoning.repeat(4).trim())
  const gap = Math.max(TOKEN_GAP_MS, Math.floor(SLOW_REASONING_MS / Math.max(1, tokens.length)))
  await streamReasoningThenText(
    response,
    cancelled,
    id,
    model,
    created,
    tokens.join(''),
    'Done thinking. Here is the delayed answer from the fake-llm.',
    gap,
  )
}

function longText(): string {
  const lines: string[] = []
  for (let i = 1; i <= 200; i += 1) {
    lines.push(`Line ${i}: The quick brown fox jumps over the lazy dog.`)
  }
  return lines.join('\n')
}

async function runScenario(
  scenario: FakeLlmScenario,
  messages: unknown,
  response: ServerResponse,
  cancelled: () => boolean,
): Promise<void> {
  const id = `chatcmpl-fake-${crypto.randomUUID()}`
  const model = 'deepseek-v4-flash'
  const created = Math.floor(Date.now() / 1000)

  if (scenario === 'error') {
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      error: { message: 'fake-llm scenario=error', type: 'server_error', code: 'internal_error' },
    }))
    return
  }

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  response.flushHeaders()

  if (scenario === 'tools' && !hasToolResult(messages)) {
    await streamNamedToolCall(
      response, cancelled, id, model, created,
      'bash', TOOL_ARGS, 'call_fake_bash',
      'I will list the working directory with bash.',
    )
    return
  }
  if (scenario === 'tools') {
    await streamReasoningThenText(response, cancelled, id, model, created, 'The tool result is in. I will summarize.', AFTER_TOOL_TEXT, TOKEN_GAP_MS)
    return
  }
  if (scenario === 'escalate' && !hasToolResult(messages)) {
    await streamNamedToolCall(
      response, cancelled, id, model, created,
      'bash', ESCALATE_ARGS, 'call_fake_escalate',
      'The sandbox will deny an out-of-workspace write. I will escalate bash to danger-full-access.',
    )
    return
  }
  if (scenario === 'escalate') {
    await streamReasoningThenText(response, cancelled, id, model, created, 'The escalation tool result is in.', AFTER_ESCALATE_TEXT, TOKEN_GAP_MS)
    return
  }
  if (scenario === 'ask' && !hasToolResult(messages)) {
    await streamNamedToolCall(
      response, cancelled, id, model, created,
      'ask_user_question', ASK_ARGS, 'call_fake_ask',
      'I need a user choice before continuing, so I will ask.',
    )
    return
  }
  if (scenario === 'ask') {
    const toolText = JSON.stringify(extractToolMessages(messages))
    console.error(`[fake-llm] ask follow-up received tool result: ${toolText}`)
    await streamReasoningThenText(response, cancelled, id, model, created, 'The user answered the question.', AFTER_ASK_TEXT, TOKEN_GAP_MS)
    return
  }
  if (scenario === 'long') {
    await streamReasoningThenText(response, cancelled, id, model, created, 'Producing a long scrollback fixture.', longText(), TOKEN_GAP_MS)
    return
  }
  if (scenario === 'slow') {
    await streamSlow(response, cancelled, id, model, created)
    return
  }
  await streamReasoningThenText(response, cancelled, id, model, created, DEFAULT_REASONING, DEFAULT_TEXT, TOKEN_GAP_MS)
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export interface FakeLlmRequestInfo {
  scenario: FakeLlmScenario | 'title'
  hasToolResult: boolean
  messages: unknown
  body: unknown
}

export interface FakeLlmServer {
  readonly port: number
  readonly url: string
  close(): Promise<void>
}

export async function startFakeLlm(options: {
  port?: number
  scenario?: FakeLlmScenario
  onRequest?: (info: FakeLlmRequestInfo) => void
}): Promise<FakeLlmServer> {
  const fallback = options.scenario ?? 'default'
  const server = createServer((request, response) => {
    void handle(request, response, fallback, options.onRequest)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 4310, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  const port = address !== null && typeof address === 'object' ? address.port : options.port ?? 4310
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolveClose) => {
      server.closeAllConnections()
      server.close(() => resolveClose())
    }),
  }
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  fallback: FakeLlmScenario,
  onRequest?: (info: FakeLlmRequestInfo) => void,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (request.method === 'GET' && url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true }))
    return
  }
  if (request.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
    response.writeHead(request.method === 'POST' ? 404 : 405, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'not found', type: 'invalid_request_error', code: 'not_found' } }))
    return
  }

  // Only the response close is a client abort. IncomingMessage 'close' also
  // fires after the POST body is fully read — treating that as cancel drops
  // [DONE] and the DeepSeek adapter raises STREAM_CLOSED.
  let cancelled = false
  request.once('aborted', () => { cancelled = true })
  response.once('close', () => {
    if (!response.writableFinished) cancelled = true
  })

  let body: unknown
  try {
    body = JSON.parse(await readBody(request)) as unknown
  } catch {
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      error: { message: 'request body must be valid JSON', type: 'invalid_request_error', code: 'invalid_json' },
    }))
    return
  }

  const messages = isRecord(body) ? body.messages : undefined
  if (isTitleRequest(messages)) {
    console.error(`[fake-llm] ${url.pathname} scenario=title`)
    onRequest?.({ scenario: 'title', hasToolResult: false, messages, body })
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    response.flushHeaders()
    const id = `chatcmpl-fake-${crypto.randomUUID()}`
    const model = 'deepseek-v4-flash'
    const created = Math.floor(Date.now() / 1000)
    try {
      await streamTitle(response, () => cancelled || response.destroyed, id, model, created)
    } catch (error) {
      console.error('[fake-llm] title handler failed:', error)
    }
    if (!response.writableEnded) response.end()
    return
  }
  const scenario = detectScenario(messages, fallback)
  const toolFollowUp = hasToolResult(messages)
  console.error(`[fake-llm] ${url.pathname} scenario=${scenario}${toolFollowUp ? ' follow-up' : ''}`)
  if (toolFollowUp) {
    console.error(`[fake-llm] follow-up tool messages: ${JSON.stringify(extractToolMessages(messages))}`)
  }
  onRequest?.({ scenario, hasToolResult: toolFollowUp, messages, body })
  try {
    await runScenario(scenario, messages, response, () => cancelled || response.destroyed)
  } catch (error) {
    console.error('[fake-llm] handler failed:', error)
    if (!response.headersSent) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        error: { message: 'fake-llm handler failed', type: 'server_error', code: 'internal_error' },
      }))
      return
    }
  }
  if (!response.writableEnded) response.end()
}

function isMain(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return import.meta.url === pathToFileURL(resolve(entry)).href
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '4310' },
      scenario: { type: 'string', default: 'default' },
    },
    strict: true,
  })
  const port = Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('fake-llm: --port must be an integer 0..65535')
    process.exitCode = 1
    return
  }
  const scenarioRaw = values.scenario ?? 'default'
  if (!isScenario(scenarioRaw)) {
    console.error(`fake-llm: unknown --scenario ${scenarioRaw} (expected ${SCENARIOS.join('|')})`)
    process.exitCode = 1
    return
  }
  const server = await startFakeLlm({ port, scenario: scenarioRaw })
  console.error(`[fake-llm] listening on ${server.url} (default scenario=${scenarioRaw})`)
  console.error('[fake-llm] attach a dsh host with:')
  console.error(`  DEEPSEEK_BASE_URL=${server.url} DEEPSEEK_API_KEY=fake dsh web --no-open --port 3081`)
  const shutdown = (): void => {
    void server.close().then(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

if (isMain()) {
  void main()
}
