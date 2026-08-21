/**
 * Tiny JSON prefs under $DECK_HOME/prefs.json (or ~/.deck/prefs.json).
 * Fail-soft: missing or malformed files load as {}.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { isSessionHarness, type SessionHarness } from '../harness/catalog.ts'

export interface DeckPrefs {
  dashboard?: {
    grouping?: 'state' | 'directory'
    pinned?: string[]
    pinOrder?: string[]
  }
  /** Last harness chosen in modes; `dsh` means native Host API. */
  lastHarness?: SessionHarness
}

export function loadPrefs(env?: NodeJS.ProcessEnv): DeckPrefs {
  const path = prefsPath(env)
  try {
    const raw = readFileSync(path, 'utf8')
    return parsePrefs(JSON.parse(raw) as unknown)
  } catch {
    return {}
  }
}

export function savePrefs(prefs: DeckPrefs, env?: NodeJS.ProcessEnv): boolean {
  const path = prefsPath(env)
  try {
    mkdirSync(dirname(path), { recursive: true })
    const merged: DeckPrefs = { ...loadPrefs(env) }
    if (prefs.dashboard !== undefined) merged.dashboard = prefs.dashboard
    if (prefs.lastHarness !== undefined) merged.lastHarness = prefs.lastHarness
    writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

function prefsPath(env?: NodeJS.ProcessEnv): string {
  const resolved = env ?? process.env
  const home = resolved.DECK_HOME
  if (typeof home === 'string' && home.length > 0) return join(home, 'prefs.json')
  return join(homedir(), '.deck', 'prefs.json')
}

function parsePrefs(raw: unknown): DeckPrefs {
  const obj = asRecord(raw)
  if (obj === undefined) return {}
  const prefs: DeckPrefs = {}

  const dash = asRecord(obj.dashboard)
  if (dash !== undefined) {
    const dashboard: NonNullable<DeckPrefs['dashboard']> = {}
    if (dash.grouping === 'state' || dash.grouping === 'directory') {
      dashboard.grouping = dash.grouping
    }
    const pinned = asStringArray(dash.pinned)
    if (pinned !== undefined) dashboard.pinned = pinned
    const pinOrder = asStringArray(dash.pinOrder)
    if (pinOrder !== undefined) dashboard.pinOrder = pinOrder
    if (Object.keys(dashboard).length > 0) prefs.dashboard = dashboard
  }

  if (typeof obj.lastHarness === 'string' && isSessionHarness(obj.lastHarness)) {
    prefs.lastHarness = obj.lastHarness
  }
  return prefs
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    out.push(item)
  }
  return out
}
