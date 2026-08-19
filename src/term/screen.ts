/**
 * Double-buffered cell renderer. A wide grapheme occupies two slots; the
 * continuation is never flushed on its own. `put`/`fill` are 1-based so they
 * match `cursorTo` and Module D's layout rects.
 *
 * close() is idempotent and is hooked to exit / SIGINT / SIGTERM /
 * uncaughtException so a crash cannot leave an invisible cursor or a stuck
 * OSC 9;4 bar.
 */

import {
  CSI,
  RESET,
  altScreen,
  beginSync,
  cursorTo,
  endSync,
  eraseDisplay,
  hideCursor,
  restoreTerminal,
} from './ansi.ts'
import type { TerminalCapabilities } from './capabilities.ts'
import { graphemeWidth, graphemes } from './width.ts'

export interface Cell {
  char: string
  style: string
  width: 1 | 2
}

const EMPTY: Cell = { char: ' ', style: '', width: 1 }
const CONT: Cell = { char: '', style: '', width: 1 }

function isCont(cell: Cell): boolean {
  return cell === CONT
}

function cellsEqual(a: Cell, b: Cell): boolean {
  if (isCont(a) || isCont(b)) return a === b
  return a.char === b.char && a.style === b.style && a.width === b.width
}

function makeGrid(rows: number, cols: number): Cell[][] {
  const grid: Cell[][] = []
  for (let r = 0; r < rows; r++) {
    const row: Cell[] = []
    for (let c = 0; c < cols; c++) row.push(EMPTY)
    grid.push(row)
  }
  return grid
}

export class Screen {
  readonly #out: NodeJS.WriteStream
  readonly #caps: TerminalCapabilities
  readonly #resizeListeners = new Set<(columns: number, rows: number) => void>()
  #cols: number
  #rows: number
  #prev: Cell[][]
  #next: Cell[][] | undefined
  #opened = false
  #closed = false
  #cursorRow = -1
  #cursorCol = -1
  #style = ''

  constructor(out: NodeJS.WriteStream, caps: TerminalCapabilities) {
    this.#out = out
    this.#caps = caps
    this.#cols = Math.max(1, out.columns ?? 80)
    this.#rows = Math.max(1, out.rows ?? 24)
    this.#prev = makeGrid(this.#rows, this.#cols)
  }

  get columns(): number {
    return this.#cols
  }

  get rows(): number {
    return this.#rows
  }

  /** Enter alt screen, hide cursor, install resize + exit handlers. */
  open(): void {
    if (this.#opened || this.#closed) return
    this.#opened = true
    this.#write(altScreen(true) + hideCursor() + `${CSI}?2004h` + eraseDisplay() + cursorTo(1, 1))
    if (this.#caps.unicodeCore) this.#write('\u001b[?2027h')
    this.#out.on?.('resize', this.#onStreamResize)
    process.on('exit', this.#onExit)
    process.on('SIGINT', this.#onSigint)
    process.on('SIGTERM', this.#onSigterm)
    process.on('uncaughtException', this.#onUncaught)
    process.on('uncaughtExceptionMonitor', this.#onUncaughtMonitor)
  }

  /**
   * Restore the terminal exactly as found. Idempotent; safe from a signal handler.
   * Show cursor, leave alt screen, reset SGR, clear OSC 9;4, end sync.
   */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#opened = false
    try {
      this.#out.removeListener?.('resize', this.#onStreamResize)
    } catch {
      // ignore
    }
    process.removeListener('exit', this.#onExit)
    process.removeListener('SIGINT', this.#onSigint)
    process.removeListener('SIGTERM', this.#onSigterm)
    process.removeListener('uncaughtException', this.#onUncaught)
    process.removeListener('uncaughtExceptionMonitor', this.#onUncaughtMonitor)
    this.#write(restoreTerminal())
  }

  onResize(listener: (columns: number, rows: number) => void): () => void {
    this.#resizeListeners.add(listener)
    return () => {
      this.#resizeListeners.delete(listener)
    }
  }

  /** Start a new virtual frame. */
  begin(): void {
    this.#syncSize()
    this.#next = makeGrid(this.#rows, this.#cols)
  }

  /**
   * Write text at a 1-based position with a style; clipped to bounds, wide
   * chars respected (never written as a half cell).
   */
  put(row: number, col: number, text: string, style?: string): void {
    const grid = this.#next
    if (grid === undefined) return
    if (row < 1 || row > this.#rows) return
    const s = style ?? ''
    let c = col
    for (const g of graphemes(text)) {
      const w = graphemeWidth(g)
      if (w === 0) continue
      if (w !== 1 && w !== 2) continue
      if (c < 1) {
        c += w
        continue
      }
      if (c + w - 1 > this.#cols) break
      this.#place(grid, row - 1, c - 1, g, w, s)
      c += w
    }
  }

  fill(
    row: number,
    col: number,
    width: number,
    height: number,
    char?: string,
    style?: string,
  ): void {
    const fillChar = firstPaintGrapheme(char)
    const s = style ?? ''
    const w = graphemeWidth(fillChar) === 2 ? 2 : 1
    const ch = w === 2 ? fillChar : fillChar
    for (let r = 0; r < height; r++) {
      let c = 0
      while (c < width) {
        if (w === 2 && c + 2 > width) break
        this.put(row + r, col + c, ch, s)
        c += w
      }
    }
  }

  /** Diff and flush, wrapped in synchronized-output markers when supported. */
  end(): void {
    const next = this.#next
    if (next === undefined) return
    this.#next = undefined
    let out = ''
    if (this.#caps.syncOutput) out += beginSync()
    this.#cursorRow = -1
    this.#cursorCol = -1
    this.#style = ''
    for (let r = 0; r < this.#rows; r++) {
      const nextRow = next[r]
      const prevRow = this.#prev[r]
      if (nextRow === undefined || prevRow === undefined) continue
      for (let c = 0; c < this.#cols; c++) {
        const cell = nextRow[c] ?? EMPTY
        if (isCont(cell)) continue
        const prev = prevRow[c] ?? EMPTY
        if (cellsEqual(cell, prev)) continue
        out += this.#emitCell(r, c, cell)
      }
    }
    if (this.#style !== '') out += RESET
    if (this.#caps.syncOutput) out += endSync()
    this.#prev = next
    this.#write(out)
  }

  #emitCell(row0: number, col0: number, cell: Cell): string {
    let out = ''
    const row = row0 + 1
    const col = col0 + 1
    if (this.#cursorRow !== row || this.#cursorCol !== col) {
      out += cursorTo(row, col)
    }
    const style = cell.style
    if (style !== this.#style) {
      out += style === '' ? RESET : this.#style === '' ? style : RESET + style
      this.#style = style
    }
    out += cell.char.length > 0 ? cell.char : ' '
    this.#cursorRow = row
    this.#cursorCol = col + cell.width
    return out
  }

  #place(grid: Cell[][], row0: number, col0: number, char: string, width: 1 | 2, style: string): void {
    const row = grid[row0]
    if (row === undefined) return
    this.#clearAt(row, col0)
    if (width === 2) this.#clearAt(row, col0 + 1)
    row[col0] = { char, style, width }
    if (width === 2 && col0 + 1 < this.#cols) row[col0 + 1] = CONT
  }

  #clearAt(row: Cell[], col0: number): void {
    const cur = row[col0]
    if (cur === undefined) return
    if (isCont(cur)) {
      const left = row[col0 - 1]
      if (left !== undefined && left.width === 2) row[col0 - 1] = EMPTY
      row[col0] = EMPTY
      return
    }
    if (cur.width === 2) {
      row[col0] = EMPTY
      if (col0 + 1 < row.length) row[col0 + 1] = EMPTY
      return
    }
    row[col0] = EMPTY
  }

  #syncSize(): void {
    const cols = Math.max(1, this.#out.columns ?? this.#cols)
    const rows = Math.max(1, this.#out.rows ?? this.#rows)
    if (cols === this.#cols && rows === this.#rows) return
    this.#cols = cols
    this.#rows = rows
    this.#prev = makeGrid(rows, cols)
  }

  #onStreamResize = (): void => {
    const prevC = this.#cols
    const prevR = this.#rows
    this.#syncSize()
    if (this.#cols === prevC && this.#rows === prevR) return
    for (const listener of this.#resizeListeners) {
      try {
        listener(this.#cols, this.#rows)
      } catch {
        // ignore
      }
    }
  }

  #write(s: string): void {
    if (s.length === 0) return
    try {
      this.#out.write(s)
    } catch {
      // signal-safe: never throw
    }
  }

  #onExit = (): void => {
    this.close()
  }

  #onSigint = (): void => {
    this.close()
    process.exit(130)
  }

  #onSigterm = (): void => {
    this.close()
    process.exit(143)
  }

  /** Monitor restores without swallowing Node's default crash. */
  #onUncaughtMonitor = (): void => {
    this.close()
  }

  /**
   * Adding `uncaughtException` suppresses Node's default exit. Restore, then
   * exit only if nobody else is handling the exception (e.g. a test runner).
   */
  #onUncaught = (err: unknown): void => {
    this.close()
    if (process.listeners('uncaughtException').length === 0) {
      console.error(err)
      process.exit(1)
    }
  }
}

function firstPaintGrapheme(char: string | undefined): string {
  if (char === undefined || char.length === 0) return ' '
  for (const g of graphemes(char)) {
    if (graphemeWidth(g) > 0) return g
  }
  return ' '
}
