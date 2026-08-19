/**
 * Draft editor. Caret column is stringWidth of the code-point prefix on the
 * wrapped line that contains the caret — CJK must not be counted as 1.
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

/** Returns the absolute cursor position the shell should park the terminal caret at. */
export function renderComposer(target: RenderTarget, props: ComposerProps): { row: number; col: number } {
  const { rect, draft, mode, busy, theme } = props
  clearRect(target, rect, theme.base)
  const fallback = { row: Math.max(1, rect.row), col: Math.max(1, rect.col) }
  if (rect.width <= 0 || rect.height <= 0) return fallback

  const ascii = process.env.DECK_ASCII === '1'
  const enter = ascii ? 'ret' : '⏎'
  const modeText = `${mode} ${enter}`
  const modeW = stringWidth(modeText)
  const modeStyle = busy ? theme.running : theme.dim

  const wrapWidth = Math.max(1, rect.width)
  const lines = wrapLines(draft, wrapWidth)
  const cur = Math.max(0, Math.min(props.cursor, codePointLength(draft)))
  const prefix = codePointSlice(draft, 0, cur)
  const prefixLines = prefix.length === 0 ? [''] : wrapLines(prefix, wrapWidth)
  const caretLine = Math.max(0, prefixLines.length - 1)
  const caretOff = stringWidth(prefixLines[caretLine] ?? '')

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
