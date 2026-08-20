/**
 * Mouse selection over the transcript window.
 *
 * screenToPoint must match renderTranscript's windowing:
 *   visible = max(0, rect.height)
 *   maxScroll = max(0, totalLines - visible)
 *   offset = min(max(0, scrollOffset), maxScroll)
 *   end = totalLines - offset
 *   start = max(0, end - visible)
 *   row0 = rect.row
 * A grapheme is included iff its first display column is in the half-open range.
 */

import { graphemeWidth, graphemes, stringWidth } from '../term/width.ts'
import type { Rect } from './layout.ts'

export interface SelectionPoint {
  line: number
  column: number
}

export interface Selection {
  anchor: SelectionPoint
  head: SelectionPoint
}

export interface DragState {
  selecting: boolean
  selection: Selection | undefined
}

/** Map a terminal cell to a transcript position; undefined when outside the rect or on a padding row. Clamps col into the line. */
export function screenToPoint(
  rect: Rect,
  scrollOffset: number,
  totalLines: number,
  row: number,
  col: number,
): SelectionPoint | undefined {
  if (rect.width <= 0 || rect.height <= 0) return undefined
  if (row < rect.row || row >= rect.row + rect.height) return undefined
  if (col < rect.col || col >= rect.col + rect.width) return undefined

  const visible = Math.max(0, rect.height)
  const maxScroll = Math.max(0, totalLines - visible)
  const offset = Math.min(Math.max(0, scrollOffset), maxScroll)
  const end = totalLines - offset
  const start = Math.max(0, end - visible)
  const windowLength = Math.max(0, end - start)
  const row0 = rect.row
  if (row < row0 || row >= row0 + windowLength) return undefined

  const line = start + (row - row0)
  const column = Math.min(rect.width, Math.max(0, col - rect.col))
  return { line, column }
}

export function isEmptySelection(sel: Selection): boolean {
  return sel.anchor.line === sel.head.line && sel.anchor.column === sel.head.column
}

/** anchor/head in either order -> {start, end} with start <= end. */
export function normalizeSelection(sel: Selection): { start: SelectionPoint; end: SelectionPoint } {
  const { anchor, head } = sel
  if (anchor.line < head.line || (anchor.line === head.line && anchor.column <= head.column)) {
    return { start: anchor, end: head }
  }
  return { start: head, end: anchor }
}

/** For painting: the selected display-column range [from, to) on one rendered line, or undefined. Full lines between start.line and end.line select to the line's text width. */
export function selectedRange(
  sel: Selection,
  lineIndex: number,
  lineWidth: number,
): { from: number; to: number } | undefined {
  if (isEmptySelection(sel)) return undefined
  const { start, end } = normalizeSelection(sel)
  if (lineIndex < start.line || lineIndex > end.line) return undefined

  const width = Math.max(0, lineWidth)
  const clampCol = (column: number): number => Math.min(width, Math.max(0, column))

  let from: number
  let to: number
  if (lineIndex === start.line && lineIndex === end.line) {
    from = clampCol(start.column)
    to = clampCol(end.column)
  } else if (lineIndex === start.line) {
    from = clampCol(start.column)
    to = width
  } else if (lineIndex === end.line) {
    from = 0
    to = clampCol(end.column)
  } else {
    from = 0
    to = width
  }
  if (from >= to) return undefined
  return { from, to }
}

/** Extract the selected text: per-line span text sliced by display columns (never splitting a wide character — include it when its FIRST column is inside the range), lines joined with \n, trailing whitespace per line stripped. */
export function extractSelection(
  lines: readonly { spans: readonly { text: string }[] }[],
  sel: Selection,
): string {
  if (isEmptySelection(sel)) return ''
  const { start, end } = normalizeSelection(sel)
  const out: string[] = []
  for (let i = start.line; i <= end.line; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const text = concatSpans(line.spans)
    const width = stringWidth(text)
    const from = i === start.line ? start.column : 0
    const to = i === end.line ? end.column : width
    out.push(sliceByColumns(text, from, to).trimEnd())
  }
  return out.join('\n')
}

export function beginDrag(point: SelectionPoint | undefined): DragState {
  if (point === undefined) return { selecting: false, selection: undefined }
  return { selecting: true, selection: { anchor: point, head: point } }
}

export function updateDrag(state: DragState, point: SelectionPoint | undefined): DragState {
  if (point === undefined || !state.selecting || state.selection === undefined) return state
  return { selecting: true, selection: { anchor: state.selection.anchor, head: point } }
}

export function endDrag(state: DragState): { selection: Selection | undefined } {
  const sel = state.selection
  if (!state.selecting || sel === undefined || isEmptySelection(sel)) return { selection: undefined }
  return { selection: sel }
}

function concatSpans(spans: readonly { text: string }[]): string {
  let out = ''
  for (const span of spans) out += span.text
  return out
}

function sliceByColumns(text: string, from: number, to: number): string {
  const start = Math.max(0, from)
  const end = Math.max(start, to)
  if (end <= start) return ''
  let col = 0
  let out = ''
  for (const g of graphemes(text)) {
    if (col >= end) break
    const first = col
    col += graphemeWidth(g)
    if (first >= start && first < end) out += g
  }
  return out
}
