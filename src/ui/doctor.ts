/**
 * Structured /doctor health report. Pure: env is `input.env ?? {}`, never
 * `process.env`. No DA1 probes — only caps, host, and env flags.
 */

import type { TerminalCapabilities } from '../term/capabilities.ts'
import type { HostDescription } from '../protocol/contract.ts'

export type DoctorStatus = 'ok' | 'warn' | 'off'

export interface DoctorFinding {
  name: string
  status: DoctorStatus
  detail: string
}

export interface DoctorInput {
  caps: TerminalCapabilities
  host?: HostDescription
  env?: NodeJS.ProcessEnv
  mouseEnabled: boolean
  nodeVersion: string
  platform: string
  isTTY: boolean
  cwd: string
  /** How copy currently routes; from the app (e.g. 'pbcopy' / 'osc52' / 'wl-copy'). */
  clipboardRoute?: string
}

const MIN_NODE: readonly [number, number, number] = [22, 19, 0]

const KNOWN_PROGRAMS = new Set(['ghostty', 'kitty', 'iterm.app', 'wezterm'])

export function doctorFindings(input: DoctorInput): DoctorFinding[] {
  const env = input.env ?? {}
  const { caps } = input
  const findings: DoctorFinding[] = [
    nodeFinding(input.nodeVersion),
    ttyFinding(input.isTTY),
    terminalFinding(caps, env),
    trueColorFinding(caps, env),
    capFlag(
      'hyperlinks',
      caps.hyperlinks,
      'tool paths in the transcript are clickable',
      'set DECK_CAPS=+hyperlinks or use Ghostty',
    ),
    capFlag(
      'kitty graphics',
      caps.kittyGraphics,
      'ctrl+o image overlay',
      'ctrl+o image overlay unavailable (set DECK_CAPS=+kittyGraphics)',
    ),
    capFlag('notifications', caps.notifications, 'OSC 9', 'OSC 9 not detected'),
    capFlag(
      'progress',
      caps.progress,
      'OSC 9;4',
      'OSC 9;4 not detected (Ghostty typically)',
    ),
    clipboardFinding(caps, input.clipboardRoute),
    capFlag('sync output', caps.syncOutput, 'DECSET 2026', 'DECSET 2026 not detected'),
    unicodeCoreFinding(caps.unicodeCore),
    mouseFinding(input.mouseEnabled),
    hostFinding(input.host),
    { name: 'cwd', status: 'ok', detail: input.cwd },
    editorUriFinding(env),
  ]

  const ascii = envValue(env, 'DECK_ASCII')
  if (ascii === '1') {
    findings.push({ name: 'ascii', status: 'warn', detail: 'unicode glyphs are disabled' })
  }

  const deckCaps = envValue(env, 'DECK_CAPS')
  if (deckCaps !== undefined) {
    findings.push({ name: 'caps override', status: 'warn', detail: deckCaps })
  }

  const vim = envValue(env, 'DECK_VIM')
  if (vim !== undefined && (vim === '1' || vim.toLowerCase() === 'true')) {
    findings.push({ name: 'vim', status: 'ok', detail: 'scrollback vim keys on (/vim-mode)' })
  }

  return findings
}

export function doctorLines(findings: readonly DoctorFinding[]): string[] {
  const lines = ['deck doctor']
  for (const finding of findings) {
    lines.push(`${finding.status.padEnd(4)} ${finding.name}  ${finding.detail}`)
  }
  return lines
}

function nodeFinding(nodeVersion: string): DoctorFinding {
  const ok = versionGte(parseVersion(nodeVersion), MIN_NODE)
  return { name: 'node', status: ok ? 'ok' : 'warn', detail: nodeVersion }
}

function ttyFinding(isTTY: boolean): DoctorFinding {
  return isTTY
    ? { name: 'tty', status: 'ok', detail: 'stdin is a tty' }
    : { name: 'tty', status: 'warn', detail: 'stdin is not a tty; keys/mouse may not work' }
}

function terminalFinding(caps: TerminalCapabilities, env: NodeJS.ProcessEnv): DoctorFinding {
  const term = envValue(env, 'TERM')
  const termProgram = caps.termProgram ?? envValue(env, 'TERM_PROGRAM')
  const version = caps.termProgramVersion
  const name =
    termProgram !== undefined
      ? version !== undefined && version.length > 0
        ? `${termProgram} ${version}`
        : termProgram
      : term !== undefined
        ? term
        : 'unknown'
  const known = isKnownTerminal(caps, termProgram, term)
  return {
    name: 'terminal',
    status: known ? 'ok' : 'warn',
    detail: `${name} · TERM=${term ?? ''} TERM_PROGRAM=${termProgram ?? ''}`,
  }
}

function isKnownTerminal(
  caps: TerminalCapabilities,
  termProgram: string | undefined,
  term: string | undefined,
): boolean {
  if (caps.isGhostty) return true
  const program = (termProgram ?? '').toLowerCase()
  if (KNOWN_PROGRAMS.has(program)) return true
  const t = (term ?? '').toLowerCase()
  if (t.length === 0 || t === 'dumb') return false
  return t.includes('ghostty') || t.includes('kitty') || t.includes('wezterm') || t.includes('iterm')
}

function trueColorFinding(caps: TerminalCapabilities, env: NodeJS.ProcessEnv): DoctorFinding {
  if (envValue(env, 'NO_COLOR') !== undefined) {
    return { name: 'truecolor', status: 'off', detail: 'NO_COLOR is set' }
  }
  return capFlag('truecolor', caps.trueColor, '24-bit color', 'not detected')
}

function clipboardFinding(
  caps: TerminalCapabilities,
  clipboardRoute: string | undefined,
): DoctorFinding {
  const route = clipboardRoute !== undefined && clipboardRoute.length > 0 ? clipboardRoute : undefined
  const routeBit = route !== undefined ? ` · ${route}` : ''
  if (caps.clipboard) {
    return { name: 'clipboard', status: 'ok', detail: `OSC 52${routeBit}` }
  }
  if (isNativeClipboardRoute(route)) {
    return { name: 'clipboard', status: 'ok', detail: `${route} (OSC 52 off)` }
  }
  return { name: 'clipboard', status: 'warn', detail: 'OSC 52 off and no native route' }
}

function isNativeClipboardRoute(route: string | undefined): boolean {
  if (route === undefined) return false
  const r = route.toLowerCase()
  return r !== 'osc52' && r !== 'osc-52' && r !== 'osc 52'
}

function unicodeCoreFinding(on: boolean): DoctorFinding {
  return on
    ? { name: 'unicode core', status: 'ok', detail: 'mode 2027' }
    : {
        name: 'unicode core',
        status: 'warn',
        detail: 'wide CJK may occupy the wrong number of cells',
      }
}

function mouseFinding(mouseEnabled: boolean): DoctorFinding {
  return mouseEnabled
    ? { name: 'mouse', status: 'ok', detail: 'capture on (ctrl+t toggles)' }
    : {
        name: 'mouse',
        status: 'off',
        detail: 'toggled off (ctrl+t) — native terminal selection works',
      }
}

function hostFinding(host: HostDescription | undefined): DoctorFinding {
  if (host === undefined) {
    return { name: 'host', status: 'warn', detail: 'not connected' }
  }
  return { name: 'host', status: 'ok', detail: hostDetail(host) }
}

function hostDetail(host: HostDescription): string {
  const parts: string[] = []
  if (host.version.length > 0) parts.push(`v${host.version}`)
  if (host.cwd.length > 0) parts.push(host.cwd)
  const provider = host.provider
  const model = host.model
  const providerOk = provider !== undefined && provider.length > 0
  const modelOk = model !== undefined && model.length > 0
  if (providerOk && modelOk) parts.push(`${provider}/${model}`)
  else if (providerOk) parts.push(provider)
  else if (modelOk) parts.push(model)
  return parts.join(' · ')
}

function editorUriFinding(env: NodeJS.ProcessEnv): DoctorFinding {
  const tmpl = envValue(env, 'DECK_EDITOR_URI')
  if (tmpl !== undefined) {
    return { name: 'editor uri', status: 'ok', detail: tmpl }
  }
  return {
    name: 'editor uri',
    status: 'off',
    detail: 'OSC 8 uses file:// (set DECK_EDITOR_URI to open in an editor)',
  }
}

function capFlag(name: string, on: boolean, onDetail: string, offDetail: string): DoctorFinding {
  return on
    ? { name, status: 'ok', detail: onDetail }
    : { name, status: 'off', detail: offDetail }
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function parseVersion(raw: string): readonly [number, number, number] {
  let s = raw.trim()
  if (s.startsWith('v') || s.startsWith('V')) s = s.slice(1)
  const core = (s.split(/[-+]/)[0] ?? s).split('.')
  const n = (i: number): number => {
    const part = core[i]
    if (part === undefined) return 0
    const v = Number.parseInt(part, 10)
    return Number.isFinite(v) ? v : 0
  }
  return [n(0), n(1), n(2)]
}

function versionGte(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): boolean {
  if (a[0] !== b[0]) return a[0] > b[0]
  if (a[1] !== b[1]) return a[1] > b[1]
  return a[2] >= b[2]
}
