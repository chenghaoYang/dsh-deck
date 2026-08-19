/**
 * Host-terminal capability detection. Never probes (no DA1/XTGETTCAP): a
 * terminal that does not answer must not hang startup. Overrides via DECK_CAPS
 * (`+kittyGraphics,-progress`) so the product never depends on detection.
 *
 * Ghostty 1.3.1 signals: TERM_PROGRAM=ghostty, TERM_PROGRAM_VERSION, TERM=xterm-ghostty.
 * Confirmed with `/Applications/Ghostty.app/Contents/MacOS/ghostty +version` → 1.3.1.
 */

export interface TerminalCapabilities {
  isGhostty: boolean
  termProgram?: string
  termProgramVersion?: string
  trueColor: boolean
  hyperlinks: boolean // OSC 8
  kittyGraphics: boolean // APC _G
  notifications: boolean // OSC 777 / OSC 9
  progress: boolean // OSC 9;4
  clipboard: boolean // OSC 52
  syncOutput: boolean // DECSET 2026
  unicodeCore: boolean // mode 2027
}

const BOOL_FLAGS = [
  'trueColor',
  'hyperlinks',
  'kittyGraphics',
  'notifications',
  'progress',
  'clipboard',
  'syncOutput',
  'unicodeCore',
  'isGhostty',
] as const

type BoolFlag = (typeof BOOL_FLAGS)[number]

function isBoolFlag(name: string): name is BoolFlag {
  return (BOOL_FLAGS as readonly string[]).includes(name)
}

function envStr(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]
  return value !== undefined && value !== '' ? value : undefined
}

/**
 * Detect capabilities from the environment.
 *
 * Per-flag Ghostty 1.3.1 status (see also ghostty.ts):
 * - trueColor: VERIFIED-SUPPORTED — window-colorspace / 24-bit SGR; COLORTERM not
 *   required when TERM_PROGRAM=ghostty.
 * - hyperlinks: VERIFIED-SUPPORTED — ghostty.org/docs/vt/reference OSC 8;
 *   user config `link-url = true`.
 * - kittyGraphics: VERIFIED-SUPPORTED — ghostty.org/docs/features and
 *   ghostty.org/docs/vt/concepts/sequences (APC = Kitty Graphics Protocol);
 *   `image-storage-limit` default 320MB (0 would disable).
 * - notifications: VERIFIED-SUPPORTED — OSC 9 in the official VT reference;
 *   OSC 777 parsed in src/terminal/osc/parsers/rxvt_extension.zig as
 *   `show_desktop_notification`; `desktop-notifications = true` by default
 *   (`ghostty +show-config --default --docs`).
 * - progress: VERIFIED-SUPPORTED — ghostty.org/docs/vt/osc/conemu OSC 9;4;
 *   `progress-style = true` by default. Ghostty times out a stale bar after ~15s.
 * - clipboard: VERIFIED-SUPPORTED — OSC 52 in the VT reference;
 *   `clipboard-write = allow` by default.
 * - syncOutput: VERIFIED-SUPPORTED — ghostty.org/docs/help/synchronized-output
 *   (DECSET 2026).
 * - unicodeCore: VERIFIED-SUPPORTED — `grapheme-width-method = unicode` and
 *   mode 2027 forces unicode width (`ghostty +show-config --default --docs`).
 */
export function detectCapabilities(env?: NodeJS.ProcessEnv): TerminalCapabilities {
  const e = env ?? process.env
  const termProgram = envStr(e, 'TERM_PROGRAM')
  const termProgramVersion = envStr(e, 'TERM_PROGRAM_VERSION')
  const term = envStr(e, 'TERM') ?? ''
  const colorterm = (envStr(e, 'COLORTERM') ?? '').toLowerCase()
  const program = (termProgram ?? '').toLowerCase()

  const isGhostty =
    program === 'ghostty' || term === 'xterm-ghostty' || term === 'ghostty'

  const noColor = e.NO_COLOR !== undefined && e.NO_COLOR !== ''

  // Other modern terminals get a conservative subset so we do not emit
  // Ghostty-specific sequences (progress, OSC 777) into something that would
  // echo them as garbage. Force extras with DECK_CAPS.
  const kitty = program === 'kitty'
  const iterm = program === 'iterm.app'
  const wez = program === 'wezterm'
  const modern = isGhostty || kitty || iterm || wez

  const caps: TerminalCapabilities = {
    isGhostty,
    trueColor:
      !noColor &&
      (isGhostty ||
        colorterm === 'truecolor' ||
        colorterm === '24bit' ||
        term.includes('truecolor') ||
        term.includes('direct')),
    hyperlinks: modern,
    kittyGraphics: isGhostty || kitty || wez,
    notifications: isGhostty || iterm || wez,
    progress: isGhostty,
    clipboard: modern,
    syncOutput: modern,
    unicodeCore: isGhostty || kitty,
  }

  if (termProgram !== undefined) caps.termProgram = termProgram
  if (termProgramVersion !== undefined) caps.termProgramVersion = termProgramVersion

  const deckCaps = envStr(e, 'DECK_CAPS')
  if (deckCaps !== undefined) {
    for (const raw of deckCaps.split(',')) {
      const part = raw.trim()
      if (part.length === 0) continue
      const sign = part.startsWith('+') ? true : part.startsWith('-') ? false : true
      const name = part.startsWith('+') || part.startsWith('-') ? part.slice(1) : part
      if (!isBoolFlag(name)) continue
      caps[name] = sign
    }
  }

  if (noColor) caps.trueColor = false
  return caps
}
