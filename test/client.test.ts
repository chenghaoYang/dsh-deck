import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { after, describe, it } from 'node:test'
import { DeckClient } from '../src/protocol/client.ts'
import { API_PATH, RESPOND_PATH } from '../src/protocol/contract.ts'

interface Captured {
  method: string
  url: string
  body: unknown
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

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse, captured: Captured[]) => Promise<void> | void,
): Promise<{ url: string; captured: Captured[]; close: () => Promise<void> }> {
  const captured: Captured[] = []
  const hanging: ServerResponse[] = []
  const server = createServer((req, res) => {
    void (async () => {
      try {
        await handler(req, res, captured)
      } catch (error) {
        if (!res.headersSent) {
          res.writeHead(500)
          res.end(String(error))
        }
      }
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
    captured,
    close: () => new Promise((resolveClose) => {
      for (const res of hanging) res.destroy()
      server.closeAllConnections()
      server.close(() => resolveClose())
    }),
    // expose hanging list via closure on handler by assigning to captured? keep local
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

describe('DeckClient.call', () => {
  it('mints rpcId, posts the envelope, verifies the echo, and returns the value', async () => {
    const captured: Captured[] = []
    const { url, close } = await listen(async (req, res, bag) => {
      const body = await readJson(req)
      bag.push({ method: req.method ?? '', url: req.url ?? '', body })
      captured.push(bag[bag.length - 1] as Captured)
      assert.ok(isRecord(body))
      json(res, 200, {
        type: 'server-response',
        rpcId: body.rpcId,
        result: {
          ok: true,
          value: {
            version: '0.0.1',
            cwd: '/tmp',
            provider: 'deepseek-official',
            model: 'deepseek-v4-flash',
            attachedSessions: 0,
            home: '/tmp',
            canOpenPath: true,
          },
        },
      })
    })
    after(() => close())

    const client = new DeckClient({ baseUrl: url })
    const result = await client.call('host.describe', {})
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value.version, '0.0.1')
    assert.equal(result.value.model, 'deepseek-v4-flash')

    const req = captured[0]
    assert.ok(req)
    assert.equal(req.method, 'POST')
    assert.equal(req.url, `${API_PATH}/host.describe`)
    assert.ok(isRecord(req.body))
    assert.equal(req.body.type, 'client-request')
    assert.equal(req.body.method, 'host.describe')
    assert.equal(typeof req.body.rpcId, 'string')
    assert.deepEqual(req.body.payload, {})
  })

  it('returns a business error as a result and never throws', async () => {
    const { url, close } = await listen(async (req, res) => {
      const body = await readJson(req)
      assert.ok(isRecord(body))
      json(res, 200, {
        type: 'server-response',
        rpcId: body.rpcId,
        result: {
          ok: false,
          error: { code: 'session-not-found', message: 'missing', details: { sessionId: 's1' } },
        },
      })
    })
    after(() => close())

    const client = new DeckClient({ baseUrl: url })
    const result = await client.call('session.cancel', { sessionId: 's1' })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error.code, 'session-not-found')
    assert.equal(result.error.message, 'missing')
    assert.deepEqual(result.error.details, { sessionId: 's1' })
  })

  it('treats an rpcId mismatch as an internal error', async () => {
    const { url, close } = await listen(async (_req, res) => {
      json(res, 200, {
        type: 'server-response',
        rpcId: 'not-the-request-id',
        result: { ok: true, value: { items: [] } },
      })
    })
    after(() => close())

    const client = new DeckClient({ baseUrl: url })
    const result = await client.call('session.list', {})
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error.code, 'internal')
    assert.match(result.error.message, /rpcId mismatch/)
  })

  it('folds HTTP carrier failures into {ok:false, code:internal}', async () => {
    const { url, close } = await listen((_req, res) => {
      res.writeHead(502)
      res.end('bad gateway')
    })
    after(() => close())

    const client = new DeckClient({ baseUrl: url })
    const result = await client.call('session.list', {})
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error.code, 'internal')
    assert.match(result.error.message, /HTTP 502/)
  })

  it('folds a refused connection into an internal error', async () => {
    const client = new DeckClient({ baseUrl: 'http://127.0.0.1:1' })
    const result = await client.call('host.describe', {})
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error.code, 'internal')
  })

  it('folds a malformed envelope into an internal error', async () => {
    const { url, close } = await listen((_req, res) => {
      json(res, 200, { nope: true })
    })
    after(() => close())

    const client = new DeckClient({ baseUrl: url })
    const result = await client.call('session.list', {})
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error.code, 'internal')
    assert.match(result.error.message, /malformed/)
  })

  it('times out via AbortSignal.timeout and folds the abort', async () => {
    const { url, close } = await listen((req) => {
      req.resume()
    })
    after(() => close())

    const client = new DeckClient({ baseUrl: url, timeoutMs: 40 })
    const result = await client.call('host.describe', {})
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error.code, 'internal')
  })

  it('honors a caller AbortSignal merged with the deadline', async () => {
    const { url, close } = await listen((req) => {
      req.resume()
    })
    after(() => close())

    const client = new DeckClient({ baseUrl: url, timeoutMs: 30_000 })
    const result = await client.call('host.describe', {}, AbortSignal.abort(new Error('caller-cancel')))
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error.code, 'internal')
    assert.match(result.error.message, /caller-cancel/)
  })
})

describe('DeckClient.respond', () => {
  it('POSTs /api/respond echoing the server rpcId', async () => {
    const captured: Captured[] = []
    const { url, close } = await listen(async (req, res) => {
      const body = await readJson(req)
      captured.push({ method: req.method ?? '', url: req.url ?? '', body })
      json(res, 200, { accepted: true })
    })
    after(() => close())

    const client = new DeckClient({ baseUrl: url })
    const receipt = await client.respond('server-rpc-1', { outcome: 'allowed-once' })
    assert.deepEqual(receipt, { accepted: true })
    const req = captured[0]
    assert.ok(req)
    assert.equal(req.url, RESPOND_PATH)
    assert.ok(isRecord(req.body))
    assert.equal(req.body.type, 'client-response')
    assert.equal(req.body.rpcId, 'server-rpc-1')
    assert.deepEqual(req.body.result, { ok: true, value: { outcome: 'allowed-once' } })
  })

  it('passes through not-pending and maps transport failure to bad-response', async () => {
    let n = 0
    const { url, close } = await listen(async (req, res) => {
      await readJson(req)
      n += 1
      if (n === 1) json(res, 200, { accepted: false, reason: 'not-pending' })
      else {
        res.writeHead(500)
        res.end('nope')
      }
    })
    after(() => close())

    const client = new DeckClient({ baseUrl: url })
    assert.deepEqual(await client.respond('r1', {}), { accepted: false, reason: 'not-pending' })
    assert.deepEqual(await client.respond('r2', {}), { accepted: false, reason: 'bad-response' })
  })
})
