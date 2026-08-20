import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Rect } from '../src/ui/layout.ts'
import { lineText, type RenderedLine, type RenderTarget } from '../src/ui/render.ts'
import {
  beginDrag,
  endDrag,
  extractSelection,
  isEmptySelection,
  normalizeSelection,
  screenToPoint,
  selectedRange,
  updateDrag,
  type Selection,
} from '../src/ui/selection.ts'
import { renderTranscript } from '../src/ui/transcript.ts'
import type { Theme } from '../src/ui/theme.ts'
import { graphemes, stringWidth } from '../src/term/width.ts'

const theme: Theme = {
  base: 'BASE',
  dim: 'DIM',
  subtle: 'SUBTLE',
  text: 'TEXT',
  accent: 'ACCENT',
  user: 'USER',
  assistant: 'ASSISTANT',
  reasoning: 'REASONING',
  tool: 'TOOL',
  ok: 'OK',
  warn: 'WARN',
  error: 'ERROR',
  running: 'RUNNING',
  selected: 'SELECTED',
  border: 'BORDER',
  reset: 'RESET',
}

const rect: Rect = { row: 3, col: 5, width: 40, height: 10 }

function numberedLines(n: number): RenderedLine[] {
  const lines: RenderedLine[] = []
  for (let i = 0; i < n; i++) {
    lines.push({
      spans: [
        { text: `L${String(i).padStart(2, '0')} `, style: 'IDX' },
        { text: `body-${i}`, style: 'BODY' },
      ],
    })
  }
  return lines
}

function spans(...parts: [string, string][]): { spans: { text: string; style: string }[] } {
  return { spans: parts.map(([text, style]) => ({ text, style })) }
}

function sel(
  aLine: number,
  aCol: number,
  hLine: number,
  hCol: number,
): Selection {
  return { anchor: { line: aLine, column: aCol }, head: { line: hLine, column: hCol } }
}

class RecordTarget implements RenderTarget {
  readonly rowText = new Map<number, string>()
  put(row: number, _col: number, text: string, _style?: string): void {
    this.rowText.set(row, (this.rowText.get(row) ?? '') + text)
  }
  fill(_row: number, _col: number, _width: number, _height: number, _char?: string, _style?: string): void {}
}

function paintedRows(
  lines: readonly RenderedLine[],
  scrollOffset: number,
  r: Rect = rect,
): Map<number, string> {
  const target = new RecordTarget()
  renderTranscript(target, { rect: r, lines, scrollOffset, theme })
  return target.rowText
}

describe('screenToPoint', () => {
  it('matches renderTranscript windowing when totalLines > height', () => {
    const lines = numberedLines(24)
    for (const scroll of [0, 3, 14, 100]) {
      const painted = paintedRows(lines, scroll)
      for (let row = rect.row; row < rect.row + rect.height; row++) {
        const text = painted.get(row)
        const point = screenToPoint(rect, scroll, lines.length, row, rect.col)
        if (text === undefined) {
          assert.equal(point, undefined, `padding row ${row} scroll=${scroll}`)
          continue
        }
        assert.ok(point !== undefined, `painted row ${row} scroll=${scroll}`)
        const expected = lineText(lines[point.line] ?? { spans: [] })
        assert.equal(text, expected, `row ${row} scroll=${scroll} mapped to line ${point.line}`)
        assert.equal(point.column, 0)
      }
    }
  })

  it('matches renderTranscript when totalLines === height', () => {
    const lines = numberedLines(10)
    for (const scroll of [0, 4]) {
      const painted = paintedRows(lines, scroll)
      assert.equal(painted.size, 10)
      for (let i = 0; i < 10; i++) {
        const row = rect.row + i
        const point = screenToPoint(rect, scroll, lines.length, row, rect.col + 3)
        assert.deepEqual(point, { line: i, column: 3 })
        assert.equal(painted.get(row), lineText(lines[i] ?? { spans: [] }))
      }
    }
  })

  it('matches renderTranscript when totalLines < height and treats top rows as padding', () => {
    const lines = numberedLines(4)
    const painted = paintedRows(lines, 0)
    assert.equal(painted.size, 4)

    const padEnd = rect.row + (rect.height - 4)
    for (let row = rect.row; row < padEnd; row++) {
      assert.equal(painted.has(row), false)
      assert.equal(screenToPoint(rect, 0, lines.length, row, rect.col), undefined)
      assert.equal(screenToPoint(rect, 2, lines.length, row, rect.col + 8), undefined)
    }
    for (let i = 0; i < 4; i++) {
      const row = padEnd + i
      assert.equal(painted.get(row), lineText(lines[i] ?? { spans: [] }))
      assert.deepEqual(screenToPoint(rect, 0, lines.length, row, rect.col), { line: i, column: 0 })
      assert.deepEqual(screenToPoint(rect, 99, lines.length, row, rect.col + 7), { line: i, column: 7 })
    }
  })

  it('returns undefined outside the rect', () => {
    const n = 20
    assert.equal(screenToPoint(rect, 0, n, rect.row - 1, rect.col), undefined)
    assert.equal(screenToPoint(rect, 0, n, rect.row + rect.height, rect.col), undefined)
    assert.equal(screenToPoint(rect, 0, n, rect.row, rect.col - 1), undefined)
    assert.equal(screenToPoint(rect, 0, n, rect.row, rect.col + rect.width), undefined)
  })

  it('clamps a column past the pane only after a valid row hit; in-rect cols stay 0-based', () => {
    const n = 12
    const lastCol = rect.col + rect.width - 1
    assert.deepEqual(screenToPoint(rect, 0, n, rect.row, lastCol), { line: 2, column: 39 })
    assert.deepEqual(screenToPoint(rect, 0, n, rect.row, rect.col), { line: 2, column: 0 })
  })

  it('returns undefined for an empty pane or empty transcript', () => {
    assert.equal(screenToPoint({ ...rect, height: 0 }, 0, 10, 3, 5), undefined)
    assert.equal(screenToPoint({ ...rect, width: 0 }, 0, 10, 3, 5), undefined)
    assert.equal(screenToPoint(rect, 0, 0, rect.row + 9, rect.col), undefined)
  })
})

describe('normalizeSelection / isEmptySelection', () => {
  it('treats the same cell as empty', () => {
    const s = sel(2, 4, 2, 4)
    assert.equal(isEmptySelection(s), true)
    assert.deepEqual(normalizeSelection(s), { start: s.anchor, end: s.head })
  })

  it('orders reversed selections so start <= end', () => {
    const reversed = sel(4, 8, 1, 3)
    const { start, end } = normalizeSelection(reversed)
    assert.deepEqual(start, { line: 1, column: 3 })
    assert.deepEqual(end, { line: 4, column: 8 })
    assert.equal(isEmptySelection(reversed), false)

    const sameLine = sel(2, 9, 2, 1)
    const n = normalizeSelection(sameLine)
    assert.deepEqual(n.start, { line: 2, column: 1 })
    assert.deepEqual(n.end, { line: 2, column: 9 })
  })
})

describe('selectedRange', () => {
  it('returns a half-open range on a single line', () => {
    assert.deepEqual(selectedRange(sel(2, 3, 2, 8), 2, 20), { from: 3, to: 8 })
    assert.equal(selectedRange(sel(2, 3, 2, 8), 1, 20), undefined)
    assert.equal(selectedRange(sel(2, 5, 2, 5), 2, 20), undefined)
  })

  it('selects the full text width on middle lines', () => {
    const s = sel(1, 4, 4, 2)
    assert.deepEqual(selectedRange(s, 1, 10), { from: 4, to: 10 })
    assert.deepEqual(selectedRange(s, 2, 7), { from: 0, to: 7 })
    assert.deepEqual(selectedRange(s, 3, 0), undefined)
    assert.deepEqual(selectedRange(s, 4, 9), { from: 0, to: 2 })
    assert.equal(selectedRange(s, 0, 10), undefined)
    assert.equal(selectedRange(s, 5, 10), undefined)
  })

  it('works when anchor/head are reversed', () => {
    assert.deepEqual(selectedRange(sel(4, 2, 1, 4), 2, 7), { from: 0, to: 7 })
    assert.deepEqual(selectedRange(sel(2, 8, 2, 3), 2, 20), { from: 3, to: 8 })
  })

  it('clamps columns past the end of the line', () => {
    assert.deepEqual(selectedRange(sel(0, 2, 0, 99), 0, 5), { from: 2, to: 5 })
    assert.deepEqual(selectedRange(sel(0, -3, 0, 4), 0, 5), { from: 0, to: 4 })
    assert.equal(selectedRange(sel(0, 8, 0, 99), 0, 5), undefined)
    assert.deepEqual(selectedRange(sel(0, 10, 1, 2), 0, 5), undefined)
    assert.deepEqual(selectedRange(sel(0, 10, 1, 2), 1, 6), { from: 0, to: 2 })
  })
})

describe('extractSelection', () => {
  const hello = spans(['hel', 'A'], ['lo world  ', 'B'])
  const middle = spans(['full ', 'X'], ['middle', 'Y'])
  const tail = spans(['tail', 'P'], [' end', 'Q'])
  const lines = [hello, middle, tail]

  it('returns empty string for an empty selection', () => {
    assert.equal(extractSelection(lines, sel(1, 3, 1, 3)), '')
  })

  it('extracts a single-line partial across spans', () => {
    assert.equal(extractSelection(lines, sel(0, 3, 0, 8)), 'lo wo')
    assert.equal(extractSelection(lines, sel(0, 8, 0, 3)), 'lo wo')
  })

  it('includes full middle lines and strips trailing whitespace', () => {
    assert.equal(extractSelection(lines, sel(0, 6, 2, 4)), 'world\nfull middle\ntail')
    assert.equal(extractSelection(lines, sel(2, 4, 0, 6)), 'world\nfull middle\ntail')
  })

  it('never splits 中文: a grapheme is kept iff its first column is in range', () => {
    const cjk = [spans(['ab', 'LAT'], ['中文', 'CJK'], ['cd', 'LAT'])]
    assert.equal(stringWidth('ab中文cd'), 8)
    assert.equal(extractSelection(cjk, sel(0, 2, 0, 4)), '中')
    assert.equal(extractSelection(cjk, sel(0, 2, 0, 6)), '中文')
    // column 3 is the trailing cell of 中; first column 2 is outside [3, 5)
    assert.equal(extractSelection(cjk, sel(0, 3, 0, 5)), '文')
    assert.equal(extractSelection(cjk, sel(0, 3, 0, 4)), '')
    assert.equal(extractSelection(cjk, sel(0, 4, 0, 6)), '文')
    assert.equal(extractSelection(cjk, sel(0, 5, 0, 7)), 'c')
    assert.equal(extractSelection(cjk, sel(0, 0, 0, 2)), 'ab')
    assert.equal(extractSelection(cjk, sel(0, 6, 0, 8)), 'cd')

    const text = 'ab中文cd'
    const clusters = graphemes(text)
    const width = stringWidth(text)
    for (let from = 0; from <= width; from++) {
      for (let to = from; to <= width; to++) {
        const got = extractSelection(cjk, sel(0, from, 0, to))
        for (const g of graphemes(got)) {
          assert.ok(clusters.includes(g), `split cluster ${JSON.stringify(g)} from [${from},${to})`)
        }
        assert.ok(!got.includes('\uFFFD'))
      }
    }
  })

  it('clamps a column past the end of the line', () => {
    const short = [spans(['xy', 'A'], ['z', 'B'])]
    assert.equal(extractSelection(short, sel(0, 1, 0, 99)), 'yz')
    assert.equal(extractSelection(short, sel(0, 0, 0, 3)), 'xyz')
  })

  it('keeps a wide emoji cluster intact', () => {
    const flag = [spans(['go', 'A'], ['🇯🇵', 'B'], ['!', 'C'])]
    assert.equal(stringWidth('go🇯🇵!'), 5)
    assert.equal(extractSelection(flag, sel(0, 2, 0, 3)), '🇯🇵')
    assert.equal(extractSelection(flag, sel(0, 3, 0, 4)), '')
    assert.equal(extractSelection(flag, sel(0, 2, 0, 4)), '🇯🇵')
    assert.equal(extractSelection(flag, sel(0, 4, 0, 5)), '!')
  })
})

describe('drag state', () => {
  it('beginDrag on a cell starts an empty selection there', () => {
    const point = { line: 2, column: 4 }
    const started = beginDrag(point)
    assert.deepEqual(started, {
      selecting: true,
      selection: { anchor: point, head: point },
    })
    const startedSel = started.selection
    assert.ok(startedSel !== undefined)
    assert.equal(isEmptySelection(startedSel), true)
    assert.deepEqual(endDrag(started), { selection: undefined })
  })

  it('updateDrag moves head and ignores undefined points', () => {
    let state = beginDrag({ line: 0, column: 1 })
    state = updateDrag(state, { line: 2, column: 8 })
    assert.deepEqual(state.selection, {
      anchor: { line: 0, column: 1 },
      head: { line: 2, column: 8 },
    })
    const frozen = updateDrag(state, undefined)
    assert.equal(frozen, state)
    assert.deepEqual(endDrag(state), {
      selection: { anchor: { line: 0, column: 1 }, head: { line: 2, column: 8 } },
    })
  })

  it('mousedown outside the pane does not start a drag', () => {
    const idle = beginDrag(undefined)
    assert.deepEqual(idle, { selecting: false, selection: undefined })
    assert.deepEqual(updateDrag(idle, { line: 0, column: 0 }), idle)
    assert.deepEqual(endDrag(idle), { selection: undefined })
  })
})
