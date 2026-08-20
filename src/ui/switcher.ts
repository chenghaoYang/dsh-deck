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
import { centerBox, type Rect } from './layout.ts'
import {
  type RenderTarget,
  type Span,
  clampIndex,
  isPrintableChar,
  isSubsequence,
  popGrapheme,
  spinnerGlyph,
  unreadBadge,
  windowStart,
} from './render.ts'
import { paintFloatingPanel, type OverlayLine } from './overlay.ts'

const LIST_FOOTER = '⏎ focus · ⌫/^d archive · ^r rename · ^n new · esc close'
const RENAME_FOOTER = '⏎ save · esc back'
const ARCHIVE_FOOTER = '⏎ archive · esc back'

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
    (key.kind === 'backspace' && state.filter.length === 0)
    ||
    (key.kind === 'delete' && state.filter.length === 0)
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
  if (key.kind === 'delete') return { kind: 'continue', state }
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
  spinnerFrame = 0,
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
    paintFloatingPanel(target, panel, theme, glyphs, 'archive session', body, ARCHIVE_FOOTER)
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
      spans: rowSpans(entry, selected, innerW, state, theme, glyphs, now, spinnerFrame),
    })
  }

  paintFloatingPanel(target, panel, theme, glyphs, title, body, footer)
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

function statusGlyph(
  entry: SwitcherEntry,
  glyphs: Glyphs,
  theme: Theme,
  spinnerFrame: number,
): { glyph: string; style: string } {
  if (entry.blocked) return { glyph: glyphs.approve, style: theme.warn }
  if (entry.running) {
    const spin = spinnerGlyph(glyphs, spinnerFrame)
    return { glyph: spin.length > 0 ? spin : glyphs.idle, style: theme.running }
  }
  return { glyph: glyphs.idle, style: theme.dim }
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
  spinnerFrame: number,
): Span[] {
  if (innerW <= 0) return []

  const renaming = state.stage === 'rename' && entry.id === state.renameId
  const title = renaming ? state.renameDraft : entry.title
  const { glyph, style: glyphStyle } = statusGlyph(entry, glyphs, theme, spinnerFrame)
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
