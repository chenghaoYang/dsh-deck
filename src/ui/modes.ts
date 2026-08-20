/**
 * Per-session modes panel. Pure reducer + paint — the app shell owns RPC
 * (model / agent / permission / plan) and the store.
 *
 * Switching a mode keeps the panel open: the shell pushes a new projection
 * through updateModesRows so the row value refreshes in place.
 */

import type { Key } from '../term/input.ts'
import { stringWidth, truncate } from '../term/width.ts'
import type { Glyphs, Theme } from './theme.ts'
import type { Rect } from './layout.ts'
import {
  type RenderTarget,
  type Span,
  fitSpans,
  padTo,
  spansWidth,
} from './render.ts'
import { paintFloatingPanel, type OverlayLine } from './overlay.ts'

const PANEL_MAX_WIDTH = 64
const ROWS_FOOTER = '↑↓ move · ⏎ change · esc close'
const OPTIONS_FOOTER = '↑↓ move · ⏎ select · esc back'

/** Which dsh mode a row switches. */
export type ModeRowId = 'model' | 'agent' | 'permission' | 'plan'

export interface ModeOption {
  value: string
  label: string
  detail?: string
  /** Marks the option that is currently in effect. */
  current?: boolean
  /** Present when this option cannot be chosen; the string is the reason. */
  disabled?: string
}

export interface ModeRow {
  id: ModeRowId
  /** Left-hand label, e.g. "permission". */
  label: string
  /** Right-hand summary of the current value, e.g. "workspace-write". */
  value: string
  /** Title for the drilled-in option list, e.g. "agent preset". */
  optionsTitle?: string
  /** Absent or empty means the row is an action: enter fires it immediately. */
  options?: ModeOption[]
  /** Present when the row cannot be changed right now; the string is the reason. */
  disabled?: string
}

export interface ModesState {
  readonly rows: readonly ModeRow[]
  /** Index into rows. */
  readonly cursor: number
  readonly level: 'rows' | 'options'
  /** Index into rows[cursor].options; meaningless while level is 'rows'. */
  readonly optionCursor: number
}

export function createModes(rows: readonly ModeRow[]): ModesState {
  return {
    rows,
    cursor: 0,
    level: 'rows',
    optionCursor: 0,
  }
}

/**
 * Refresh the rows in place while the panel is open, keeping the cursor on the
 * same row id where possible. Needed because switching a mode makes the host
 * emit a new projection, and the panel must show the new value without closing.
 */
export function updateModesRows(state: ModesState, rows: readonly ModeRow[]): ModesState {
  const previous = state.rows[state.cursor]
  const previousId = previous?.id
  const at = previousId === undefined ? -1 : rows.findIndex((row) => row.id === previousId)
  const found = at >= 0
  const cursor = found ? at : clampIndex(state.cursor, rows.length)

  if (state.level !== 'options') {
    return { rows, cursor, level: 'rows', optionCursor: state.optionCursor }
  }

  const options = rowOptions(rows[cursor])
  if (!found || options.length === 0) {
    return { rows, cursor, level: 'rows', optionCursor: 0 }
  }
  return { rows, cursor, level: 'options', optionCursor: clampIndex(state.optionCursor, options.length) }
}

export type ModesResult =
  | { kind: 'continue'; state: ModesState }
  /** An option was selected on a switchable row. */
  | { kind: 'chose'; row: ModeRowId; value: string; state: ModesState }
  /** An action row was fired (no options). */
  | { kind: 'fired'; row: ModeRowId; state: ModesState }
  | { kind: 'cancelled' }

export function reduceModes(state: ModesState, key: Key): ModesResult {
  if (state.level === 'options') return reduceOptions(state, key)
  return reduceRows(state, key)
}

export function renderModes(
  target: RenderTarget,
  rect: Rect,
  state: ModesState,
  theme: Theme,
  glyphs: Glyphs,
): void {
  if (rect.width <= 0 || rect.height <= 0) return

  const layout = layoutModes(rect, state)
  const { panel } = layout
  const innerW = layout.listWidth
  const title = panelTitle(state)
  const footer = state.level === 'options' ? OPTIONS_FOOTER : ROWS_FOOTER

  const body: OverlayLine[] = []
  const start = layout.start
  for (let i = 0; i < layout.listHeight; i++) {
    const line = bodyLine(state, start + i, innerW, theme, glyphs)
    if (line === undefined) break
    body.push(line)
  }

  paintFloatingPanel(target, panel, theme, glyphs, title, body, footer)
}

/** Maps a click to what it hit, so the panel is mouse-operable. */
export function modesHitTest(
  state: ModesState,
  rect: Rect,
  row: number,
  col: number,
): { kind: 'row'; index: number } | { kind: 'option'; index: number } | undefined {
  if (rect.width <= 0 || rect.height <= 0) return undefined
  if (row < rect.row || row >= rect.row + rect.height) return undefined
  if (col < rect.col || col >= rect.col + rect.width) return undefined

  const layout = layoutModes(rect, state)
  if (layout.listHeight <= 0 || layout.listWidth <= 0) return undefined
  if (row < layout.listRow || row >= layout.listRow + layout.listHeight) return undefined
  if (col < layout.listCol || col >= layout.listCol + layout.listWidth) return undefined

  const index = layout.start + (row - layout.listRow)
  if (index < 0 || index >= layout.count) return undefined
  if (state.level === 'rows') return { kind: 'row', index }
  return { kind: 'option', index }
}

function reduceRows(state: ModesState, key: Key): ModesResult {
  if (key.kind === 'escape') return { kind: 'cancelled' }
  if (key.kind === 'up') {
    return { kind: 'continue', state: { ...state, cursor: clampIndex(state.cursor - 1, state.rows.length) } }
  }
  if (key.kind === 'down' || key.kind === 'tab') {
    return { kind: 'continue', state: { ...state, cursor: clampIndex(state.cursor + 1, state.rows.length) } }
  }
  if (key.kind !== 'enter') return { kind: 'continue', state }

  const row = state.rows[state.cursor]
  if (row === undefined) return { kind: 'continue', state }
  if (row.disabled !== undefined) return { kind: 'continue', state }

  const options = rowOptions(row)
  if (options.length === 0) return { kind: 'fired', row: row.id, state }

  const currentAt = options.findIndex((opt) => opt.current === true)
  return {
    kind: 'continue',
    state: { ...state, level: 'options', optionCursor: currentAt < 0 ? 0 : currentAt },
  }
}

function reduceOptions(state: ModesState, key: Key): ModesResult {
  if (key.kind === 'escape') {
    return { kind: 'continue', state: { ...state, level: 'rows' } }
  }

  const row = state.rows[state.cursor]
  const options = rowOptions(row)
  if (key.kind === 'up') {
    return { kind: 'continue', state: { ...state, optionCursor: clampIndex(state.optionCursor - 1, options.length) } }
  }
  if (key.kind === 'down' || key.kind === 'tab') {
    return { kind: 'continue', state: { ...state, optionCursor: clampIndex(state.optionCursor + 1, options.length) } }
  }
  if (key.kind !== 'enter') return { kind: 'continue', state }

  if (row === undefined) return { kind: 'continue', state }
  const option = options[state.optionCursor]
  if (option === undefined) return { kind: 'continue', state }
  if (option.disabled !== undefined) return { kind: 'continue', state }

  return {
    kind: 'chose',
    row: row.id,
    value: option.value,
    state: { ...state, level: 'rows' },
  }
}

function rowOptions(row: ModeRow | undefined): readonly ModeOption[] {
  const options = row?.options
  if (options === undefined) return []
  return options
}

function panelTitle(state: ModesState): string {
  if (state.level !== 'options') return 'modes'
  const row = state.rows[state.cursor]
  if (row === undefined) return 'modes'
  const titled = row.optionsTitle
  if (titled !== undefined && stringWidth(titled) > 0) return titled
  return row.label
}

function bodyLine(
  state: ModesState,
  index: number,
  innerW: number,
  theme: Theme,
  glyphs: Glyphs,
): OverlayLine | undefined {
  if (state.level === 'options') {
    const row = state.rows[state.cursor]
    const options = rowOptions(row)
    const option = options[index]
    if (option === undefined) return undefined
    const prefixW = optionPrefixWidth(glyphs)
    const labelW = maxLabelWidth(
      options.map((item) => item.label),
      Math.max(0, innerW - prefixW - 1),
    )
    return {
      spans: optionSpans(option, index === state.optionCursor, innerW, labelW, theme, glyphs),
    }
  }
  const row = state.rows[index]
  if (row === undefined) return undefined
  const prefixW = stringWidth(`${glyphs.arrow} `)
  const labelW = maxLabelWidth(
    state.rows.map((item) => item.label),
    Math.max(0, innerW - prefixW - 1),
  )
  return {
    spans: modeRowSpans(row, index === state.cursor, innerW, labelW, theme, glyphs),
  }
}

function optionPrefixWidth(glyphs: Glyphs): number {
  return stringWidth(glyphs.bar) + stringWidth(`${glyphs.arrow} `)
}

function maxLabelWidth(labels: readonly string[], budget: number): number {
  if (budget <= 0) return 0
  let max = 0
  for (const label of labels) {
    const w = stringWidth(label)
    if (w > max) max = w
  }
  return Math.min(max, budget)
}

function modeRowSpans(
  row: ModeRow,
  selected: boolean,
  innerW: number,
  labelW: number,
  theme: Theme,
  glyphs: Glyphs,
): Span[] {
  if (innerW <= 0) return []
  const disabled = row.disabled !== undefined
  const mark = selected ? `${glyphs.arrow} ` : '  '
  const markStyle = disabled ? theme.dim : selected ? theme.accent : theme.dim
  const labelStyle = disabled ? theme.dim : selected ? theme.selected : theme.text
  const valueStyle = disabled ? theme.dim : theme.subtle

  const spans: Span[] = [{ text: mark, style: markStyle }]
  const labelShown = padTo(truncate(row.label, labelW), labelW)
  if (stringWidth(labelShown) > 0) spans.push({ text: labelShown, style: labelStyle })
  pushTrailing(spans, innerW, row.value, valueStyle, row.disabled, theme.dim)
  return padSpansToWidth(spans, innerW)
}

function optionSpans(
  option: ModeOption,
  selected: boolean,
  innerW: number,
  labelW: number,
  theme: Theme,
  glyphs: Glyphs,
): Span[] {
  if (innerW <= 0) return []
  const disabled = option.disabled !== undefined
  const current = option.current === true
  const bar = current ? glyphs.bar : ' '
  const mark = selected ? `${glyphs.arrow} ` : '  '
  const barStyle = current ? theme.accent : theme.dim
  const markStyle = disabled ? theme.dim : selected ? theme.accent : theme.dim
  const labelStyle = disabled ? theme.dim : selected ? theme.selected : theme.text
  const detailStyle = disabled ? theme.dim : theme.subtle

  const spans: Span[] = [
    { text: bar, style: barStyle },
    { text: mark, style: markStyle },
  ]
  const labelShown = padTo(truncate(option.label, labelW), labelW)
  if (stringWidth(labelShown) > 0) spans.push({ text: labelShown, style: labelStyle })
  const detail = option.detail ?? ''
  pushTrailing(spans, innerW, detail, detailStyle, option.disabled, theme.dim)
  return padSpansToWidth(spans, innerW)
}

function pushTrailing(
  spans: Span[],
  innerW: number,
  primary: string,
  primaryStyle: string,
  reason: string | undefined,
  reasonStyle: string,
): void {
  // Remaining columns are display-width, never String.length — a CJK value
  // like 标准模式 is 4 code points but 8 cells, and padding by .length here
  // is what shoves the right border out and leaves stale cells next frame.
  let budget = innerW - spansWidth(spans)
  if (budget <= 1) return
  spans.push({ text: ' ', style: '' })
  budget -= 1

  const primaryShown = truncate(primary, budget)
  const primaryW = stringWidth(primaryShown)
  if (primaryW > 0) {
    spans.push({ text: primaryShown, style: primaryStyle })
    budget -= primaryW
  }
  if (reason === undefined || stringWidth(reason) === 0 || budget <= 1) return
  const shown = truncate(reason, budget - 1)
  if (stringWidth(shown) === 0) return
  spans.push({ text: ' ', style: '' })
  spans.push({ text: shown, style: reasonStyle })
}

/** Clip to `columns`, then pad with spaces so every row occupies the same cells. */
function padSpansToWidth(spans: readonly Span[], columns: number): Span[] {
  const fitted = fitSpans(spans, columns)
  const used = spansWidth(fitted)
  if (used >= columns) return fitted
  return [...fitted, { text: ' '.repeat(columns - used), style: '' }]
}

interface ModesLayout {
  panel: Rect
  listRow: number
  listCol: number
  listWidth: number
  listHeight: number
  start: number
  count: number
}

function layoutModes(rect: Rect, state: ModesState): ModesLayout {
  const count = listCount(state)
  const boxW = Math.max(4, Math.min(rect.width, PANEL_MAX_WIDTH))
  const desiredH = Math.min(rect.height, Math.max(5, count + 3))
  const panel = centerBox(rect, boxW, desiredH)
  const innerW = Math.max(0, panel.width - 2)
  const innerH = Math.max(0, panel.height - 2)
  const listHeight = Math.max(0, innerH - 1)
  const start = windowStart(count, listHeight, listCursor(state))
  return {
    panel,
    listRow: panel.row + 1,
    listCol: panel.col + 1,
    listWidth: innerW,
    listHeight,
    start,
    count,
  }
}

function listCount(state: ModesState): number {
  if (state.level === 'options') return rowOptions(state.rows[state.cursor]).length
  return state.rows.length
}

function listCursor(state: ModesState): number {
  if (state.level === 'options') return clampIndex(state.optionCursor, listCount(state))
  return clampIndex(state.cursor, state.rows.length)
}

function windowStart(count: number, height: number, cursor: number): number {
  if (count <= height || height <= 0) return 0
  const maxStart = count - height
  let start = cursor - Math.floor(height / 2)
  if (start < 0) start = 0
  if (start > maxStart) start = maxStart
  return start
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0
  if (index < 0) return 0
  if (index >= length) return length - 1
  return index
}

function centerBox(rect: Rect, width: number, height: number): Rect {
  const w = Math.max(0, Math.min(width, Math.max(0, rect.width)))
  const h = Math.max(0, Math.min(height, Math.max(0, rect.height)))
  return {
    row: rect.row + Math.floor((Math.max(0, rect.height) - h) / 2),
    col: rect.col + Math.floor((Math.max(0, rect.width) - w) / 2),
    width: w,
    height: h,
  }
}
