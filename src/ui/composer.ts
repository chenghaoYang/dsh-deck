/**
 * Draft editor. Caret column is measured on the full draft's wrapped layout —
 * wrapping the prefix alone can choose a different word boundary.
 */

import { stringWidth } from '../term/width.ts'
import type { Theme, Glyphs } from './theme.ts'
import type { Rect } from './layout.ts'
import {
  type RenderTarget,
  wrapLines,
  clearRect,
  clipToWidth,
  codePointSlice,
  codePointLength,
} from './render.ts'

export interface ComposerProps {
  rect: Rect
  draft: string
  /** Caret index into `draft`, in code points. */
  cursor: number
  mode: 'queue' | 'steer'
  busy: boolean
  theme: Theme
  glyphs: Glyphs
}

/** Zero-width, non-space marker used only to locate the caret after wrapping. */
const CARET_MARK = '\u2060'

/** Returns the absolute cursor position the shell should park the terminal caret at. */
export function renderComposer(target: RenderTarget, props: ComposerProps): { row: number; col: number } {
  const { rect, draft, busy, theme } = props
  clearRect(target, rect, theme.base)
  const fallback = { row: Math.max(1, rect.row), col: Math.max(1, rect.col) }
  if (rect.width <= 0 || rect.height <= 0) return fallback

  const ascii = process.env.DECK_ASCII === '1'
  const enter = ascii ? 'ret' : '⏎'
  const optionEnter = ascii ? 'alt+ret' : '⌥⏎'
  const modeText = busy ? `${enter} queue · ${optionEnter} steer` : `${enter} send`
  const modeW = stringWidth(modeText)
  const modeStyle = busy ? theme.accent : theme.dim

  const wrapWidth = Math.max(1, rect.width)
  const lines = wrapLines(draft, wrapWidth)
  const cur = Math.max(0, Math.min(props.cursor, codePointLength(draft)))
  const prefix = codePointSlice(draft, 0, cur)
  const suffix = codePointSlice(draft, cur)
  const markedLines = wrapLines(prefix + CARET_MARK + suffix, wrapWidth)
  const markedLine = Math.max(0, markedLines.findIndex((line) => line.includes(CARET_MARK)))
  const caretLineText = markedLines[markedLine] ?? CARET_MARK
  const caretLine = markedLine
  const caretOff = stringWidth(caretLineText.slice(0, caretLineText.indexOf(CARET_MARK)))

  const maxStart = Math.max(0, lines.length - rect.height)
  let start = maxStart
  if (caretLine < start) start = caretLine
  if (caretLine >= start + rect.height) start = Math.max(0, caretLine - rect.height + 1)
  if (start > maxStart) start = maxStart

  const view = lines.slice(start, start + rect.height)
  const modeReserve = modeW > 0 && modeW < rect.width ? modeW + 1 : 0
  for (let i = 0; i < view.length; i++) {
    const raw = view[i] ?? ''
    const budget = i === 0 && modeReserve > 0 ? rect.width - modeReserve : rect.width
    const text = clipToWidth(raw, budget).text
    if (text.length > 0) target.put(rect.row + i, rect.col, text, theme.text)
  }

  if (modeW > 0 && modeW <= rect.width) {
    target.put(rect.row, rect.col + rect.width - modeW, modeText, modeStyle)
  }

  const visRow = Math.max(0, Math.min(caretLine - start, rect.height - 1))
  const maxCol = rect.col + rect.width - 1
  const col = Math.max(rect.col, Math.min(rect.col + caretOff, maxCol))
  return { row: rect.row + visRow, col }
}
