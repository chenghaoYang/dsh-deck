import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'src', 'cli.ts')

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  const port = address.port
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error === undefined ? resolveClose() : rejectClose(error)))
  return port
}

async function hostAnswers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/host.describe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'host.describe', payload: {} }),
      signal: AbortSignal.timeout(300),
    })
    return response.ok
  } catch {
    return false
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50))
  }
  return false
}

function fakeDshScript(markerPath: string, pidPath: string): string {
  return `#!/usr/bin/env node
const { createServer } = require('node:http')
const { writeFileSync } = require('node:fs')

const portAt = process.argv.indexOf('--port')
const port = Number(process.argv[portAt + 1])
const marker = ${JSON.stringify(markerPath)}
const pidFile = ${JSON.stringify(pidPath)}
writeFileSync(pidFile, String(process.pid))

const server = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  if (request.method === 'POST' && request.url === '/api/host.describe') {
    let rpcId = ''
    try { rpcId = JSON.parse(body).rpcId ?? '' } catch {}
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      type: 'server-response',
      rpcId,
      result: { ok: true, value: {
        version: 'test', cwd: process.cwd(), provider: 'test', model: 'test',
        attachedSessions: 0, home: process.cwd(), canOpenPath: false,
      } },
    }))
    return
  }
  response.statusCode = 404
  response.end()
})
server.on('upgrade', (_request, socket) => {
  socket.on('error', () => {})
  socket.end('HTTP/1.1 426 Upgrade Required\\r\\n\\r\\n')
})
server.listen(port, '127.0.0.1')

function shutdown(signal) {
  writeFileSync(marker, signal)
  server.closeAllConnections?.()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}
process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGHUP', () => shutdown('SIGHUP'))
`
}

function childClosed(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode, signal: null })
  return new Promise((resolveClose) => child.once('close', (code, signal) => resolveClose({ code, signal })))
}

function killPidFile(pidPath: string): void {
  try {
    const pid = Number(readFileSync(pidPath, 'utf8'))
    if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) process.kill(pid, 'SIGKILL')
  } catch {
    // The host already exited, or the test process is shutting down.
  }
}

async function runSignalCase(signal: 'SIGTERM' | 'SIGHUP'): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'deck-cli-signal-'))
  const fakeBin = join(root, 'bin')
  mkdirSync(fakeBin)
  const markerPath = join(root, 'stopped')
  const pidPath = join(root, 'host.pid')
  const fakeDsh = join(fakeBin, 'dsh')
  writeFileSync(fakeDsh, fakeDshScript(markerPath, pidPath), { mode: 0o755 })
  chmodSync(fakeDsh, 0o755)
  const port = await freePort()
  const envPath = [fakeBin, process.env.PATH ?? ''].filter((part) => part.length > 0).join(':')
  const child = spawn(process.execPath, [
    '--experimental-strip-types', CLI,
    '--port', String(port), '--cwd', root, '--no-print',
  ], {
    cwd: ROOT,
    env: { ...process.env, PATH: envPath, TERM: 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => { stdout += chunk })
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => { stderr += chunk })

  try {
    assert.equal(await waitFor(() => hostAnswers(port), 10_000), true, `fake dsh never became ready: ${stderr}`)
    assert.equal(await waitFor(async () => stdout.includes('\u001b[?1049h'), 10_000), true, `deck never opened its screen: ${stdout}`)

    child.kill(signal)
    const closed = await Promise.race([
      childClosed(child),
      new Promise<undefined>((resolveTimeout) => setTimeout(() => resolveTimeout(undefined), 5_000)),
    ])
    assert.ok(closed !== undefined, `deck did not exit after ${signal}`)
    assert.equal(closed.signal, null)
    assert.equal(closed.code, signal === 'SIGTERM' ? 143 : 129)
    assert.equal(await waitFor(async () => !(await hostAnswers(port)), 5_000), true, `${signal} left fake dsh listening`)
    assert.equal(await waitFor(async () => existsSync(markerPath), 2_000), true, `${signal} never reached fake dsh`)
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    killPidFile(pidPath)
  }
}

describe('CLI spawned-host lifecycle', () => {
  for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
    it(`stops an auto-started host on ${signal}`, async () => {
      await runSignalCase(signal)
    })
  }
})
