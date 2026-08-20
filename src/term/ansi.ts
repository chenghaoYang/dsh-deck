/**
 * Pure ANSI/OSC string builders. No writes.
 *
 * OSC/APC payloads that interpolate untrusted text must go through
 * {@link sanitizeOscPayload} first — ESC/BEL/ST/C0 in a title or notification
 * body are a breakout. Ghostty 1.3 accepts ST (`ESC \`) as the OSC terminator
 * (BEL is also accepted; we always emit ST).
 */

export const CSI = '\u001b['
export const OSC = '\u001b]'
export const APC = '\u001b_'
export const ST = '\u001b\\'
export const RESET = `${CSI}0m`

/** C0 + DEL + C1. C1 includes 8-bit ST/OSC (U+009C/U+009D). */
const UNSAFE_OSC = /[\u0000-\u001F\u007F\u0080-\u009F]/g

/**
 * Strip ESC, BEL, ST and other C0/C1 controls from an OSC/APC payload.
 * Required: untrusted LLM text flows into titles, notifications, and labels.
 */
export function sanitizeOscPayload(text: string): string {
  return text.replace(UNSAFE_OSC, '')
}

export function sgr(...codes: number[]): string {
  return `${CSI}${codes.join(';')}m`
}

export function rgb(r: number, g: number, b: number): string {
  return sgr(38, 2, r & 0xff, g & 0xff, b & 0xff)
}

/** Truecolor background. Empty-string styles remain “terminal default”. */
export function rgbBg(r: number, g: number, b: number): string {
  return sgr(48, 2, r & 0xff, g & 0xff, b & 0xff)
}

/** CUP — 1-based row/column. */
export function cursorTo(row: number, col: number): string {
  return `${CSI}${Math.max(1, row | 0)};${Math.max(1, col | 0)}H`
}

/** ED 2 — entire display. */
export function eraseDisplay(): string {
  return `${CSI}2J`
}

export function hideCursor(): string {
  return `${CSI}?25l`
}

export function showCursor(): string {
  return `${CSI}?25h`
}

/** DECSET/DECRST 1049 — alt screen + cursor save. */
export function altScreen(on: boolean): string {
  return on ? `${CSI}?1049h` : `${CSI}?1049l`
}

/**
 * DECSET 2026 synchronized output.
 * VERIFIED supported in Ghostty 1.3: ghostty.org/docs/help/synchronized-output
 * and GHOSTTY_MODE_SYNC_OUTPUT in ghostty-org/ghostty include/ghostty/vt/modes.h.
 */
export function beginSync(): string {
  return `${CSI}?2026h`
}

export function endSync(): string {
  return `${CSI}?2026l`
}

/**
 * OSC 8 hyperlink.
 * Exact: `ESC ] 8 ; [id=…] ; <uri> ESC \ <label> ESC ] 8 ; ; ESC \`
 * VERIFIED supported in Ghostty 1.3: ghostty.org/docs/vt/reference (OSC 8).
 */
export function hyperlink(uri: string, label: string, id?: string): string {
  const safeUri = sanitizeOscPayload(uri).replace(/;/g, '')
  const safeLabel = sanitizeOscPayload(label)
  const params =
    id !== undefined && id.length > 0
      ? `id=${sanitizeOscPayload(id).replace(/;/g, '')}`
      : ''
  return `${OSC}8;${params};${safeUri}${ST}${safeLabel}${OSC}8;;${ST}`
}

/**
 * OSC 0 — icon + window title.
 * VERIFIED supported in Ghostty 1.3: ghostty.org/docs/vt/reference (OSC 0 / OSC 2).
 */
export function setTitle(text: string): string {
  return `${OSC}0;${sanitizeOscPayload(text)}${ST}`
}

/** OSC 9;4 clear — used by Screen.close() so a crash cannot leave a stuck bar. */
export function clearProgress(): string {
  return `${OSC}9;4;0;0${ST}`
}

/** Sequences Screen.close() must emit. Safe to write from a signal handler. */
export function restoreTerminal(): string {
  // Also leave bracketed-paste and sync-output off so a crash cannot stick them.
  return endSync() + `${CSI}?2004l` + showCursor() + altScreen(false) + RESET + clearProgress()
}
