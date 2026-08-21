/**
 * Per-run overlay for a PATH harness. Model / provider / effort come from
 * dsh's current selection. Isolated home vars point at a Deck-owned directory.
 * The returned `env` is always a fresh object — never `process.env`.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { specOf, type HarnessId } from './catalog.ts'

export interface ModelSelection {
  provider: string
  model: string
  effort?: string
}

export interface OverlayPlan {
  harness: HarnessId
  argv: readonly string[]
  env: NodeJS.ProcessEnv
  cwd: string
  overlayHome: string
  isolatedHomeVars: readonly string[]
  /** Absolute paths Deck must not write. */
  protectedHomes: readonly string[]
}

export interface OverlayInput {
  harness: HarnessId
  binary: string
  selection: ModelSelection
  overlayHome: string
  env: NodeJS.ProcessEnv
  cwd: string
  /** User home used only to compute protected paths. Default `env.HOME`. */
  userHome?: string
  prompt?: string
}

export function buildHarnessOverlay(input: OverlayInput): OverlayPlan {
  const spec = specOf(input.harness)
  const env = copyEnv(input.env)
  applyDshCredentials(env)
  const overlayHome = input.overlayHome
  for (const key of spec.homeVars) env[key] = overlayHome

  env.DECK_HARNESS = input.harness
  env.DECK_HARNESS_PROVIDER = input.selection.provider
  env.DECK_HARNESS_MODEL = input.selection.model
  if (input.selection.effort !== undefined) env.DECK_HARNESS_EFFORT = input.selection.effort

  applyProviderBridge(input.harness, input.selection, env)
  applyHarnessModelEnv(input.harness, input.selection, env)
  if (input.harness === 'fx') {
    // fx profile state is ~/.fx relative to HOME; FX_HOME is not honored.
    env.HOME = join(overlayHome, 'home')
  }

  const argv = [input.binary, ...invocationFlags(input.harness, input.selection, input.prompt)]
  const userHome = input.userHome ?? envValue(input.env, 'HOME') ?? homedir()
  const protectedHomes = spec.userHomeDirs.map((dir) => join(userHome, dir))

  return {
    harness: input.harness,
    argv,
    env,
    cwd: input.cwd,
    overlayHome,
    isolatedHomeVars: spec.homeVars,
    protectedHomes,
  }
}

/** Create the overlay home. Never touches `protectedHomes`. */
export function prepareOverlayHome(overlayHome: string): void {
  mkdirSync(overlayHome, { recursive: true })
  mkdirSync(join(overlayHome, 'home'), { recursive: true })
}

export interface HarnessTurnResult {
  stdout: string
  stderr: string
  code: number | null
  aborted?: boolean
}

export interface SpawnHarnessOptions {
  /** Injected spawn; tests pass a stub. Default `node:child_process.spawn`. */
  spawnImpl?: typeof spawn
  timeoutMs?: number
  /** Ctrl+C / dashboard stop. Does not assign onto `process.env`. */
  signal?: AbortSignal
}

/**
 * Spawn `plan.argv` with the copied overlay env. Does not assign onto
 * `process.env`. Abort or timeout kills the child; tests use a stub binary.
 */
export function spawnHarnessTurn(
  plan: OverlayPlan,
  options?: SpawnHarnessOptions,
): Promise<HarnessTurnResult> {
  const spawnImpl = options?.spawnImpl ?? spawn
  const timeoutMs = options?.timeoutMs ?? 120_000
  const signal = options?.signal
  const bin = plan.argv[0]
  if (bin === undefined) {
    return Promise.resolve({ stdout: '', stderr: 'harness overlay has no binary', code: 1 })
  }
  if (signal?.aborted === true) {
    return Promise.resolve({ stdout: '', stderr: '', code: null, aborted: true })
  }
  prepareOverlayHome(plan.overlayHome)
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawnImpl(bin, plan.argv.slice(1).map(String), {
      cwd: plan.cwd,
      env: plan.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const abort = (): void => {
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL')
      }, 1_000).unref()
    }
    const onAbort = (): void => {
      abort()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      if (settled) return
      abort()
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted === true) {
        resolve({ stdout, stderr, code, aborted: true })
        return
      }
      resolve({ stdout, stderr, code })
    }
    child.on('error', (error) => {
      stderr = stderr.length > 0 ? `${stderr}\n${error.message}` : error.message
      finish(1)
    })
    child.on('close', (code) => {
      finish(code)
    })
  })
}

/**
 * Transcript text for a completed overlay turn. fx `ask --json` wraps the
 * answer in `{ output }`; other CLIs print the answer as stdout.
 */
export function harnessAssistantText(harness: HarnessId, stdout: string): string {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return ''
  if (harness !== 'fx') return trimmed
  const fromJson = fxAskOutput(trimmed)
  return fromJson.length > 0 ? fromJson : trimmed
}

function fxAskOutput(stdout: string): string {
  const direct = outputField(stdout)
  if (direct !== undefined) return direct
  for (const line of stdout.split('\n')) {
    const piece = outputField(line.trim())
    if (piece !== undefined) return piece
  }
  return ''
}

function outputField(raw: string): string | undefined {
  if (raw.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const output = (parsed as { output?: unknown }).output
    return typeof output === 'string' ? output : undefined
  } catch {
    return undefined
  }
}

function copyEnv(src: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(src)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Point vendor CLIs at dsh's endpoint/key when they speak a compatible API,
 * without writing those values into a product settings file.
 *
 * Volcengine Agent Plan uses two routes on the same key:
 * Claude / Anthropic → https://ark.cn-beijing.volces.com/api/plan
 * OpenAI-compat     → https://ark.cn-beijing.volces.com/api/plan/v3
 *
 * The Plan key is ARK_PLAN_API_KEY (ark-…). A UUID in ARK_API_KEY is the
 * older Volcengine Ark credential (Codex volcark) and 401s against /api/plan.
 */
const DEFAULT_ARK_PLAN = 'https://ark.cn-beijing.volces.com/api/plan'

function applyProviderBridge(
  harness: HarnessId,
  selection: ModelSelection,
  env: NodeJS.ProcessEnv,
): void {
  const deepseekKey = envValue(env, 'DEEPSEEK_API_KEY')
  const deepseekUrl = envValue(env, 'DEEPSEEK_BASE_URL')
  const openaiKey = envValue(env, 'OPENAI_API_KEY')
  const planKey = agentPlanKey(env)
  const planBase = agentPlanBase(env, planKey !== undefined)

  if (harness === 'claudecode') {
    if (envValue(env, 'ANTHROPIC_MODEL') === undefined) env.ANTHROPIC_MODEL = selection.model
    if (envValue(env, 'ANTHROPIC_BASE_URL') === undefined) {
      const claudeUrl = deepseekUrl ?? planBase
      if (claudeUrl !== undefined) env.ANTHROPIC_BASE_URL = claudeUrl
    }
    const token = envValue(env, 'ANTHROPIC_AUTH_TOKEN') ?? envValue(env, 'ANTHROPIC_API_KEY')
    if (token === undefined) {
      const claudeKey = deepseekKey ?? planKey
      if (claudeKey !== undefined) env.ANTHROPIC_AUTH_TOKEN = claudeKey
    }
    return
  }

  if (harness === 'codex' || harness === 'pi' || harness === 'fx' || harness === 'hermes') {
    const usePlan = deepseekKey === undefined && deepseekUrl === undefined
      && planKey !== undefined && planBase !== undefined
    if (usePlan) {
      env.OPENAI_API_KEY = planKey
      env.OPENAI_BASE_URL = `${planBase}/v3`
      return
    }
    if (envValue(env, 'OPENAI_API_KEY') === undefined && (deepseekKey ?? openaiKey) !== undefined) {
      env.OPENAI_API_KEY = deepseekKey ?? openaiKey
    }
    if (envValue(env, 'OPENAI_BASE_URL') === undefined && deepseekUrl !== undefined) {
      env.OPENAI_BASE_URL = deepseekUrl
    }
  }
}

function agentPlanKey(env: NodeJS.ProcessEnv): string | undefined {
  const dedicated = envValue(env, 'ARK_PLAN_API_KEY')
  if (dedicated !== undefined) return dedicated
  const ark = envValue(env, 'ARK_API_KEY')
  if (ark !== undefined && ark.startsWith('ark-')) return ark
  return undefined
}

function agentPlanBase(env: NodeJS.ProcessEnv, hasKey: boolean): string | undefined {
  const raw = envValue(env, 'ARK_PLAN_BASE_URL') ?? (hasKey ? DEFAULT_ARK_PLAN : undefined)
  if (raw === undefined) return undefined
  return raw.replace(/\/+$/, '').replace(/\/v3$/i, '')
}

/**
 * Fill missing env keys from `$DSH_HOME/.credentials.yaml` (or `~/.dsh` under
 * the overlay env's HOME). Never falls back to `os.homedir()`, so tests that
 * omit HOME cannot leak the developer's real keys. Does not overwrite keys
 * already present in the copied env.
 */
function applyDshCredentials(env: NodeJS.ProcessEnv): void {
  const file = credentialsPath(env)
  if (file === undefined) return
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return
  }
  for (const [key, value] of Object.entries(parseCredentialsYaml(text))) {
    if (envValue(env, key) === undefined) env[key] = value
  }
}

function credentialsPath(env: NodeJS.ProcessEnv): string | undefined {
  const dshHome = envValue(env, 'DSH_HOME')
  if (dshHome !== undefined) return join(dshHome, '.credentials.yaml')
  const home = envValue(env, 'HOME')
  if (home !== undefined) return join(home, '.dsh', '.credentials.yaml')
  return undefined
}

function parseCredentialsYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = line.slice(idx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    if (value.length > 0) out[key] = value
  }
  return out
}

function applyHarnessModelEnv(
  harness: HarnessId,
  selection: ModelSelection,
  env: NodeJS.ProcessEnv,
): void {
  switch (harness) {
    case 'hermes':
      env.HERMES_INFERENCE_MODEL = selection.model
      return
    case 'codex':
      return
    case 'claudecode':
      env.ANTHROPIC_MODEL = selection.model
      return
    case 'pi':
      return
    case 'fx':
      env.FX_MODEL = selection.model
      return
    case 'kimicode':
      env.KIMI_MODEL = selection.model
      return
  }
}

function invocationFlags(
  harness: HarnessId,
  selection: ModelSelection,
  prompt: string | undefined,
): string[] {
  const flags = flagsWithoutPrompt(harness, selection)
  if (prompt === undefined) return flags
  return withPrompt(harness, flags, prompt)
}

function flagsWithoutPrompt(harness: HarnessId, selection: ModelSelection): string[] {
  const effort = selection.effort
  switch (harness) {
    case 'hermes': {
      // Do not pass dsh provider ids as --provider; they are not Hermes names.
      const flags = ['--ignore-user-config', '--yolo', '--cli', '-m', selection.model]
      if (effort !== undefined) flags.push('--reasoning', effort)
      return flags
    }
    case 'codex': {
      const flags = ['exec', '--dangerously-bypass-approvals-and-sandbox', '-m', selection.model]
      if (effort !== undefined) flags.push('-c', `model_reasoning_effort=${effort}`)
      return flags
    }
    case 'claudecode': {
      const flags = ['-p', '--dangerously-skip-permissions', '--output-format', 'text', '--model', selection.model]
      if (effort !== undefined) flags.push('--effort', effort)
      return flags
    }
    case 'pi': {
      // Pi has no yolo flag; -p is non-interactive. Omit --provider: dsh ids
      // like deepseek-official are not Pi provider names.
      const flags = ['-p', '--model', selection.model]
      if (effort !== undefined) flags.push('--thinking', effort)
      return flags
    }
    case 'fx':
      return ['ask', '--json', '--yolo']
    case 'kimicode':
      return ['--auto', '-m', selection.model]
  }
}

function withPrompt(harness: HarnessId, flags: string[], prompt: string): string[] {
  switch (harness) {
    case 'hermes':
      return [...flags, '-z', prompt]
    case 'codex':
      return [...flags, prompt]
    case 'claudecode':
      return [...flags, prompt]
    case 'pi':
      return [...flags, prompt]
    case 'fx':
      return [...flags, prompt]
    case 'kimicode':
      return [...flags, '-p', prompt]
  }
}
