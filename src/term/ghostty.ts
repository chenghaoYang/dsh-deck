/**
 * Ghostty/xterm integrations. Every method is a no-op (or a plain-text
 * fallback) when the matching capability is absent — never emit a sequence
 * the host would paint as garbage.
 *
 * Sequences match SPEC.md exactly. Interpolated OSC text is sanitized.
 */

import {
  OSC,
  ST,
  hyperlink,
  sanitizeOscPayload,
  setTitle,
} from './ansi.ts'
import type { TerminalCapabilities } from './capabilities.ts'
import { fileHref } from './uri.ts'

/** Kitty graphics: base64 payload bytes per APC chunk (Kitty spec + Ghostty parser). */
export const KITTY_CHUNK = 4096

export class TerminalIntegration {
  readonly #out: NodeJS.WriteStream
  readonly #caps: TerminalCapabilities

  constructor(out: NodeJS.WriteStream, caps: TerminalCapabilities) {
    this.#out = out
    this.#caps = caps
  }

  /**
   * OSC 9;4 — `ESC ] 9 ; 4 ; <state> ; <percent> ESC \`
   * state: 0 clear, 1 set, 2 error, 3 indeterminate.
   * VERIFIED-SUPPORTED Ghostty 1.3: ghostty.org/docs/vt/osc/conemu
   * (`progress-style = true`). Ghostty drops a stale bar after ~15s.
   */
  progress(state: 0 | 1 | 2 | 3, percent?: number): void {
    if (!this.#caps.progress) return
    const pct = percent === undefined ? 0 : Math.min(100, Math.max(0, percent | 0))
    this.#write(`${OSC}9;4;${state};${pct}${ST}`)
  }

  /**
   * OSC 777 notify, OSC 9 fallback.
   * VERIFIED-SUPPORTED Ghostty 1.3: OSC 9 in the VT reference; OSC 777 implemented
   * in ghostty-org/ghostty src/terminal/osc/parsers/rxvt_extension.zig
   * (`777;notify;<title>;<body>` → show_desktop_notification).
   * Default `desktop-notifications = true`. OSC 9 body must not look like ConEmu
   * (`N;…`); we only use OSC 9 as a non-Ghostty fallback.
   */
  notify(title: string, body: string): void {
    if (!this.#caps.notifications) return
    const safeTitle = sanitizeOscPayload(title).replace(/;/g, ' ')
    const safeBody = sanitizeOscPayload(body)
    if (this.#caps.isGhostty) {
      this.#write(`${OSC}777;notify;${safeTitle};${safeBody}${ST}`)
      return
    }
    // OSC 9: `ESC ] 9 ; <body> ESC \`. Avoid a ConEmu-shaped prefix.
    const osc9 = safeBody.replace(/^\d+;/, '')
    this.#write(`${OSC}9;${osc9}${ST}`)
  }

  /**
   * OSC 52 — `ESC ] 52 ; c ; <base64> ESC \`
   * VERIFIED-SUPPORTED Ghostty 1.3: ghostty.org/docs/vt/reference OSC 52;
   * `clipboard-write = allow` by default.
   */
  copy(text: string): void {
    if (!this.#caps.clipboard) return
    this.#write(`${OSC}52;c;${Buffer.from(text, 'utf8').toString('base64')}${ST}`)
  }

  /**
   * OSC 133 A — prompt start.
   * VERIFIED-SUPPORTED Ghostty 1.3: 1.3.0 release notes (complete OSC 133);
   * parser action `fresh_line_new_prompt` = 'A' in semantic_prompt.zig.
   * User config already has shell-integration=zsh with cursor,sudo,title.
   */
  markPromptStart(): void {
    this.#write(`${OSC}133;A${ST}`)
  }

  /** OSC 133 C — output start. */
  markOutputStart(): void {
    this.#write(`${OSC}133;C${ST}`)
  }

  /** OSC 133 D — command end. `ESC ] 133 ; D ; <code> ESC \` when a code is given. */
  markCommandEnd(exitCode?: number): void {
    if (exitCode === undefined) this.#write(`${OSC}133;D${ST}`)
    else this.#write(`${OSC}133;D;${exitCode | 0}${ST}`)
  }

  /**
   * OSC 8 file link. When DECK_EDITOR_URI is set it is a template
   * (`cursor://file{path}:{line}`); otherwise `file://…#L<line>`.
   * Absent hyperlinks → plain label (no sequence).
   */
  fileLink(path: string, line?: number, label?: string): string {
    const display =
      label !== undefined && label.length > 0
        ? label
        : line !== undefined
          ? `${path}:${line}`
          : path
    if (!this.#caps.hyperlinks) return sanitizeOscPayload(display)
    return hyperlink(fileHref(path, line), display)
  }

  /**
   * Kitty graphics: transmit + place a PNG at the cursor.
   * `ESC _ G a=T,f=100,m=<0|1>[,c=<cols>,r=<rows>] ; <base64 chunk> ESC \`
   * Chunks of 4096 base64 bytes; m=1 on every chunk except the last (m=0);
   * control keys only on the first chunk.
   * VERIFIED-SUPPORTED Ghostty 1.3: ghostty.org/docs/features; APC documented
   * at ghostty.org/docs/vt/concepts/sequences; parser notes a 4096-byte payload
   * in src/terminal/kitty/graphics_command.zig.
   * Returns undefined (no bytes written) when kittyGraphics is off.
   */
  image(png: Uint8Array, opts?: { columns?: number; rows?: number }): string | undefined {
    if (!this.#caps.kittyGraphics) return undefined
    const seq = encodeKittyPng(png, opts)
    this.#write(seq)
    return seq
  }

  /**
   * Kitty graphics: delete every visible placement and free its data
   * (`a=d,d=A`). Used when an image overlay closes, so the cells underneath
   * repaint cleanly on the next frame.
   */
  clearImages(): void {
    if (!this.#caps.kittyGraphics) return
    this.#write('\u001b_Ga=d,d=A\u001b\\')
  }

  /**
   * OSC 0 title. Always emitted (sanitized): unknown OSC is ignored, not painted.
   * VERIFIED-SUPPORTED Ghostty 1.3: VT reference OSC 0/2.
   */
  title(text: string): void {
    this.#write(setTitle(text))
  }

  dispose(): void {
    this.progress(0, 0)
  }

  #write(s: string): void {
    if (s.length === 0) return
    try {
      this.#out.write(s)
    } catch {
      // degrade — never throw out of a notification or title write
    }
  }
}

export function encodeKittyPng(
  png: Uint8Array,
  opts?: { columns?: number; rows?: number },
): string {
  const b64 = Buffer.from(png).toString('base64')
  if (b64.length === 0) {
    return kittyChunk(true, true, opts, '')
  }
  const parts: string[] = []
  for (let i = 0; i < b64.length; i += KITTY_CHUNK) {
    const chunk = b64.slice(i, i + KITTY_CHUNK)
    const first = i === 0
    const last = i + KITTY_CHUNK >= b64.length
    parts.push(kittyChunk(first, last, opts, chunk))
  }
  return parts.join('')
}

function kittyChunk(
  first: boolean,
  last: boolean,
  opts: { columns?: number; rows?: number } | undefined,
  chunk: string,
): string {
  const m = last ? 0 : 1
  if (!first) return `\u001b_Gm=${m};${chunk}\u001b\\`
  let ctrl = `a=T,f=100,m=${m}`
  if (opts?.columns !== undefined) ctrl += `,c=${opts.columns}`
  if (opts?.rows !== undefined) ctrl += `,r=${opts.rows}`
  return `\u001b_G${ctrl};${chunk}\u001b\\`
}
