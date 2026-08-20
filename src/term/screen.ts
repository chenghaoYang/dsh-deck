/**
 * Double-buffered cell renderer. A wide grapheme occupies two slots; the
 * continuation is never flushed on its own. `put`/`fill` are 1-based so they
 * match `cursorTo` and Module D's layout rects.
 *
 * close() is idempotent and is hooked to exit / SIGINT / SIGTERM / SIGHUP /
 * uncaughtException so a crash cannot leave an invisible cursor, a stuck
 * OSC 9;4 bar, or a terminal still reporting mouse (`CSI ?1002l` `CSI ?1006l`).
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
  hyperlink,
  restoreTerminal,
  showCursor,
} from './ansi.ts'
import type { TerminalCapabilities } from './capabilities.ts'
import { graphemeWidth, graphemes } from './width.ts'

export interface Cell {
  char: string
  style: string
  width: 1 | 2
  link?: string
}

const EMPTY: Cell = { char: ' ', style: '', width: 1 }
const CONT: Cell = { char: '', style: '', width: 1 }

/** Button-event tracking + SGR encoding. Ghostty 1.3: VERIFIED. */
const MOUSE_ON = `${CSI}?1002h${CSI}?1006h`
const MOUSE_OFF = `${CSI}?1002l${CSI}?1006l`

function isCont(cell: Cell): boolean {
  return cell === CONT
}

function cellsEqual(a: Cell, b: Cell): boolean {
  if (isCont(a) || isCont(b)) return a === b
  return a.char === b.char && a.style === b.style && a.width === b.width && a.link === b.link
}

function resetGrid(grid: Cell[][]): void {
  for (const row of grid) row.fill(EMPTY)
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
  /** Recycled `#prev` from the last end(); reused as `#next` on the next begin(). */
  #spare: Cell[][] | undefined
  #opened = false
  #closed = false
  #mouseEnabled = false
  #cursorRow = -1
  #cursorCol = -1
  #style = ''
  #caretVisible = false

  constructor(out: NodeJS.WriteStream, caps: TerminalCapabilities) {
    this.#out = out
    this.#caps = caps
    // A pty can report a degenerate 1x1 (macOS `script` with piped stdio does);
    // fall back to COLUMNS/LINES, then sane defaults, so scripted runs render.
    this.#cols = sizeOf(out.columns, process.env.COLUMNS, 80)
    this.#rows = sizeOf(out.rows, process.env.LINES, 24)
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
    this.#write(
      altScreen(true) + hideCursor() + `${CSI}?2004h` + MOUSE_ON + eraseDisplay() + cursorTo(1, 1),
    )
    this.#mouseEnabled = true
    if (this.#caps.unicodeCore) this.#write('\u001b[?2027h')
    this.#out.on?.('resize', this.#onStreamResize)
    process.on('exit', this.#onExit)
    process.on('SIGINT', this.#onSigint)
    process.on('SIGTERM', this.#onSigterm)
    process.on('SIGHUP', this.#onSighup)
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
    process.removeListener('SIGHUP', this.#onSighup)
    process.removeListener('uncaughtException', this.#onUncaught)
    process.removeListener('uncaughtExceptionMonitor', this.#onUncaughtMonitor)
    // Always DECRST mouse here (even if already off). ansi.ts restoreTerminal
    // does not own 1002/1006; a crash must not leave the tty reporting mouse.
    this.#mouseEnabled = false
    this.#caretVisible = false
    this.#write(MOUSE_OFF + restoreTerminal())
  }

  /** Position and reveal the application caret after a completed frame. */
  showCursorAt(row: number, col: number): void {
    if (!this.#opened || this.#closed) return
    const nextRow = Math.max(1, row | 0)
    const nextCol = Math.max(1, col | 0)
    // The cell diff may have moved the terminal cursor to the last changed
    // cell since the previous frame, so reposition on every completed frame.
    let out = cursorTo(nextRow, nextCol)
    if (!this.#caretVisible) out += showCursor()
    this.#caretVisible = true
    this.#write(out)
  }

  /** Hide the application caret while a modal overlay owns the screen. */
  hideCursor(): void {
    if (!this.#opened || this.#closed || !this.#caretVisible) return
    this.#caretVisible = false
    this.#write(hideCursor())
  }

  /**
   * Runtime toggle so the app can restore native text selection. No-op after
   * close() — re-enabling post-restore would leak mouse reports into the shell.
   */
  setMouse(enabled: boolean): void {
    if (!this.#opened || this.#closed) return
    if (this.#mouseEnabled === enabled) return
    this.#mouseEnabled = enabled
    this.#write(enabled ? MOUSE_ON : MOUSE_OFF)
  }

  /** Enable mode 2027 after startup, e.g. `/doctor fix` filling unicodeCore. */
  enableUnicodeCore(): void {
    if (!this.#opened || this.#closed) return
    this.#write('\u001b[?2027h')
  }

  onResize(listener: (columns: number, rows: number) => void): () => void {
    this.#resizeListeners.add(listener)
    return () => {
      this.#resizeListeners.delete(listener)
    }
  }

  /** Start a new virtual frame. Reuses the previous write buffer when size is unchanged. */
  begin(): void {
    this.#syncSize()
    const rows = this.#rows
    const cols = this.#cols
    const existing = this.#next ?? this.#spare
    this.#spare = undefined
    if (
      existing !== undefined &&
      existing.length === rows &&
      (existing[0]?.length ?? 0) === cols
    ) {
      resetGrid(existing)
      this.#next = existing
    } else {
      this.#next = makeGrid(rows, cols)
    }
  }

  /**
   * Write text at a 1-based position with a style; clipped to bounds, wide
   * chars respected (never written as a half cell). `link` is an OSC 8 URI
   * applied to each written grapheme.
   */
  put(row: number, col: number, text: string, style?: string, link?: string): void {
    const grid = this.#next
    if (grid === undefined) return
    if (row < 1 || row > this.#rows) return
    const s = style ?? ''
    const href = link !== undefined && link.length > 0 ? link : undefined
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
      this.#place(grid, row - 1, c - 1, g, w, s, href)
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
    const grid = this.#next
    if (grid === undefined) return
    if (width <= 0 || height <= 0) return
    const fillChar = firstPaintGrapheme(char)
    const s = style ?? ''
    const w: 1 | 2 = graphemeWidth(fillChar) === 2 ? 2 : 1
    const ch = fillChar
    for (let r = 0; r < height; r++) {
      const absRow = row + r
      if (absRow < 1 || absRow > this.#rows) continue
      let c = 0
      while (c < width) {
        if (w === 2 && c + 2 > width) break
        const absCol = col + c
        if (absCol + w - 1 > this.#cols) break
        if (absCol >= 1) this.#place(grid, absRow - 1, absCol - 1, ch, w, s)
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
    this.#spare = this.#prev
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
    const glyph = cell.char.length > 0 ? cell.char : ' '
    const href = cell.link
    out +=
      this.#caps.hyperlinks && href !== undefined && href.length > 0
        ? hyperlink(href, glyph)
        : glyph
    this.#cursorRow = row
    this.#cursorCol = col + cell.width
    return out
  }

  #place(
    grid: Cell[][],
    row0: number,
    col0: number,
    char: string,
    width: 1 | 2,
    style: string,
    link?: string,
  ): void {
    const row = grid[row0]
    if (row === undefined) return
    this.#clearAt(row, col0)
    if (width === 2) this.#clearAt(row, col0 + 1)
    if (link !== undefined && link.length > 0) {
      row[col0] = { char, style, width, link }
    } else if (char === ' ' && style === '' && width === 1) {
      row[col0] = EMPTY
    } else {
      row[col0] = { char, style, width }
    }
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
    // Keep the last trustworthy size when the stream reports a degenerate one.
    const reportedCols = this.#out.columns
    const reportedRows = this.#out.rows
    const cols = typeof reportedCols === 'number' && reportedCols > 1 ? reportedCols : this.#cols
    const rows = typeof reportedRows === 'number' && reportedRows > 1 ? reportedRows : this.#rows
    if (cols === this.#cols && rows === this.#rows) return
    this.#cols = cols
    this.#rows = rows
    this.#prev = makeGrid(rows, cols)
    this.#next = undefined
    this.#spare = undefined
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

  #onSighup = (): void => {
    this.close()
    process.exit(129)
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

/** Stream size when it is trustworthy, else the env override, else the default. */
function sizeOf(reported: number | undefined, env: string | undefined, fallback: number): number {
  if (typeof reported === 'number' && reported > 1) return reported
  const parsed = Number(env)
  if (Number.isInteger(parsed) && parsed > 1) return parsed
  return fallback
}
