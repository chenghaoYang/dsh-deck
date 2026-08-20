/**
 * CLI entry.
 *
 * Deck is a client, so it needs a `dsh` host. Requiring the user to run one in
 * another window is the kind of friction that kills a terminal tool, so by
 * default Deck adopts a host that is already listening and otherwise starts one
 * itself and takes responsibility for stopping it again.
 */

import { spawn } from 'node:child_process'
import { createWriteStream, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeckApp } from './ui/app.ts'

/** Source runs from src/, the published build from lib/src/ — probe both. */
function packageVersion(): string {
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const parsed = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as { name?: string; version?: string }
      if (parsed.name === 'dsh-deck' && typeof parsed.version === 'string') return parsed.version
    } catch {
      // keep probing
    }
  }
  return 'unknown'
}

const DEFAULT_PORT = 3080
const HOST_START_TIMEOUT_MS = 90_000
const PROBE_INTERVAL_MS = 400

interface Args {
  attach: string | undefined
  port: number
  cwd: string
  printOnExit: boolean
  spawnHost: boolean
  help: boolean
  version: boolean
}

const USAGE = `deck — a terminal-native multi-agent cockpit for DeepSeek Harness

usage: deck [options]

options:
  --attach <url>     use a host already listening at <url> (default: http://127.0.0.1:${DEFAULT_PORT})
  --port <n>         port to probe, and to start a host on (default: ${DEFAULT_PORT})
  --cwd <dir>        working directory for sessions Deck creates (default: current directory)
  --no-spawn         never start a host; fail if none is reachable
  --no-print         do not write a transcript to the scrollback on exit
  -h, --help         show this help
  -v, --version      show the version

environment:
  DECK_CAPS          force terminal capabilities, e.g. +kittyGraphics,-progress
  DECK_THEME=plain   16-color theme for terminals without truecolor
  DECK_ASCII=1       ASCII glyphs instead of Nerd Font glyphs
  NO_COLOR           disable color entirely

Deck talks to the host over its own /api protocol, the same one \`dsh web\` serves.
To drive it without any API key, run the bundled fake model server:
  npm run fake-llm -- --port 4310
  DEEPSEEK_BASE_URL=http://127.0.0.1:4310 DEEPSEEK_API_KEY=fake dsh web --no-open --port ${DEFAULT_PORT}
`

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    attach: undefined,
    port: DEFAULT_PORT,
    cwd: process.cwd(),
    printOnExit: true,
    spawnHost: true,
    help: false,
    version: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--attach': {
        const value = argv[i + 1]
        if (value === undefined) throw new Error('--attach needs a url')
        args.attach = value
        i += 1
        break
      }
      case '--port': {
        const value = argv[i + 1]
        const port = Number(value)
        if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`--port needs a valid port, got ${String(value)}`)
        args.port = port
        i += 1
        break
      }
      case '--cwd': {
        const value = argv[i + 1]
        if (value === undefined) throw new Error('--cwd needs a directory')
        args.cwd = value
        i += 1
        break
      }
      case '--no-print': args.printOnExit = false; break
      case '--no-spawn': args.spawnHost = false; break
      case '-h': case '--help': args.help = true; break
      case '-v': case '--version': args.version = true; break
      default:
        if (arg !== undefined && arg.startsWith('-')) throw new Error(`unknown option ${arg}`)
    }
  }
  return args
}

/** A host is usable when it answers host.describe, not merely when the port is open. */
async function probeHost(baseUrl: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const response = await fetch(new URL('/api/host.describe', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'host.describe', payload: {} }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return false
    const body = (await response.json()) as { result?: { ok?: boolean } }
    return body.result?.ok === true
  } catch {
    return false
  }
}

interface SpawnedHost {
  stop(): void
  logPath: string
}

async function startHost(port: number, cwd: string): Promise<SpawnedHost> {
  const logPath = join(tmpdir(), `deck-dsh-${String(port)}.log`)
  const log = createWriteStream(logPath, { flags: 'a' })
  const child = spawn('dsh', ['web', '--no-open', '--port', String(port)], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
  child.stdout.pipe(log)
  child.stderr.pipe(log)

  let exited = false
  let exitInfo = ''
  child.on('exit', (code, signal) => {
    exited = true
    exitInfo = `dsh exited with code ${String(code)}${signal === null ? '' : ` (${signal})`}`
  })
  child.on('error', (error) => {
    exited = true
    exitInfo = error.message
  })

  const baseUrl = `http://127.0.0.1:${String(port)}`
  const deadline = Date.now() + HOST_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (exited) throw new Error(`${exitInfo}. See ${logPath}`)
    if (await probeHost(baseUrl, 1500)) {
      return {
        logPath,
        stop: () => {
          if (!exited) child.kill('SIGTERM')
        },
      }
    }
    await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS))
  }
  child.kill('SIGTERM')
  throw new Error(`dsh did not become ready within ${String(HOST_START_TIMEOUT_MS / 1000)}s. See ${logPath}`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { process.stdout.write(USAGE); return }
  if (args.version) { process.stdout.write(`dsh-deck ${packageVersion()}\n`); return }

  const baseUrl = args.attach ?? `http://127.0.0.1:${String(args.port)}`
  let spawned: SpawnedHost | undefined

  if (!(await probeHost(baseUrl))) {
    if (args.attach !== undefined) {
      process.stderr.write(`deck: no dsh host answering at ${baseUrl}\n`)
      process.exitCode = 1
      return
    }
    if (!args.spawnHost) {
      process.stderr.write(`deck: no dsh host at ${baseUrl} and --no-spawn was given\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(`deck: starting a dsh host on port ${String(args.port)}…\n`)
    try {
      spawned = await startHost(args.port, args.cwd)
    } catch (error) {
      process.stderr.write(`deck: ${error instanceof Error ? error.message : String(error)}\n`)
      process.stderr.write('deck: is `dsh` installed? try `npm i -g @deepseek-ai/dsh`\n')
      process.exitCode = 1
      return
    }
  }

  const app = new DeckApp({
    baseUrl,
    cwd: args.cwd,
    printOnExit: args.printOnExit,
  })

  try {
    await app.start()
  } finally {
    spawned?.stop()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`deck: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
