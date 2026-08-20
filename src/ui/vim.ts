/**
 * Prompt-composer vim reducer. Pure — no I/O, no scrollback.
 * Scrollback park (j/k g/G, i to return) stays in app.ts; this only maps
 * keys while the composer has focus (`simple_mode=false` half of Grok vim).
 */

import type { Key } from '../term/input.ts'

const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' })

export type VimInsertMode = 'insert' | 'normal'

export interface VimComposerState {
  draft: string
  /** Code-point index into draft (same as app.ts composer cursor). */
  cursor: number
  mode: VimInsertMode
  /** Last deleted text for `p`. Omit when empty — exactOptionalPropertyTypes. */
  yank?: string
}

export type VimComposerResult =
  | { kind: 'continue'; state: VimComposerState }
  | { kind: 'park'; state: VimComposerState }
  | { kind: 'send'; state: VimComposerState }
  | { kind: 'unhandled' }

export function reduceVimComposer(state: VimComposerState, key: Key): VimComposerResult {
  switch (key.kind) {
    case 'ctrl':
    case 'alt':
    case 'tab':
    case 'pageup':
    case 'pagedown':
    case 'mouse':
    case 'wheel':
    case 'unknown':
      return { kind: 'unhandled' }
    default:
      break
  }
  return state.mode === 'insert' ? reduceInsert(state, key) : reduceNormal(state, key)
}

function reduceInsert(state: VimComposerState, key: Key): VimComposerResult {
  switch (key.kind) {
    case 'escape':
      return cont(apply(state, { mode: 'normal' }))
    case 'enter':
      return { kind: 'send', state: apply(state, {}) }
    case 'char':
      return cont(insertText(state, key.char))
    case 'paste':
      return cont(insertText(state, key.text))
    case 'backspace':
      return cont(deleteBefore(state, false))
    case 'word-backspace':
      return cont(deleteWordBefore(state))
    case 'delete':
      return cont(deleteUnder(state, false))
    case 'left':
      return cont(moveGrapheme(state, -1))
    case 'right':
      return cont(moveGrapheme(state, 1))
    case 'home':
      return cont(apply(state, { cursor: 0 }))
    case 'end':
      return cont(apply(state, { cursor: codePointLength(state.draft) }))
    case 'modified-enter':
      if (key.shift && !key.alt && !key.ctrl && !key.super) return cont(insertText(state, '\n'))
      return { kind: 'unhandled' }
    default:
      return { kind: 'unhandled' }
  }
}

function reduceNormal(state: VimComposerState, key: Key): VimComposerResult {
  switch (key.kind) {
    case 'escape':
      return { kind: 'park', state: apply(state, {}) }
    case 'enter':
      return cont(apply(state, {}))
    case 'left':
      return cont(moveGrapheme(state, -1))
    case 'right':
      return cont(moveGrapheme(state, 1))
    case 'up':
      return cont(moveVertical(state, -1))
    case 'down':
      return cont(moveVertical(state, 1))
    case 'home':
      return cont(apply(state, { cursor: lineStart(state.draft, state.cursor) }))
    case 'end':
      return cont(apply(state, { cursor: lineEnd(state.draft, state.cursor) }))
    case 'delete':
      return cont(deleteUnder(state, true))
    case 'backspace':
      return cont(deleteBefore(state, true))
    case 'char':
      return reduceNormalChar(state, key.char)
    default:
      return cont(apply(state, {}))
  }
}

function reduceNormalChar(state: VimComposerState, char: string): VimComposerResult {
  switch (char) {
    case 'i':
      return cont(apply(state, { mode: 'insert' }))
    case 'a':
      return cont(apply(state, { mode: 'insert', cursor: nextGraphemeBoundary(state.draft, clampCursor(state)) }))
    case 'I':
      return cont(apply(state, { mode: 'insert', cursor: 0 }))
    case 'A':
      return cont(apply(state, { mode: 'insert', cursor: codePointLength(state.draft) }))
    case 'h':
      return cont(moveGrapheme(state, -1))
    case 'l':
      return cont(moveGrapheme(state, 1))
    case '0':
      return cont(apply(state, { cursor: lineStart(state.draft, state.cursor) }))
    case '^':
      return cont(apply(state, { cursor: firstNonSpace(state.draft, state.cursor) }))
    case '$':
      return cont(apply(state, { cursor: lineEnd(state.draft, state.cursor) }))
    case 'w':
      return cont(apply(state, { cursor: wordForward(state.draft, clampCursor(state)) }))
    case 'b':
      return cont(apply(state, { cursor: wordBack(state.draft, clampCursor(state)) }))
    case 'x':
      return cont(deleteUnder(state, true))
    case 'X':
      return cont(deleteBefore(state, true))
    case 'D':
      return cont(deleteToLineEnd(state))
    case 'p':
      return cont(pasteYank(state, 'after'))
    case 'P':
      return cont(pasteYank(state, 'before'))
    case 'j':
      return cont(moveVertical(state, 1))
    case 'k':
      return cont(moveVertical(state, -1))
    default:
      return cont(apply(state, {}))
  }
}

function cont(state: VimComposerState): VimComposerResult {
  return { kind: 'continue', state }
}

function apply(
  state: VimComposerState,
  patch: { draft?: string; cursor?: number; mode?: VimInsertMode; yank?: string },
): VimComposerState {
  const draft = patch.draft ?? state.draft
  const next: VimComposerState = {
    draft,
    cursor: clampCursor({ draft, cursor: patch.cursor ?? state.cursor }),
    mode: patch.mode ?? state.mode,
  }
  const yank = patch.yank ?? state.yank
  if (yank !== undefined && yank.length > 0) next.yank = yank
  return next
}

function clampCursor(state: { draft: string; cursor: number }): number {
  return Math.max(0, Math.min(state.cursor, codePointLength(state.draft)))
}

function sanitize(text: string): string {
  return text.replace(/\r/g, '').replace(/\t/g, ' ').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
}

function insertText(state: VimComposerState, text: string): VimComposerState {
  const clean = sanitize(text)
  if (clean.length === 0) return apply(state, {})
  const cur = clampCursor(state)
  const chars = [...state.draft]
  const draft = chars.slice(0, cur).join('') + clean + chars.slice(cur).join('')
  return apply(state, { draft, cursor: cur + codePointLength(clean) })
}

function deleteBefore(state: VimComposerState, saveYank: boolean): VimComposerState {
  const cur = clampCursor(state)
  const prev = previousGraphemeBoundary(state.draft, cur)
  if (prev === cur) return apply(state, {})
  return splice(state, prev, cur, prev, saveYank)
}

function deleteUnder(state: VimComposerState, saveYank: boolean): VimComposerState {
  const cur = clampCursor(state)
  const start = graphemeBoundaryAtOrBefore(state.draft, cur)
  const end = nextGraphemeBoundary(state.draft, start)
  if (end <= start) return apply(state, {})
  return splice(state, start, end, start, saveYank)
}

function deleteToLineEnd(state: VimComposerState): VimComposerState {
  const cur = clampCursor(state)
  const end = lineEnd(state.draft, cur)
  if (end <= cur) return apply(state, {})
  return splice(state, cur, end, cur, true)
}

function deleteWordBefore(state: VimComposerState): VimComposerState {
  const end = graphemeBoundaryAtOrBefore(state.draft, clampCursor(state))
  let i = end
  while (i > 0) {
    const start = previousGraphemeBoundary(state.draft, i)
    if (codePointSlice(state.draft, start, i) !== ' ') break
    i = start
  }
  while (i > 0) {
    const start = previousGraphemeBoundary(state.draft, i)
    if (codePointSlice(state.draft, start, i) === ' ') break
    i = start
  }
  if (i === end) return apply(state, {})
  return splice(state, i, end, i, false)
}

function splice(
  state: VimComposerState,
  start: number,
  end: number,
  cursor: number,
  saveYank: boolean,
): VimComposerState {
  const chars = [...state.draft]
  const deleted = chars.slice(start, end).join('')
  chars.splice(start, end - start)
  const draft = chars.join('')
  if (saveYank && deleted.length > 0) return apply(state, { draft, cursor, yank: deleted })
  return apply(state, { draft, cursor })
}

function pasteYank(state: VimComposerState, where: 'before' | 'after'): VimComposerState {
  const yanked = state.yank
  if (yanked === undefined || yanked.length === 0) return apply(state, {})
  const cur = clampCursor(state)
  const at = where === 'after' ? nextGraphemeBoundary(state.draft, cur) : cur
  return insertText(apply(state, { cursor: at }), yanked)
}

function moveGrapheme(state: VimComposerState, dir: -1 | 1): VimComposerState {
  const cur = clampCursor(state)
  const cursor = dir < 0
    ? previousGraphemeBoundary(state.draft, cur)
    : nextGraphemeBoundary(state.draft, cur)
  return apply(state, { cursor })
}

function moveVertical(state: VimComposerState, dir: -1 | 1): VimComposerState {
  const cur = clampCursor(state)
  const start = lineStart(state.draft, cur)
  const end = lineEnd(state.draft, cur)
  const col = cur - start
  if (dir > 0) {
    if (end >= codePointLength(state.draft)) return apply(state, {})
    const nextStart = end + 1
    const nextEnd = lineEnd(state.draft, nextStart)
    return apply(state, { cursor: nextStart + Math.min(col, nextEnd - nextStart) })
  }
  if (start === 0) return apply(state, {})
  const prevEnd = start - 1
  const prevStart = lineStart(state.draft, prevEnd)
  return apply(state, { cursor: prevStart + Math.min(col, prevEnd - prevStart) })
}

function lineStart(text: string, cursor: number): number {
  const chars = [...text]
  const cur = Math.max(0, Math.min(cursor, chars.length))
  let start = 0
  for (let i = 0; i < cur; i++) {
    if (chars[i] === '\n') start = i + 1
  }
  return start
}

function lineEnd(text: string, cursor: number): number {
  const chars = [...text]
  const cur = Math.max(0, Math.min(cursor, chars.length))
  for (let i = cur; i < chars.length; i++) {
    if (chars[i] === '\n') return i
  }
  return chars.length
}

function firstNonSpace(text: string, cursor: number): number {
  const start = lineStart(text, cursor)
  const end = lineEnd(text, cursor)
  const chars = [...text]
  for (let i = start; i < end; i++) {
    const ch = chars[i]
    if (ch !== ' ' && ch !== '\t') return i
  }
  return start
}

function isWordSpace(cluster: string): boolean {
  return cluster === ' ' || cluster === '\t' || cluster === '\n'
}

function wordForward(text: string, cursor: number): number {
  const end = codePointLength(text)
  let i = cursor
  while (i < end && !isWordSpace(graphemeAt(text, i))) i = nextGraphemeBoundary(text, i)
  while (i < end && isWordSpace(graphemeAt(text, i))) i = nextGraphemeBoundary(text, i)
  return i
}

function wordBack(text: string, cursor: number): number {
  if (cursor <= 0) return 0
  let i = previousGraphemeBoundary(text, cursor)
  while (i > 0 && isWordSpace(graphemeAt(text, i))) i = previousGraphemeBoundary(text, i)
  while (i > 0) {
    const prev = previousGraphemeBoundary(text, i)
    if (isWordSpace(graphemeAt(text, prev))) break
    i = prev
  }
  return i
}

function graphemeAt(text: string, cursor: number): string {
  const cur = Math.max(0, Math.min(cursor, codePointLength(text)))
  if (cur >= codePointLength(text)) return ''
  const start = graphemeBoundaryAtOrBefore(text, cur)
  return codePointSlice(text, start, nextGraphemeBoundary(text, start))
}

function graphemesOf(text: string): string[] {
  const out: string[] = []
  for (const part of SEGMENTER.segment(text)) out.push(part.segment)
  return out
}

function codePointLength(text: string): number {
  return [...text].length
}

function codePointSlice(text: string, start: number, end?: number): string {
  return [...text].slice(start, end).join('')
}

function previousGraphemeBoundary(text: string, cursor: number): number {
  let offset = 0
  for (const cluster of graphemesOf(text)) {
    const next = offset + codePointLength(cluster)
    if (cursor <= next) return offset
    offset = next
  }
  return offset
}

function graphemeBoundaryAtOrBefore(text: string, cursor: number): number {
  let offset = 0
  for (const cluster of graphemesOf(text)) {
    const next = offset + codePointLength(cluster)
    if (cursor < next) return offset
    offset = next
  }
  return offset
}

function nextGraphemeBoundary(text: string, cursor: number): number {
  let offset = 0
  for (const cluster of graphemesOf(text)) {
    const next = offset + codePointLength(cluster)
    if (cursor < next) return next
    offset = next
  }
  return offset
}
