/**
 * PATH discovery for the six named harnesses. `env` is required — never read
 * `process.env` as the only input. Tests inject a fake PATH and `exists`.
 */

import { existsSync } from 'node:fs'
import { delimiter as defaultDelimiter, join } from 'node:path'

import {
  HARNESS_SPECS,
  type HarnessId,
  type HarnessSpec,
} from './catalog.ts'

export interface HarnessDiscovery {
  id: HarnessId
  label: string
  binaries: readonly string[]
  present: boolean
  /** Absolute path of the first matching binary. Omit when missing. */
  binary?: string
  /** Which PATH name hit. Omit when missing. */
  resolvedName?: string
}

export interface DiscoverOptions {
  env: NodeJS.ProcessEnv
  /** Override PATH; default `env.PATH`. */
  path?: string
  pathSep?: string
  platform?: NodeJS.Platform
  exists?: (path: string) => boolean
}

export function discoverHarnesses(options: DiscoverOptions): readonly HarnessDiscovery[] {
  const pathValue = options.path ?? envValue(options.env, 'PATH') ?? ''
  const sep = options.pathSep ?? pathDelimiter(options.platform)
  const dirs = pathValue.split(sep).filter((dir) => dir.length > 0)
  const exists = options.exists ?? existsSync
  const platform = options.platform ?? process.platform
  return HARNESS_SPECS.map((spec) => resolveSpec(spec, dirs, exists, platform))
}

export function formatHarnessList(rows: readonly HarnessDiscovery[]): string {
  const lines = ['deck harness']
  for (const row of rows) {
    if (row.present && row.binary !== undefined) {
      const alias =
        row.resolvedName !== undefined && row.resolvedName !== row.id
          ? `  (${row.resolvedName})`
          : ''
      lines.push(`ok   ${row.id.padEnd(12)} ${row.binary}${alias}`)
    } else {
      lines.push(`miss ${row.id.padEnd(12)} not on PATH`)
    }
  }
  return lines.join('\n')
}

function resolveSpec(
  spec: HarnessSpec,
  dirs: readonly string[],
  exists: (path: string) => boolean,
  platform: NodeJS.Platform,
): HarnessDiscovery {
  const names = executableNames(spec.binaries, platform)
  for (const name of names) {
    const hit = lookup(dirs, name, exists)
    if (hit === undefined) continue
    const resolvedName = stripWindowsExt(name, platform)
    const row: HarnessDiscovery = {
      id: spec.id,
      label: spec.label,
      binaries: spec.binaries,
      present: true,
      binary: hit,
      resolvedName,
    }
    return row
  }
  return {
    id: spec.id,
    label: spec.label,
    binaries: spec.binaries,
    present: false,
  }
}

function lookup(
  dirs: readonly string[],
  name: string,
  exists: (path: string) => boolean,
): string | undefined {
  for (const dir of dirs) {
    const candidate = join(dir, name)
    if (exists(candidate)) return candidate
  }
  return undefined
}

function executableNames(binaries: readonly string[], platform: NodeJS.Platform): string[] {
  const names: string[] = []
  for (const binary of binaries) {
    names.push(binary)
    if (platform === 'win32') {
      names.push(`${binary}.exe`, `${binary}.cmd`, `${binary}.bat`)
    }
  }
  return names
}

function stripWindowsExt(name: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return name
  return name.replace(/\.(exe|cmd|bat)$/i, '')
}

function pathDelimiter(platform: NodeJS.Platform | undefined): string {
  if (platform === 'win32') return ';'
  if (platform === undefined) return defaultDelimiter
  return ':'
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
