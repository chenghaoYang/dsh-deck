/**
 * Shared paint primitives. Widgets never write to stdout; they draw through
 * a RenderTarget (Screen at runtime, a recording/bounds target in tests).
 *
 * Coordinates are 1-based to match Rect / cursor addressing. Every clip walks
 * grapheme clusters so a 2-column CJK/emoji cell is never split.
 */

import { stringWidth, wrap } from '../term/width.ts'
import type { Glyphs } from './theme.ts'
import type { Rect } from './layout.ts'

export interface RenderTarget {
  put(row: number, col: number, text: string, style?: string, link?: string): void
  fill(row: number, col: number, width: number, height: number, char?: string, style?: string): void
}

export interface Span {
  text: string
  style: string
  /** OSC 8 href; omit when the span is not a hyperlink. */
  link?: string
}

export interface RenderedLine {
  spans: Span[]
  /** Set on the first line of a turn so the shell can emit OSC 133 turn marks. */
  anchor?: { kind: 'turn'; turn: number }
}

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

export function clipToWidth(text: string, columns: number): { text: string; width: number } {
  if (columns <= 0 || text.length === 0) return { text: '', width: 0 }
  let width = 0
  let out = ''
  for (const { segment } of segmenter.segment(text)) {
    const w = stringWidth(segment)
    if (width + w > columns) break
    out += segment
    width += w
  }
  return { text: out, width }
}

/** Pad (or clip) so the result occupies at most `columns` display columns. */
export function padTo(text: string, columns: number): string {
  if (columns <= 0) return ''
  const clipped = clipToWidth(text, columns)
  if (clipped.width >= columns) return clipped.text
  return clipped.text + ' '.repeat(columns - clipped.width)
}

export function repeatToWidth(unit: string, columns: number): string {
  if (columns <= 0) return ''
  const uw = stringWidth(unit)
  if (uw <= 0) return ' '.repeat(columns)
  const n = Math.floor(columns / uw)
  return padTo(unit.repeat(n), columns)
}

export function spansWidth(spans: readonly Span[]): number {
  let width = 0
  for (const span of spans) width += stringWidth(span.text)
  return width
}

export function lineText(line: RenderedLine): string {
  let out = ''
  for (const span of line.spans) out += span.text
  return out
}

export function fitSpans(spans: readonly Span[], columns: number): Span[] {
  if (columns <= 0) return []
  const out: Span[] = []
  let used = 0
  for (const span of spans) {
    if (used >= columns) break
    const clipped = clipToWidth(span.text, columns - used)
    if (clipped.text.length === 0) {
      if (stringWidth(span.text) > 0) break
      continue
    }
    if (span.link === undefined) out.push({ text: clipped.text, style: span.style })
    else out.push({ text: clipped.text, style: span.style, link: span.link })
    used += clipped.width
  }
  return out
}

export function makeLine(spans: readonly Span[], columns: number, anchor?: RenderedLine['anchor']): RenderedLine {
  const fitted = fitSpans(spans, columns)
  if (anchor !== undefined) return { spans: fitted, anchor }
  return { spans: fitted }
}

/**
 * Paragraph-aware wrap that never exceeds `columns`. Prefers Module C's wrap
 * (word boundaries) and hard-breaks on grapheme clusters if a line is still wide.
 */
export function wrapLines(text: string, columns: number): string[] {
  const cols = Math.max(1, columns)
  const paragraphs = text.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  for (const paragraph of paragraphs) {
    if (paragraph === '') {
      out.push('')
      continue
    }
    const wrapped = wrap(paragraph, cols)
    if (wrapped.length === 0) {
      out.push('')
      continue
    }
    for (const line of wrapped) {
      if (stringWidth(line) <= cols) out.push(line)
      else out.push(...hardWrap(line, cols))
    }
  }
  return out.length > 0 ? out : ['']
}

function hardWrap(text: string, columns: number): string[] {
  const lines: string[] = []
  let current = ''
  let width = 0
  for (const { segment } of segmenter.segment(text)) {
    const w = stringWidth(segment)
    if (w > columns) continue
    if (width + w > columns && current.length > 0) {
      lines.push(current)
      current = ''
      width = 0
    }
    current += segment
    width += w
  }
  if (current.length > 0) lines.push(current)
  return lines.length > 0 ? lines : ['']
}

/** Paint spans starting at a column, clipping to `width` display columns. */
export function paintLine(
  target: RenderTarget,
  row: number,
  col: number,
  width: number,
  line: RenderedLine,
): void {
  if (width <= 0) return
  let x = 0
  for (const span of line.spans) {
    if (x >= width) break
    const clipped = clipToWidth(span.text, width - x)
    if (clipped.text.length === 0) {
      if (stringWidth(span.text) > 0) break
      continue
    }
    target.put(row, col + x, clipped.text, span.style, span.link)
    x += clipped.width
  }
}

export function clearRect(target: RenderTarget, rect: Rect, style = ''): void {
  if (rect.width <= 0 || rect.height <= 0) return
  target.fill(rect.row, rect.col, rect.width, rect.height, ' ', style)
}

export function spinnerGlyph(glyphs: Glyphs, frame: number): string {
  const frames = glyphs.running
  if (frames.length === 0) return ''
  const i = ((frame % frames.length) + frames.length) % frames.length
  return frames[i] ?? ''
}

export function codePointSlice(text: string, start: number, end?: number): string {
  return [...text].slice(start, end).join('')
}

export function codePointLength(text: string): number {
  return [...text].length
}

/** Case-insensitive subsequence match used by palettes (slash, sessions, models). */
export function isSubsequence(query: string, haystack: string): boolean {
  if (query.length === 0) return true
  const needle = [...query.toLocaleLowerCase()]
  let i = 0
  for (const ch of haystack.toLocaleLowerCase()) {
    if (ch === needle[i]) {
      i++
      if (i >= needle.length) return true
    }
  }
  return false
}
