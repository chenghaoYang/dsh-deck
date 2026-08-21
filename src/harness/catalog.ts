/**
 * Named coding harnesses Deck can start from PATH. Native dsh sessions stay
 * on the Host API; these ids are the PATH-local overlays (Waku-style mixed
 * crew). Aliases match the product names the user typed: claudecode → claude,
 * kimicode → kimi.
 */

export const HARNESS_IDS = ['hermes', 'codex', 'claudecode', 'pi', 'fx', 'kimicode'] as const

export type HarnessId = (typeof HARNESS_IDS)[number]

/** Native dsh plus the six PATH harnesses. */
export type SessionHarness = 'dsh' | HarnessId

export interface HarnessSpec {
  id: HarnessId
  /** Sidebar / modes short label. */
  label: string
  /** PATH names tried in order; first hit wins. */
  binaries: readonly string[]
  /** Isolated-home env var(s) the overlay sets to the Deck-owned directory. */
  homeVars: readonly string[]
  /** Directory under $HOME the standalone product uses. Never written by Deck. */
  userHomeDirs: readonly string[]
}

export const HARNESS_SPECS: readonly HarnessSpec[] = [
  {
    id: 'hermes',
    label: 'hermes',
    binaries: ['hermes'],
    homeVars: ['HERMES_HOME'],
    userHomeDirs: ['.hermes'],
  },
  {
    id: 'codex',
    label: 'codex',
    binaries: ['codex'],
    homeVars: ['CODEX_HOME'],
    userHomeDirs: ['.codex'],
  },
  {
    id: 'claudecode',
    label: 'claude',
    binaries: ['claude', 'claudecode'],
    homeVars: ['CLAUDE_CONFIG_DIR'],
    userHomeDirs: ['.claude'],
  },
  {
    id: 'pi',
    label: 'pi',
    binaries: ['pi'],
    homeVars: ['PI_CODING_AGENT_DIR'],
    userHomeDirs: ['.pi'],
  },
  {
    id: 'fx',
    label: 'fx',
    binaries: ['fx'],
    homeVars: ['FX_HOME'],
    userHomeDirs: ['.fx'],
  },
  {
    id: 'kimicode',
    label: 'kimi',
    binaries: ['kimi', 'kimicode'],
    homeVars: ['KIMI_CODE_HOME'],
    userHomeDirs: ['.kimi-code', '.kimi'],
  },
]

export function isHarnessId(value: string): value is HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(value)
}

export function isSessionHarness(value: string): value is SessionHarness {
  return value === 'dsh' || isHarnessId(value)
}

export function specOf(id: HarnessId): HarnessSpec {
  const spec = HARNESS_SPECS.find((item) => item.id === id)
  if (spec === undefined) throw new Error(`unknown harness ${id}`)
  return spec
}

export function harnessLabel(id: SessionHarness): string {
  if (id === 'dsh') return 'dsh'
  return specOf(id).label
}
