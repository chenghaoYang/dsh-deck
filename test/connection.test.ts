import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { after, afterEach, describe, it } from 'node:test'
import { DeckClient } from '../src/protocol/client.ts'
import { Connection, type ConnectionState } from '../src/protocol/connection.ts'
import { HOST_EVENTS_PATH, MUX_EVENTS_PATH, type HostDescription } from '../src/protocol/contract.ts'

const HOST: HostDescription = {
  version: '0.0.1',
  cwd: '/tmp',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  attachedSessions: 0,
  home: '/tmp',
  canOpenPath: true,
}

type WsHandler = (event: unknown) => void

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly url: string
  readyState = FakeWebSocket.CONNECTING
  readonly #listeners = new Map<string, Set<WsHandler>>()

  constructor(url: string) {
    this.url = String(url)
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, handler: WsHandler): void {
    let set = this.#listeners.get(type)
    if (set === undefined) {
      set = new Set()
      this.#listeners.set(type, set)
    }
    set.add(handler)
  }

  removeEventListener(type: string, handler: WsHandler): void {
    this.#listeners.get(type)?.delete(handler)
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.#emit('close', {})
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.#emit('open', {})
  }

  deliver(data: unknown): void {
    this.#emit('message', { data })
  }

  fail(): void {
    this.#emit('error', {})
    this.close()
  }

  #emit(type: string, event: unknown): void {
    for (const handler of [...(this.#listeners.get(type) ?? [])]) handler(event)
  }

  static reset(): void {
    FakeWebSocket.instances = []
  }
}

const originalWebSocket = globalThis.WebSocket

function installFakeWebSocket(): void {
  FakeWebSocket.reset()
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
}

function restoreWebSocket(): void {
  globalThis.WebSocket = originalWebSocket
  FakeWebSocket.reset()
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function startDescribeServer(
  decide: (n: number) => { ok: true; value?: HostDescription } | { ok: false; code?: string; message?: string },
): Promise<{ url: string; close: () => Promise<void> }> {
  let n = 0
  const server = createServer((req, res) => {
    void (async () => {
      const body = await readJson(req)
      n += 1
      const verdict = decide(n)
      assert.ok(isRecord(body))
      if (verdict.ok) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          type: 'server-response',
          rpcId: body.rpcId,
          result: { ok: true, value: verdict.value ?? HOST },
        }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        type: 'server-response',
        rpcId: body.rpcId,
        result: {
          ok: false,
          error: { code: verdict.code ?? 'internal', message: verdict.message ?? 'describe failed', details: {} },
        },
      }))
    })()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose) => {
      server.closeAllConnections()
      server.close(() => resolveClose())
    }),
  }
}

async function waitFor(pred: () => boolean, ms = 2_000, label = 'condition'): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`)
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function byPath(path: string): FakeWebSocket[] {
  return FakeWebSocket.instances.filter((socket) => socket.url.endsWith(path))
}

function envelope(rpcId: string, payload: unknown): string {
  return JSON.stringify({
    type: 'server-request',
    rpcId,
    method: isRecord(payload) && typeof payload.type === 'string' ? payload.type : 'unknown',
    payload,
  })
}

describe('Connection', () => {
  afterEach(() => {
    restoreWebSocket()
  })

  it('start is idempotent and begins in connecting', async () => {
    installFakeWebSocket()
    const { url, close } = await startDescribeServer(() => ({ ok: true }))
    after(() => close())
    const states: ConnectionState[] = []
    const conn = new Connection(new DeckClient({ baseUrl: url }), url, {
      state: (state) => { states.push(state) },
    })
    assert.equal(conn.state, 'closed')
    conn.start()
    conn.start()
    assert.equal(conn.state, 'connecting')
    assert.deepEqual(states, ['connecting'])
    conn.close()
    assert.equal(conn.state, 'closed')
  })

  it('does not emit ready until both sockets are open and host.describe succeeds', async () => {
    installFakeWebSocket()
    const { url, close } = await startDescribeServer(() => ({ ok: true }))
    after(() => close())

    let readyGen = 0
    let readyHost: HostDescription | undefined
    const conn = new Connection(new DeckClient({ baseUrl: url }), url, {
      ready: (host, generation) => {
        readyHost = host
        readyGen = generation
      },
    })
    conn.start()
    await waitFor(() => FakeWebSocket.instances.length === 2, 1_000, 'both sockets constructed')

    const mux = byPath(MUX_EVENTS_PATH)[0]
    const hostSock = byPath(HOST_EVENTS_PATH)[0]
    assert.ok(mux)
    assert.ok(hostSock)
    assert.match(mux.url, /^ws:\/\/127\.0\.0\.1:\d+\/api\/events\.mux$/)
    assert.match(hostSock.url, /^ws:\/\/127\.0\.0\.1:\d+\/api\/events\.host$/)

    mux.open()
    await tick()
    assert.equal(conn.state, 'connecting')
    assert.equal(readyGen, 0)

    hostSock.open()
    await waitFor(() => conn.state === 'ready', 1_000, 'ready after second socket')
    assert.equal(readyGen, 1)
    assert.deepEqual(readyHost, HOST)
    assert.equal(conn.generation, 1)
    conn.close()
  })

  it('does not become ready when host.describe fails, and reconnects', async () => {
    installFakeWebSocket()
    let describes = 0
    const { url, close } = await startDescribeServer(() => {
      describes += 1
      return describes === 1
        ? { ok: false, code: 'internal', message: 'boom' }
        : { ok: true }
    })
    after(() => close())

    const readies: number[] = []
    const losts: Array<{ reason: string; gen: number }> = []
    const conn = new Connection(new DeckClient({ baseUrl: url }), url, {
      ready: (_host, gen) => { readies.push(gen) },
      lost: (reason, gen) => { losts.push({ reason, gen }) },
    })
    conn.start()
    await waitFor(() => FakeWebSocket.instances.length === 2, 1_000, 'gen1 sockets')
    for (const socket of FakeWebSocket.instances) socket.open()
    await waitFor(() => conn.state === 'reconnecting', 1_000, 'reconnecting after describe failure')
    assert.deepEqual(readies, [])
    assert.deepEqual(losts, [])

    await waitFor(() => FakeWebSocket.instances.length === 4, 1_000, 'gen2 sockets after backoff')
    const gen2 = FakeWebSocket.instances.slice(2)
    for (const socket of gen2) socket.open()
    await waitFor(() => conn.state === 'ready', 1_000, 'ready on second generation')
    assert.deepEqual(readies, [2])
    conn.close()
  })

  it('surfaces mux and host frames with their rpcId; skips malformed ones', async () => {
    installFakeWebSocket()
    const { url, close } = await startDescribeServer(() => ({ ok: true }))
    after(() => close())

    const muxFrames: Array<{ type: string; rpcId: string }> = []
    const hostFrames: Array<{ type: string; rpcId: string }> = []
    const errors: unknown[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => { errors.push(args) }
    after(() => { console.error = originalError })

    const conn = new Connection(new DeckClient({ baseUrl: url }), url, {
      mux: (frame, rpcId) => { muxFrames.push({ type: frame.type, rpcId }) },
      host: (frame, rpcId) => { hostFrames.push({ type: frame.type, rpcId }) },
    })
    conn.start()
    await waitFor(() => FakeWebSocket.instances.length === 2, 1_000, 'sockets')
    const mux = byPath(MUX_EVENTS_PATH)[0]
    const hostSock = byPath(HOST_EVENTS_PATH)[0]
    assert.ok(mux)
    assert.ok(hostSock)
    mux.open()
    hostSock.open()
    await waitFor(() => conn.state === 'ready', 1_000, 'ready')

    mux.deliver('not-json')
    mux.deliver(JSON.stringify(['array']))
    mux.deliver(JSON.stringify({ type: 'server-request', rpcId: 'x', method: 'n', payload: 1 }))
    mux.deliver(JSON.stringify({ type: 'server-request', rpcId: 'x', method: 'n', payload: { nope: true } }))
    mux.deliver({ binary: true })
    mux.deliver(envelope('mux-rpc', { type: 'session/subscribed', sessionId: 's1', lastSeq: 3 }))
    hostSock.deliver(envelope('host-rpc', { type: 'host/session-status', sessionId: 's1', running: true }))

    await tick()
    assert.deepEqual(muxFrames, [{ type: 'session/subscribed', rpcId: 'mux-rpc' }])
    assert.deepEqual(hostFrames, [{ type: 'host/session-status', rpcId: 'host-rpc' }])
    assert.ok(errors.length >= 4)
    assert.equal(conn.state, 'ready')
    conn.close()
  })

  it('tears down both sockets, emits lost, and reconnects when either socket closes', async () => {
    installFakeWebSocket()
    const { url, close } = await startDescribeServer(() => ({ ok: true }))
    after(() => close())

    const losts: Array<{ reason: string; gen: number }> = []
    const readies: number[] = []
    const states: ConnectionState[] = []
    const conn = new Connection(new DeckClient({ baseUrl: url }), url, {
      state: (state) => { states.push(state) },
      ready: (_host, gen) => { readies.push(gen) },
      lost: (reason, gen) => { losts.push({ reason, gen }) },
    })
    conn.start()
    await waitFor(() => FakeWebSocket.instances.length === 2, 1_000, 'gen1 sockets')
    for (const socket of FakeWebSocket.instances) socket.open()
    await waitFor(() => conn.state === 'ready', 1_000, 'gen1 ready')

    const mux = byPath(MUX_EVENTS_PATH)[0]
    const hostSock = byPath(HOST_EVENTS_PATH)[0]
    assert.ok(mux)
    assert.ok(hostSock)
    mux.close()
    await waitFor(() => losts.length === 1, 1_000, 'lost after mux close')
    assert.equal(losts[0]?.gen, 1)
    assert.match(losts[0]?.reason ?? '', /mux socket closed/)
    assert.equal(hostSock.readyState, FakeWebSocket.CLOSED)
    await waitFor(() => conn.state === 'reconnecting', 1_000, 'reconnecting')

    await waitFor(() => FakeWebSocket.instances.length === 4, 1_000, 'gen2 sockets')
    for (const socket of FakeWebSocket.instances.slice(2)) socket.open()
    await waitFor(() => conn.state === 'ready' && readies.length === 2, 1_000, 'gen2 ready')
    assert.deepEqual(readies, [1, 2])
    assert.ok(states.includes('reconnecting'))
    conn.close()
  })

  it('treats stream/error as generation death', async () => {
    installFakeWebSocket()
    const { url, close } = await startDescribeServer(() => ({ ok: true }))
    after(() => close())

    const muxSeen: string[] = []
    const losts: string[] = []
    const conn = new Connection(new DeckClient({ baseUrl: url }), url, {
      mux: (frame) => { muxSeen.push(frame.type) },
      lost: (reason) => { losts.push(reason) },
    })
    conn.start()
    await waitFor(() => FakeWebSocket.instances.length === 2, 1_000, 'sockets')
    for (const socket of FakeWebSocket.instances) socket.open()
    await waitFor(() => conn.state === 'ready', 1_000, 'ready')
    const mux = byPath(MUX_EVENTS_PATH)[0]
    assert.ok(mux)
    mux.deliver(envelope('e1', { type: 'stream/error', error: { code: 'internal', message: 'x', details: {} } }))
    await waitFor(() => losts.length === 1, 1_000, 'lost on stream/error')
    assert.deepEqual(muxSeen, [])
    assert.match(losts[0] ?? '', /stream\/error/)
    conn.close()
  })

  it('close stops reconnect and does not emit lost for an intentional shutdown', async () => {
    installFakeWebSocket()
    const { url, close } = await startDescribeServer(() => ({ ok: true }))
    after(() => close())

    const losts: number[] = []
    const conn = new Connection(new DeckClient({ baseUrl: url }), url, {
      lost: (_reason, gen) => { losts.push(gen) },
    })
    conn.start()
    await waitFor(() => FakeWebSocket.instances.length === 2, 1_000, 'sockets')
    for (const socket of FakeWebSocket.instances) socket.open()
    await waitFor(() => conn.state === 'ready', 1_000, 'ready')
    const socketsAtClose = FakeWebSocket.instances.length
    conn.close()
    assert.equal(conn.state, 'closed')
    await new Promise<void>((resolve) => setTimeout(resolve, 400))
    assert.equal(FakeWebSocket.instances.length, socketsAtClose)
    assert.deepEqual(losts, [])
  })

  it('isolates a throwing event handler', async () => {
    installFakeWebSocket()
    const { url, close } = await startDescribeServer(() => ({ ok: true }))
    after(() => close())

    const originalError = console.error
    console.error = () => {}
    after(() => { console.error = originalError })

    const conn = new Connection(new DeckClient({ baseUrl: url }), url, {
      ready: () => { throw new Error('ready sink exploded') },
      mux: () => { throw new Error('mux sink exploded') },
    })
    conn.start()
    await waitFor(() => FakeWebSocket.instances.length === 2, 1_000, 'sockets')
    for (const socket of FakeWebSocket.instances) socket.open()
    await waitFor(() => conn.state === 'ready', 1_000, 'ready despite sink throw')
    const mux = byPath(MUX_EVENTS_PATH)[0]
    assert.ok(mux)
    mux.deliver(envelope('r', { type: 'session/subscribed', sessionId: 's', lastSeq: 0 }))
    await tick()
    assert.equal(conn.state, 'ready')
    conn.close()
  })
})
