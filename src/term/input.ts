/**
 * Raw-mode key reader. Ctrl+C is a key event (`{kind:'ctrl',char:'c'}`), not a
 * process killer — raw mode clears ISIG. Partial UTF-8 and partial CSI are
 * buffered so CJK/IME never emits a replacement character mid-cluster.
 *
 * SGR mouse (`CSI < Pb ; Px ; Py M/m`) is decoded here. The same incomplete-CSI
 * hold applies: a report split across stdin chunks must still become one event.
 * Plain 1003 motion (button 3 + motion bit, no press) is discarded — we only
 * enable 1002, but reports must not leak into the key stream.
 */

import { StringDecoder } from 'node:string_decoder'

export type Key =
  | { kind: 'char'; char: string }
  | {
      kind:
        | 'enter'
        | 'backspace'
        | 'tab'
        | 'escape'
        | 'up'
        | 'down'
        | 'left'
        | 'right'
        | 'home'
        | 'end'
        | 'pageup'
        | 'pagedown'
        | 'delete'
    }
  | { kind: 'ctrl'; char: string }
  | { kind: 'alt'; char: string }
  | { kind: 'paste'; text: string }
  | { kind: 'unknown'; raw: string }
  | {
      kind: 'mouse'
      action: 'down' | 'up' | 'drag'
      button: 'left' | 'middle' | 'right'
      row: number
      col: number
      shift: boolean
      alt: boolean
      ctrl: boolean
    }
  | {
      kind: 'wheel'
      direction: 'up' | 'down'
      row: number
      col: number
      shift: boolean
      alt: boolean
      ctrl: boolean
    }

const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' })
const ESC = '\u001b'
const PASTE_START = `${ESC}[200~`
const PASTE_END = `${ESC}[201~`
const ESC_TIMEOUT_MS = 25

type NavKind =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown'
  | 'delete'

const CSI_NAV: Record<string, NavKind> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
}

const TILDE_NAV: Record<string, NavKind> = {
  '1': 'home',
  '3': 'delete',
  '4': 'end',
  '5': 'pageup',
  '6': 'pagedown',
  '7': 'home',
  '8': 'end',
}

export class InputReader {
  readonly #input: NodeJS.ReadStream
  readonly #listeners = new Set<(key: Key) => void>()
  readonly #decoder = new StringDecoder('utf8')
  #buf = ''
  #paste: string | undefined
  #started = false
  #wasRaw: boolean | undefined
  #escTimer: ReturnType<typeof setTimeout> | undefined

  constructor(input: NodeJS.ReadStream) {
    this.#input = input
  }

  start(): void {
    if (this.#started) return
    this.#started = true
    if (this.#input.isTTY && typeof this.#input.setRawMode === 'function') {
      this.#wasRaw = this.#input.isRaw
      this.#input.setRawMode(true)
    }
    this.#input.setEncoding('utf8')
    this.#input.on('data', this.#onData)
    this.#input.resume?.()
  }

  stop(): void {
    if (!this.#started) return
    this.#started = false
    this.#clearEscTimer()
    this.#input.removeListener('data', this.#onData)
    const rest = this.#decoder.end()
    if (rest) this.#buf += rest
    if (this.#paste !== undefined) {
      this.#emit({ kind: 'paste', text: this.#paste + this.#buf })
      this.#paste = undefined
      this.#buf = ''
    } else {
      this.#parse(true)
    }
    if (
      this.#wasRaw !== undefined &&
      this.#input.isTTY &&
      typeof this.#input.setRawMode === 'function'
    ) {
      try {
        this.#input.setRawMode(this.#wasRaw)
      } catch {
        // stream may already be closed
      }
    }
    this.#wasRaw = undefined
  }

  onKey(listener: (key: Key) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #onData = (chunk: string | Buffer): void => {
    this.#clearEscTimer()
    if (typeof chunk === 'string') this.#buf += chunk
    else this.#buf += this.#decoder.write(chunk)
    this.#parse(false)
  }

  #emit(key: Key): void {
    for (const listener of this.#listeners) {
      try {
        listener(key)
      } catch {
        // a listener throw must not kill the reader
      }
    }
  }

  #clearEscTimer(): void {
    if (this.#escTimer === undefined) return
    clearTimeout(this.#escTimer)
    this.#escTimer = undefined
  }

  #armEsc(): void {
    this.#clearEscTimer()
    this.#escTimer = setTimeout(() => {
      this.#escTimer = undefined
      if (this.#buf.startsWith(ESC) && this.#paste === undefined) {
        this.#buf = this.#buf.slice(1)
        this.#emit({ kind: 'escape' })
        this.#parse(false)
      }
    }, ESC_TIMEOUT_MS)
  }

  #parse(flush: boolean): void {
    while (this.#buf.length > 0) {
      if (this.#paste !== undefined) {
        const end = this.#buf.indexOf(PASTE_END)
        if (end === -1) {
          this.#paste += this.#buf
          this.#buf = ''
          return
        }
        this.#emit({ kind: 'paste', text: this.#paste + this.#buf.slice(0, end) })
        this.#paste = undefined
        this.#buf = this.#buf.slice(end + PASTE_END.length)
        continue
      }

      const first = this.#buf.charCodeAt(0)
      if (first === undefined) return

      if (first === 0x1b) {
        if (this.#buf.startsWith(PASTE_START)) {
          this.#paste = ''
          this.#buf = this.#buf.slice(PASTE_START.length)
          continue
        }
        const csi = this.#takeCsi()
        if (csi === 'incomplete') {
          if (flush) {
            this.#emit({ kind: 'escape' })
            this.#buf = this.#buf.slice(1)
            continue
          }
          if (this.#buf === ESC) this.#armEsc()
          return
        }
        if (csi !== undefined) {
          this.#dispatchCsi(csi.params, csi.final, csi.raw)
          continue
        }
        if (this.#buf.length >= 3 && this.#buf[1] === 'O') {
          const ss3 = this.#buf[2] ?? ''
          const kind = CSI_NAV[ss3]
          this.#buf = this.#buf.slice(3)
          if (kind !== undefined) this.#emit({ kind })
          else this.#emit({ kind: 'unknown', raw: `${ESC}O${ss3}` })
          continue
        }
        if (this.#buf.length === 1) {
          if (flush) {
            this.#buf = ''
            this.#emit({ kind: 'escape' })
            return
          }
          this.#armEsc()
          return
        }
        const rest = this.#buf.slice(1)
        const g = firstGrapheme(rest)
        if (g === undefined) return
        this.#buf = rest.slice(g.length)
        if (g === '[') {
          // orphan ESC [ that failed CSI parse
          this.#emit({ kind: 'unknown', raw: `${ESC}[` })
          continue
        }
        this.#emit({ kind: 'alt', char: g })
        continue
      }

      if (first === 0x0d || first === 0x0a) {
        this.#buf = this.#buf.slice(1)
        this.#emit({ kind: 'enter' })
        continue
      }
      if (first === 0x09) {
        this.#buf = this.#buf.slice(1)
        this.#emit({ kind: 'tab' })
        continue
      }
      if (first === 0x7f || first === 0x08) {
        this.#buf = this.#buf.slice(1)
        this.#emit({ kind: 'backspace' })
        continue
      }
      if (first < 0x20) {
        this.#buf = this.#buf.slice(1)
        this.#emit({ kind: 'ctrl', char: String.fromCharCode(first + 96) })
        continue
      }

      const g = firstGrapheme(this.#buf)
      if (g === undefined) return
      this.#buf = this.#buf.slice(g.length)
      this.#emit({ kind: 'char', char: g })
    }
  }

  /** Consume a complete CSI or report incomplete / not-csi. */
  #takeCsi(): { params: string; final: string; raw: string } | 'incomplete' | undefined {
    if (this.#buf.length < 2 || this.#buf[1] !== '[') return undefined
    let i = 2
    while (i < this.#buf.length) {
      const c = this.#buf.charCodeAt(i)
      if (c === undefined) break
      if (c >= 0x30 && c <= 0x3f) {
        i++
        continue
      } // 0-9:;=?
      if (c >= 0x20 && c <= 0x2f) {
        i++
        continue
      } // intermediates
      if (c >= 0x40 && c <= 0x7e) {
        const raw = this.#buf.slice(0, i + 1)
        const body = this.#buf.slice(2, i)
        const final = this.#buf[i] ?? ''
        this.#buf = this.#buf.slice(i + 1)
        return { params: body, final, raw }
      }
      return undefined
    }
    return 'incomplete'
  }

  #dispatchCsi(params: string, final: string, raw: string): void {
    // Private CSI `<…` is the SGR mouse family. Never reinterpret a failed
    // mouse report as a nav key (`CSI A` vs `CSI <A`).
    if (params.startsWith('<')) {
      if (final === 'M' || final === 'm') {
        const mouse = parseSgrMouse(params, final)
        if (mouse === 'discard') return
        if (mouse !== undefined) {
          this.#emit(mouse)
          return
        }
      }
      this.#emit({ kind: 'unknown', raw })
      return
    }
    if (final === '~') {
      const n = (params.split(';')[0] ?? '') || '1'
      if (n === '200') {
        this.#paste = ''
        return
      }
      const kind = TILDE_NAV[n]
      if (kind !== undefined) {
        this.#emit({ kind })
        return
      }
      this.#emit({ kind: 'unknown', raw })
      return
    }
    const kind = CSI_NAV[final]
    if (kind !== undefined) {
      this.#emit({ kind })
      return
    }
    this.#emit({ kind: 'unknown', raw })
  }
}

/**
 * SGR Pb (xterm):
 *   bits 0–1  button (0 left, 1 middle, 2 right; 3 = no-button / X10 release)
 *   +4 shift, +8 alt/meta, +16 ctrl, +32 motion/drag
 *   64 / 65 wheel up / down (wheel wins over M/m)
 * Px/Py are 1-based col/row.
 */
function parseSgrMouse(params: string, final: string): Key | 'discard' | undefined {
  const fields = params.slice(1).split(';')
  const pbRaw = fields[0]
  const pxRaw = fields[1]
  const pyRaw = fields[2]
  if (pbRaw === undefined || pxRaw === undefined || pyRaw === undefined) return undefined
  const pb = parseDec(pbRaw)
  const col = parseDec(pxRaw)
  const row = parseDec(pyRaw)
  if (pb === undefined || col === undefined || row === undefined) return undefined

  const shift = (pb & 4) !== 0
  const alt = (pb & 8) !== 0
  const ctrl = (pb & 16) !== 0
  const motion = (pb & 32) !== 0
  const buttonBits = pb & 3

  if ((pb & 64) !== 0) {
    if (buttonBits === 0) {
      return { kind: 'wheel', direction: 'up', row, col, shift, alt, ctrl }
    }
    if (buttonBits === 1) {
      return { kind: 'wheel', direction: 'down', row, col, shift, alt, ctrl }
    }
    return undefined
  }

  // Buttons 8–11 (bit 7) are outside the Key contract.
  if ((pb & 128) !== 0) return undefined

  let button: 'left' | 'middle' | 'right'
  if (buttonBits === 0) button = 'left'
  else if (buttonBits === 1) button = 'middle'
  else if (buttonBits === 2) button = 'right'
  else {
    // 3 + motion is 1003 hover; 3 without motion is X10-style release.
    // Neither has a button we can name — drop them.
    return 'discard'
  }

  const action: 'down' | 'up' | 'drag' = final === 'm' ? 'up' : motion ? 'drag' : 'down'
  return { kind: 'mouse', action, button, row, col, shift, alt, ctrl }
}

function parseDec(text: string): number | undefined {
  if (text.length === 0 || !/^[0-9]+$/.test(text)) return undefined
  const n = Number(text)
  if (!Number.isSafeInteger(n)) return undefined
  return n
}

function firstGrapheme(text: string): string | undefined {
  if (text.length === 0) return undefined
  for (const part of SEGMENTER.segment(text)) return part.segment
  return undefined
}
