/**
 * Fuzzy session palette. Pure reducer + paint — the app shell owns RPC
 * (workspace.archiveSession, session.rename, session.create) and the store.
 *
 * Archived sessions are already hidden by DeckStore.sessions; this overlay
 * only sees the entries the shell pushes in.
 */

import type { Key } from '../term/input.ts'
import { stringWidth, truncate } from '../term/width.ts'
import type { Glyphs, Theme } from './theme.ts'
import type { Rect } from './layout.ts'
import {
  type RenderTarget,
  type Span,
  clearRect,
  clipToWidth,
  paintLine,
  repeatToWidth,
} from './render.ts'

const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' })

const LIST_FOOTER = '⏎ focus · del archive · ^r rename · ^n new · esc close'
const RENAME_FOOTER = 'enter save · esc back'
const ARCHIVE_FOOTER = 'enter archive · esc back'

export interface SwitcherEntry {
  id: string
  title: string
  cwd?: string
  running: boolean
  unread: number
  blocked: boolean
  updatedAt: number
}

export interface SwitcherState {
  entries: readonly SwitcherEntry[]
  filter: string
  cursor: number
  stage: 'list' | 'rename' | 'confirm-archive'
  renameId: string
  renameDraft: string
  archiveId: string
}

export type SwitcherResult =
  | { kind: 'continue'; state: SwitcherState }
  | { kind: 'focus'; id: string }
  | { kind: 'archive'; id: string; state: SwitcherState }
  | { kind: 'rename'; id: string; title: string }
  | { kind: 'create' }
  | { kind: 'cancelled' }

export function createSwitcher(entries: readonly SwitcherEntry[], focusedId?: string): SwitcherState {
  const at = focusedId === undefined ? -1 : entries.findIndex((entry) => entry.id === focusedId)
  return {
    entries,
    filter: '',
    cursor: at < 0 ? 0 : at,
    stage: 'list',
    renameId: '',
    renameDraft: '',
    archiveId: '',
  }
}

export function updateSwitcherEntries(
  state: SwitcherState,
  entries: readonly SwitcherEntry[],
): SwitcherState {
  const next: SwitcherState = { ...state, entries }
  if (state.stage === 'rename' && !entries.some((entry) => entry.id === state.renameId)) {
    next.stage = 'list'
    next.renameId = ''
    next.renameDraft = ''
  }
  if (state.stage === 'confirm-archive' && !entries.some((entry) => entry.id === state.archiveId)) {
    next.stage = 'list'
    next.archiveId = ''
  }
  next.cursor = clampIndex(state.cursor, filteredEntries(next).length)
  return next
}

export function reduceSwitcher(state: SwitcherState, key: Key): SwitcherResult {
  if (state.stage === 'rename') return reduceRename(state, key)
  if (state.stage === 'confirm-archive') return reduceArchive(state, key)

  if (key.kind === 'escape') return { kind: 'cancelled' }
  if (key.kind === 'ctrl' && key.char.toLowerCase() === 'n') return { kind: 'create' }
  if (key.kind === 'ctrl' && key.char.toLowerCase() === 'r') {
    const entry = highlighted(state)
    if (entry === undefined) return { kind: 'continue', state }
    return {
      kind: 'continue',
      state: { ...state, stage: 'rename', renameId: entry.id, renameDraft: entry.title },
    }
  }
  if (
    key.kind === 'delete'
    || (key.kind === 'ctrl' && ['d', 'x'].includes(key.char.toLowerCase()))
  ) {
    const entry = highlighted(state)
    if (entry === undefined) return { kind: 'continue', state }
    return {
      kind: 'continue',
      state: { ...state, stage: 'confirm-archive', archiveId: entry.id },
    }
  }

  if (key.kind === 'paste') return { kind: 'continue', state: withFilter(state, state.filter + key.text) }
  if (key.kind === 'backspace') return { kind: 'continue', state: withFilter(state, popGrapheme(state.filter)) }
  if (isPrintableChar(key)) return { kind: 'continue', state: withFilter(state, state.filter + key.char) }

  const list = filteredEntries(state)
  if (key.kind === 'up') {
    return { kind: 'continue', state: { ...state, cursor: clampIndex(state.cursor - 1, list.length) } }
  }
  if (key.kind === 'down') {
    return { kind: 'continue', state: { ...state, cursor: clampIndex(state.cursor + 1, list.length) } }
  }
  if (key.kind !== 'enter') return { kind: 'continue', state }

  const entry = list[state.cursor]
  if (entry === undefined) return { kind: 'continue', state }
  return { kind: 'focus', id: entry.id }
}

export function renderSwitcher(
  target: RenderTarget,
  rect: Rect,
  state: SwitcherState,
  theme: Theme,
  glyphs: Glyphs,
): void {
  if (rect.width <= 0 || rect.height <= 0) return

  const boxW = Math.max(4, Math.min(rect.width, 64))
  const list = filteredEntries(state)
  const rows = state.stage === 'confirm-archive' ? 2 : 1 + Math.max(1, list.length)
  const desiredH = Math.min(rect.height, Math.max(5, rows + 3))
  const panel = centerBox(rect, boxW, desiredH)
  const innerW = Math.max(0, panel.width - 2)
  const innerH = Math.max(0, panel.height - 2)
  if (state.stage === 'confirm-archive') {
    const entry = state.entries.find((item) => item.id === state.archiveId)
    const body: OverlayLine[] = [
      { spans: [{ text: truncate(`Archive “${entry?.title ?? state.archiveId}”?`, innerW), style: theme.warn }] },
      { spans: [{ text: 'It disappears from Deck; its conversation log stays on disk.', style: theme.dim }] },
    ]
    paintPanel(target, rect, panel, theme, glyphs, 'archive session', body, ARCHIVE_FOOTER)
    return
  }
  const title = state.stage === 'rename' ? 'rename' : 'sessions'
  const footer = state.stage === 'rename' ? RENAME_FOOTER : LIST_FOOTER

  const body: OverlayLine[] = []
  if (innerH >= 2 && innerW > 0) {
    body.push({ spans: [{ text: truncate(`/${state.filter}`, innerW), style: theme.subtle }] })
  }
  const listH = Math.max(0, innerH - 1 - body.length)
  const cursor = clampIndex(state.cursor, list.length)
  const start = windowStart(list.length, listH, cursor)
  const now = Date.now()
  for (let i = 0; i < listH; i++) {
    const entry = list[start + i]
    if (entry === undefined) break
    const selected = start + i === cursor
    body.push({
      spans: rowSpans(entry, selected, innerW, state, theme, glyphs, now),
    })
  }

  paintPanel(target, rect, panel, theme, glyphs, title, body, footer)
}

function reduceRename(state: SwitcherState, key: Key): SwitcherResult {
  if (key.kind === 'escape') {
    return {
      kind: 'continue',
      state: { ...state, stage: 'list', renameId: '', renameDraft: '' },
    }
  }
  if (key.kind === 'paste') {
    return { kind: 'continue', state: { ...state, renameDraft: state.renameDraft + key.text } }
  }
  if (key.kind === 'backspace') {
    return { kind: 'continue', state: { ...state, renameDraft: popGrapheme(state.renameDraft) } }
  }
  if (isPrintableChar(key)) {
    return { kind: 'continue', state: { ...state, renameDraft: state.renameDraft + key.char } }
  }
  if (key.kind !== 'enter') return { kind: 'continue', state }
  return { kind: 'rename', id: state.renameId, title: state.renameDraft }
}

function reduceArchive(state: SwitcherState, key: Key): SwitcherResult {
  if (key.kind === 'escape') {
    return { kind: 'continue', state: { ...state, stage: 'list', archiveId: '' } }
  }
  if (key.kind !== 'enter') return { kind: 'continue', state }
  return {
    kind: 'archive',
    id: state.archiveId,
    state: { ...state, stage: 'list', archiveId: '' },
  }
}

function withFilter(state: SwitcherState, filter: string): SwitcherState {
  return { ...state, filter, cursor: 0 }
}

function filteredEntries(state: SwitcherState): SwitcherEntry[] {
  return state.entries.filter((entry) => isSubsequence(state.filter, entryHaystack(entry)))
}

function highlighted(state: SwitcherState): SwitcherEntry | undefined {
  return filteredEntries(state)[state.cursor]
}

function entryHaystack(entry: SwitcherEntry): string {
  const base = cwdBasename(entry.cwd)
  return base.length > 0 ? `${entry.title} ${base}` : entry.title
}

function cwdBasename(cwd: string | undefined): string {
  if (cwd === undefined || cwd.length === 0) return ''
  const trimmed = cwd.replace(/[\\/]+$/, '')
  if (trimmed.length === 0) return ''
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

function isSubsequence(query: string, haystack: string): boolean {
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

function statusGlyph(
  entry: SwitcherEntry,
  glyphs: Glyphs,
  theme: Theme,
): { glyph: string; style: string } {
  if (entry.blocked) return { glyph: glyphs.approve, style: theme.warn }
  if (entry.running) {
    const spin = glyphs.running[0]
    return { glyph: spin ?? glyphs.idle, style: theme.running }
  }
  return { glyph: glyphs.idle, style: theme.dim }
}

function unreadBadge(unread: number): string {
  if (unread <= 0) return ''
  if (unread > 99) return '99+'
  return String(unread)
}

function formatAge(updatedAt: number, now: number): string {
  const delta = Math.max(0, now - updatedAt)
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function rowSpans(
  entry: SwitcherEntry,
  selected: boolean,
  innerW: number,
  state: SwitcherState,
  theme: Theme,
  glyphs: Glyphs,
  now: number,
): Span[] {
  if (innerW <= 0) return []

  const renaming = state.stage === 'rename' && entry.id === state.renameId
  const title = renaming ? state.renameDraft : entry.title
  const { glyph, style: glyphStyle } = statusGlyph(entry, glyphs, theme)
  const mark = selected ? `${glyphs.arrow} ` : '  '
  const badge = unreadBadge(entry.unread)
  const age = formatAge(entry.updatedAt, now)
  const base = renaming ? '' : cwdBasename(entry.cwd)

  const leftFixed = stringWidth(mark) + stringWidth(glyph) + 1
  const rightBits: { text: string; style: string }[] = []
  if (badge.length > 0) rightBits.push({ text: badge, style: theme.accent })
  if (age.length > 0) rightBits.push({ text: age, style: theme.dim })

  let rightW = 0
  for (const bit of rightBits) rightW += 1 + stringWidth(bit.text)

  let baseShown = ''
  let titleBudget = Math.max(0, innerW - leftFixed - rightW)
  if (base.length > 0 && titleBudget > 4) {
    const want = Math.min(stringWidth(base), Math.max(4, Math.floor(titleBudget / 3)))
    if (titleBudget - want - 1 >= 1) {
      baseShown = truncate(base, want)
      titleBudget -= 1 + stringWidth(baseShown)
    }
  }
  const titleShown = truncate(title, titleBudget)
  const titleStyle = selected ? theme.selected : theme.text

  const spans: Span[] = [
    { text: mark, style: selected ? theme.accent : theme.dim },
    { text: glyph, style: glyphStyle },
    { text: ' ', style: '' },
  ]
  if (titleShown.length > 0) spans.push({ text: titleShown, style: titleStyle })
  if (baseShown.length > 0) {
    spans.push({ text: ' ', style: '' })
    spans.push({ text: baseShown, style: theme.dim })
  }
  for (const bit of rightBits) {
    spans.push({ text: ' ', style: '' })
    spans.push(bit)
  }
  return spans
}

function windowStart(count: number, height: number, cursor: number): number {
  if (count <= height || height <= 0) return 0
  const maxStart = count - height
  let start = cursor - Math.floor(height / 2)
  if (start < 0) start = 0
  if (start > maxStart) start = maxStart
  return start
}

function popGrapheme(text: string): string {
  const parts = [...SEGMENTER.segment(text)]
  if (parts.length === 0) return ''
  parts.pop()
  let out = ''
  for (const part of parts) out += part.segment
  return out
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0
  if (index < 0) return 0
  if (index >= length) return length - 1
  return index
}

function isPrintableChar(key: Key): key is { kind: 'char'; char: string } {
  return key.kind === 'char' && key.char.length > 0
}

// ---------------------------------------------------------------------------
// Panel chrome (overlay.ts / help.ts: centered box, title on the top rule)
// ---------------------------------------------------------------------------

interface OverlayLine {
  spans: Span[]
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

function putGlyph(
  target: RenderTarget,
  row: number,
  col: number,
  ch: string,
  style: string,
): void {
  const clipped = clipToWidth(ch, 1)
  if (clipped.text.length === 0) return
  target.put(row, col, clipped.text, style)
}

function paintTopRule(
  target: RenderTarget,
  panel: Rect,
  title: string,
  theme: Theme,
  glyphs: Glyphs,
): void {
  const { row, col, width } = panel
  if (width <= 0) return
  putGlyph(target, row, col, glyphs.corner.tl, theme.border)
  if (width === 1) return
  putGlyph(target, row, col + width - 1, glyphs.corner.tr, theme.border)
  const innerW = width - 2
  if (innerW <= 0) return

  const labeled = title.length > 0 ? ` ${title} ` : ''
  const titleW = stringWidth(labeled)
  if (labeled.length > 0 && titleW + 2 <= innerW) {
    const rest = innerW - titleW
    const left = 1
    const right = rest - left
    let x = col + 1
    if (left > 0) {
      target.put(row, x, repeatToWidth(glyphs.hline, left), theme.border)
      x += left
    }
    target.put(row, x, labeled, theme.accent)
    x += titleW
    if (right > 0) target.put(row, x, repeatToWidth(glyphs.hline, right), theme.border)
    return
  }
  if (labeled.length > 0 && titleW <= innerW) {
    const pad = innerW - titleW
    const left = Math.floor(pad / 2)
    const right = pad - left
    let x = col + 1
    if (left > 0) {
      target.put(row, x, repeatToWidth(glyphs.hline, left), theme.border)
      x += left
    }
    target.put(row, x, labeled, theme.accent)
    x += titleW
    if (right > 0) target.put(row, x, repeatToWidth(glyphs.hline, right), theme.border)
    return
  }
  const cut = truncate(title, innerW)
  const cutW = stringWidth(cut)
  if (cutW > 0) target.put(row, col + 1, cut, theme.accent)
  if (cutW < innerW) {
    target.put(row, col + 1 + cutW, repeatToWidth(glyphs.hline, innerW - cutW), theme.border)
  }
}

function paintBottomRule(
  target: RenderTarget,
  panel: Rect,
  theme: Theme,
  glyphs: Glyphs,
): void {
  const { width } = panel
  if (width <= 0 || panel.height < 2) return
  const row = panel.row + panel.height - 1
  putGlyph(target, row, panel.col, glyphs.corner.bl, theme.border)
  if (width === 1) return
  putGlyph(target, row, panel.col + width - 1, glyphs.corner.br, theme.border)
  const innerW = width - 2
  if (innerW > 0) {
    target.put(row, panel.col + 1, repeatToWidth(glyphs.hline, innerW), theme.border)
  }
}

function paintSideRules(
  target: RenderTarget,
  row: number,
  panel: Rect,
  theme: Theme,
  glyphs: Glyphs,
): void {
  if (panel.width <= 0) return
  putGlyph(target, row, panel.col, glyphs.vline, theme.border)
  if (panel.width >= 2) {
    putGlyph(target, row, panel.col + panel.width - 1, glyphs.vline, theme.border)
  }
}

function paintInner(
  target: RenderTarget,
  row: number,
  panel: Rect,
  spans: readonly Span[],
): void {
  const innerW = panel.width - 2
  if (innerW <= 0) return
  paintLine(target, row, panel.col + 1, innerW, { spans: [...spans] })
}

function paintPanel(
  target: RenderTarget,
  rect: Rect,
  panel: Rect,
  theme: Theme,
  glyphs: Glyphs,
  title: string,
  body: readonly OverlayLine[],
  footer: string,
): void {
  if (rect.width > 0 && rect.height > 0) clearRect(target, rect, theme.dim)
  if (panel.width <= 0 || panel.height <= 0) return
  clearRect(target, panel, theme.base)
  paintTopRule(target, panel, title, theme, glyphs)
  paintBottomRule(target, panel, theme, glyphs)

  const innerH = Math.max(0, panel.height - 2)
  const innerW = Math.max(0, panel.width - 2)
  const footerRow = innerH >= 1 ? innerH - 1 : -1
  for (let i = 0; i < innerH; i++) {
    const row = panel.row + 1 + i
    paintSideRules(target, row, panel, theme, glyphs)
    if (i === footerRow) {
      if (innerW > 0) {
        paintInner(target, row, panel, [{ text: truncate(footer, innerW), style: theme.dim }])
      }
      continue
    }
    const line = body[i]
    if (line !== undefined) paintInner(target, row, panel, line.spans)
  }
}
