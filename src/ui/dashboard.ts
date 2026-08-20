/**
 * Floating session cockpit. Pure reducer + paint — the app shell owns
 * session.create / session.prompt / focus, and persists prefs from state.
 */

import type { TranscriptItem } from '../model/fold.ts'
import type { Key } from '../term/input.ts'
import { stringWidth, truncate } from '../term/width.ts'
import type { Rect } from './layout.ts'
import { paintFloatingPanel, type OverlayLine } from './overlay.ts'
import {
  type RenderTarget,
  type Span,
  spinnerGlyph,
} from './render.ts'
import type { Glyphs, Theme } from './theme.ts'

const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' })

const LIST_FOOTER =
  '⏎ open · type to reply · ^s send+open · ^/ search · ^t pin · ⌥j/k reorder · ^g group · ^r rename · ^x stop · esc close'
const INPUT_FOOTER = '⏎ send · ^s send+open · tab list · esc back'
const SEARCH_FOOTER = '⏎ apply · esc/ ^/ cancel · ↑↓ move'
const RENAME_FOOTER = '⏎ save · esc back'
const DISPATCH_LABEL = '+ dispatch a new agent'
const IDLE_KEEP = 8
const STOP_ARM_MS = 2000
const STATUS_MAX = 16

export interface DashboardSession {
  id: string
  title: string
  cwd?: string
  running: boolean
  unread: number
  blocked: boolean
  lastError?: string
  updatedAt: number
  model?: string
  /** Latest transcript items, oldest first. Peek reads from the end. */
  items: readonly TranscriptItem[]
  pendingTool?: string
}

export interface DashboardOptions {
  grouping?: 'state' | 'directory'
  pinned?: readonly string[]
  pinOrder?: readonly string[]
  idleExpanded?: boolean
  now?: number
}

export interface DashboardState {
  /** Full catalog, sorted for the current grouping. */
  sessions: readonly DashboardSession[]
  /** 0 = dispatch; then indexes into visible rows, not raw sessions. */
  cursor: number
  focus: 'list' | 'input' | 'search' | 'rename'
  draft: string
  grouping: 'state' | 'directory'
  pinned: readonly string[]
  pinOrder: readonly string[]
  idleExpanded: boolean
  /** Confirmed search filter (substring); empty = none. */
  filter: string
  /** Live search text while focus === 'search'. */
  searchDraft: string
  renameDraft: string
  stopArmedId?: string
  stopArmedAt?: number
}

export type VisibleDashboardRow =
  | { kind: 'dispatch' }
  | { kind: 'session'; session: DashboardSession }
  | { kind: 'idle-more'; hidden: number }

export type DashboardResult =
  | { kind: 'continue'; state: DashboardState }
  | { kind: 'attach'; id: string }
  | { kind: 'reply'; id: string; text: string; attach: boolean }
  | { kind: 'dispatch'; text: string; attach: boolean }
  | { kind: 'rename'; id: string; title: string; state: DashboardState }
  | { kind: 'cancel'; id: string; state: DashboardState }
  | { kind: 'archive'; id: string; state: DashboardState }
  | { kind: 'cancelled' }

export function createDashboard(
  sessions: readonly DashboardSession[],
  focusedId?: string,
  options?: DashboardOptions,
): DashboardState {
  const grouping = options?.grouping ?? 'state'
  const pinned = options?.pinned !== undefined ? [...options.pinned] : []
  const pinOrder = options?.pinOrder !== undefined ? [...options.pinOrder] : []
  const idleExpanded = options?.idleExpanded ?? false
  const sorted = sortSessions(sessions, grouping, pinned, pinOrder)
  const state: DashboardState = {
    sessions: sorted,
    cursor: 0,
    focus: sorted.length === 0 ? 'input' : 'list',
    draft: '',
    grouping,
    pinned,
    pinOrder,
    idleExpanded,
    filter: '',
    searchDraft: '',
    renameDraft: '',
  }
  if (sorted.length === 0) return state
  if (focusedId !== undefined) {
    let at = visibleIndexOf(state, focusedId)
    if (at < 0 && !state.idleExpanded) {
      const expanded: DashboardState = { ...state, idleExpanded: true }
      at = visibleIndexOf(expanded, focusedId)
      if (at > 0) return { ...expanded, cursor: at }
    } else if (at > 0) {
      return { ...state, cursor: at }
    }
  }
  return { ...state, cursor: 1 }
}

export function updateDashboardSessions(
  state: DashboardState,
  sessions: readonly DashboardSession[],
): DashboardState {
  const sorted = sortSessions(sessions, state.grouping, state.pinned, state.pinOrder)
  const next: DashboardState = { ...state, sessions: sorted }
  if (state.cursor === 0) return { ...next, cursor: 0 }
  return { ...next, cursor: cursorForId(next, selectedSessionId(state)) }
}

export function visibleDashboardRows(state: DashboardState): ReadonlyArray<VisibleDashboardRow> {
  const query = activeQuery(state)
  const matched = query.length > 0
    ? state.sessions.filter((session) => sessionMatches(session, query))
    : state.sessions.slice()

  const rows: VisibleDashboardRow[] = [{ kind: 'dispatch' }]
  const fold = query.length === 0 && !state.idleExpanded
  const hiddenIds = fold ? foldedIdleIds(matched, state.pinned) : new Set<string>()

  for (const session of matched) {
    if (hiddenIds.has(session.id)) continue
    rows.push({ kind: 'session', session })
  }
  if (hiddenIds.size > 0) rows.push({ kind: 'idle-more', hidden: hiddenIds.size })
  return rows
}

export function isCtrlSlash(key: Key): boolean {
  return key.kind === 'ctrl' && (key.char === '/' || key.char === '_' || key.char === '\x7f')
}

export function reduceDashboard(state: DashboardState, key: Key): DashboardResult {
  if (key.kind === 'ctrl' && key.char.toLowerCase() === 'c') return { kind: 'cancelled' }

  const current = isCtrlX(key) ? state : clearArmed(state)

  if (isCtrlSlash(key)) return toggleSearch(current)

  if (key.kind === 'escape') return escapeDashboard(current)

  if (key.kind === 'ctrl' && key.char.toLowerCase() === 'u') return clearActiveDraft(current)

  if (key.kind === 'ctrl' && key.char.toLowerCase() === 'g') return toggleGrouping(current)

  if (key.kind === 'ctrl' && key.char.toLowerCase() === 't') return togglePin(current)

  if (key.kind === 'alt' && key.char.toLowerCase() === 'k') return reorderPin(current, -1)
  if (key.kind === 'alt' && key.char.toLowerCase() === 'j') return reorderPin(current, 1)

  if (key.kind === 'ctrl' && key.char.toLowerCase() === 'r') return startRename(current)

  if (isCtrlX(key)) return stopOrArchive(current)

  if (current.focus === 'rename') return reduceRename(current, key)
  if (current.focus === 'search') return reduceSearch(current, key)

  if (key.kind === 'tab') {
    return {
      kind: 'continue',
      state: { ...current, focus: current.focus === 'list' ? 'input' : 'list' },
    }
  }

  if (key.kind === 'ctrl' && key.char.toLowerCase() === 's') return send(current, true)

  if (key.kind === 'enter') {
    if (isIdleMoreCursor(current)) return setIdleExpanded(current, true)
    return send(current, false)
  }

  if (key.kind === 'right' && current.focus === 'list') {
    if (isIdleMoreCursor(current)) return setIdleExpanded(current, true)
    return { kind: 'continue', state: current }
  }
  if (key.kind === 'left' && current.focus === 'list') {
    if (current.idleExpanded && current.filter.length === 0) return setIdleExpanded(current, false)
    return { kind: 'continue', state: current }
  }
  if (current.focus === 'list' && isPrintableChar(key) && key.char === 'l' && isIdleMoreCursor(current)) {
    return setIdleExpanded(current, true)
  }
  if (
    current.focus === 'list'
    && isPrintableChar(key)
    && key.char === 'h'
    && current.idleExpanded
    && current.filter.length === 0
  ) {
    return setIdleExpanded(current, false)
  }

  if (key.kind === 'up' || (current.focus === 'list' && isPrintableChar(key) && key.char === 'k')) {
    return move(current, current.cursor - 1)
  }
  if (key.kind === 'down' || (current.focus === 'list' && isPrintableChar(key) && key.char === 'j')) {
    return move(current, current.cursor + 1)
  }
  if (key.kind === 'home') return move(current, 0)
  if (key.kind === 'end') return move(current, lastCursor(current))

  if (current.focus === 'list' && isPrintableChar(key) && key.char === 'i') {
    return { kind: 'continue', state: { ...current, focus: 'input' } }
  }

  if (current.focus === 'list' && isPrintableChar(key) && isDigitOneToNine(key.char)) {
    return { kind: 'continue', state: current }
  }

  if (current.focus === 'input' && key.kind === 'backspace') {
    return { kind: 'continue', state: { ...current, draft: popGrapheme(current.draft) } }
  }

  if (key.kind === 'paste') {
    const text = key.text.replace(/[\r\n]/g, '')
    if (text.length === 0) return { kind: 'continue', state: current }
    return { kind: 'continue', state: { ...current, draft: current.draft + text, focus: 'input' } }
  }

  if (isPrintableChar(key)) {
    return {
      kind: 'continue',
      state: { ...current, draft: current.draft + key.char, focus: 'input' },
    }
  }

  return { kind: 'continue', state: current }
}

export function renderDashboard(
  target: RenderTarget,
  rect: Rect,
  state: DashboardState,
  theme: Theme,
  glyphs: Glyphs,
  spinnerFrame = 0,
): void {
  if (rect.width <= 0 || rect.height <= 0) return

  const rows = visibleDashboardRows(state)
  const boxW = Math.max(4, Math.min(88, rect.width > 2 ? rect.width - 2 : rect.width))
  const desiredH = Math.min(rect.height, Math.max(12, rows.length + 8))
  const panel = centerBox(rect, boxW, desiredH)
  const innerW = Math.max(0, panel.width - 2)
  const bodyH = Math.max(0, panel.height - 3)
  const footer = panelFooter(state)
  const body = bodyLines(state, rows, innerW, bodyH, theme, glyphs, spinnerFrame)
  paintFloatingPanel(target, panel, theme, glyphs, panelTitle(state), body, footer)
}

/** Exported for tests: 1–4 one-line peeks from the end of items. */
export function peekLines(items: readonly TranscriptItem[], max = 4): string[] {
  const cap = max < 0 ? 0 : max
  const out: string[] = []
  for (let i = items.length - 1; i >= 0 && out.length < cap; i--) {
    const item = items[i]
    if (item === undefined) continue
    const line = summarizeItem(item)
    if (line.length > 0) out.push(line)
  }
  out.reverse()
  return out
}

function send(state: DashboardState, attach: boolean): DashboardResult {
  const text = state.draft.trim()
  const row = visibleDashboardRows(state)[state.cursor]
  if (row === undefined || row.kind === 'dispatch') {
    if (text.length === 0) return { kind: 'continue', state }
    return { kind: 'dispatch', text, attach }
  }
  if (row.kind === 'idle-more') return { kind: 'continue', state }
  if (text.length === 0) {
    return attach ? { kind: 'continue', state } : { kind: 'attach', id: row.session.id }
  }
  return { kind: 'reply', id: row.session.id, text, attach }
}

function move(state: DashboardState, cursor: number): DashboardResult {
  return { kind: 'continue', state: { ...state, cursor: clampCursor(cursor, lastCursor(state)) } }
}

function lastCursor(state: DashboardState): number {
  return Math.max(0, visibleDashboardRows(state).length - 1)
}

function toggleSearch(state: DashboardState): DashboardResult {
  if (state.focus === 'search') {
    const next: DashboardState = { ...state, focus: 'list', filter: '', searchDraft: '' }
    return { kind: 'continue', state: { ...next, cursor: cursorForId(next, selectedSessionId(state)) } }
  }
  return {
    kind: 'continue',
    state: { ...state, focus: 'search', searchDraft: state.filter },
  }
}

function escapeDashboard(state: DashboardState): DashboardResult {
  if (state.focus === 'rename') {
    return { kind: 'continue', state: { ...state, focus: 'list', renameDraft: '' } }
  }
  if (state.focus === 'search') {
    const next: DashboardState = { ...state, focus: 'list', filter: '', searchDraft: '' }
    return { kind: 'continue', state: { ...next, cursor: cursorForId(next, selectedSessionId(state)) } }
  }
  if (state.focus === 'input' && state.draft.length > 0) {
    return { kind: 'continue', state: { ...state, focus: 'list' } }
  }
  if (state.focus === 'input') return { kind: 'cancelled' }
  if (state.filter.length > 0) {
    const next: DashboardState = { ...state, filter: '', searchDraft: '' }
    return { kind: 'continue', state: { ...next, cursor: cursorForId(next, selectedSessionId(state)) } }
  }
  if (state.cursor > 0) return { kind: 'continue', state: { ...state, cursor: 0 } }
  return { kind: 'cancelled' }
}

function clearActiveDraft(state: DashboardState): DashboardResult {
  if (state.focus === 'search') return { kind: 'continue', state: withSearchDraft(state, '') }
  if (state.focus === 'rename') return { kind: 'continue', state: { ...state, renameDraft: '' } }
  return { kind: 'continue', state: { ...state, draft: '' } }
}

function toggleGrouping(state: DashboardState): DashboardResult {
  const grouping = state.grouping === 'state' ? 'directory' : 'state'
  const id = selectedSessionId(state)
  const sessions = sortSessions(state.sessions, grouping, state.pinned, state.pinOrder)
  const next: DashboardState = { ...state, grouping, sessions }
  return { kind: 'continue', state: { ...next, cursor: cursorForId(next, id) } }
}

function togglePin(state: DashboardState): DashboardResult {
  const session = selectedSession(state)
  if (session === undefined) return { kind: 'continue', state }
  const id = session.id
  if (state.pinned.includes(id)) {
    return {
      kind: 'continue',
      state: withPins(
        state,
        state.pinned.filter((item) => item !== id),
        state.pinOrder.filter((item) => item !== id),
      ),
    }
  }
  const pinOrder = state.pinOrder.includes(id) ? [...state.pinOrder] : [...state.pinOrder, id]
  return { kind: 'continue', state: withPins(state, [...state.pinned, id], pinOrder) }
}

function reorderPin(state: DashboardState, dir: -1 | 1): DashboardResult {
  const session = selectedSession(state)
  if (session === undefined || !state.pinned.includes(session.id)) {
    return { kind: 'continue', state }
  }
  const pinOrder = movePinned(state.pinOrder, session.id, dir)
  return { kind: 'continue', state: withPins(state, state.pinned, pinOrder) }
}

function startRename(state: DashboardState): DashboardResult {
  const session = selectedSession(state)
  if (session === undefined) return { kind: 'continue', state }
  return {
    kind: 'continue',
    state: { ...state, focus: 'rename', renameDraft: session.title },
  }
}

function stopOrArchive(state: DashboardState): DashboardResult {
  const session = selectedSession(state)
  if (session === undefined) return { kind: 'continue', state }
  if (session.running) return { kind: 'cancel', id: session.id, state: clearArmed(state) }
  const now = Date.now()
  if (
    state.stopArmedId === session.id
    && state.stopArmedAt !== undefined
    && now - state.stopArmedAt <= STOP_ARM_MS
  ) {
    return { kind: 'archive', id: session.id, state: clearArmed(state) }
  }
  return {
    kind: 'continue',
    state: { ...state, stopArmedId: session.id, stopArmedAt: now },
  }
}

function reduceRename(state: DashboardState, key: Key): DashboardResult {
  if (key.kind === 'tab') return { kind: 'continue', state }
  if (key.kind === 'paste') {
    const text = key.text.replace(/[\r\n]/g, '')
    if (text.length === 0) return { kind: 'continue', state }
    return { kind: 'continue', state: { ...state, renameDraft: state.renameDraft + text } }
  }
  if (key.kind === 'backspace') {
    return { kind: 'continue', state: { ...state, renameDraft: popGrapheme(state.renameDraft) } }
  }
  if (isPrintableChar(key)) {
    return { kind: 'continue', state: { ...state, renameDraft: state.renameDraft + key.char } }
  }
  if (key.kind !== 'enter') return { kind: 'continue', state }
  const title = state.renameDraft.trim()
  if (title.length === 0) return { kind: 'continue', state }
  const session = selectedSession(state)
  if (session === undefined) {
    return { kind: 'continue', state: { ...state, focus: 'list', renameDraft: '' } }
  }
  return {
    kind: 'rename',
    id: session.id,
    title,
    state: { ...state, focus: 'list', renameDraft: '' },
  }
}

function reduceSearch(state: DashboardState, key: Key): DashboardResult {
  if (key.kind === 'tab') return { kind: 'continue', state }
  if (key.kind === 'enter') {
    const filter = state.searchDraft.trim()
    const next: DashboardState = { ...state, focus: 'list', filter, searchDraft: filter }
    return { kind: 'continue', state: { ...next, cursor: cursorForId(next, selectedSessionId(state)) } }
  }
  if (key.kind === 'up') return move(state, state.cursor - 1)
  if (key.kind === 'down') return move(state, state.cursor + 1)
  if (key.kind === 'home') return move(state, 0)
  if (key.kind === 'end') return move(state, lastCursor(state))
  if (key.kind === 'backspace') {
    return { kind: 'continue', state: withSearchDraft(state, popGrapheme(state.searchDraft)) }
  }
  if (key.kind === 'paste') {
    const text = key.text.replace(/[\r\n]/g, '')
    if (text.length === 0) return { kind: 'continue', state }
    return { kind: 'continue', state: withSearchDraft(state, state.searchDraft + text) }
  }
  if (isPrintableChar(key)) {
    return { kind: 'continue', state: withSearchDraft(state, state.searchDraft + key.char) }
  }
  return { kind: 'continue', state }
}

function setIdleExpanded(state: DashboardState, idleExpanded: boolean): DashboardResult {
  const id = selectedSessionId(state)
  const next: DashboardState = { ...state, idleExpanded }
  return { kind: 'continue', state: { ...next, cursor: cursorForId(next, id) } }
}

function withPins(
  state: DashboardState,
  pinned: readonly string[],
  pinOrder: readonly string[],
): DashboardState {
  const id = selectedSessionId(state)
  const sessions = sortSessions(state.sessions, state.grouping, pinned, pinOrder)
  const next: DashboardState = { ...state, pinned, pinOrder, sessions }
  return { ...next, cursor: cursorForId(next, id) }
}

function withSearchDraft(state: DashboardState, searchDraft: string): DashboardState {
  const id = selectedSessionId(state)
  const next: DashboardState = { ...state, searchDraft }
  return { ...next, cursor: cursorForId(next, id) }
}

function sortSessions(
  sessions: readonly DashboardSession[],
  grouping: 'state' | 'directory',
  pinned: readonly string[],
  pinOrder: readonly string[],
): DashboardSession[] {
  const pinSet = new Set(pinned)
  return sessions.slice().sort((a, b) => {
    if (grouping === 'directory') {
      const byCwd = (a.cwd ?? '').localeCompare(b.cwd ?? '')
      if (byCwd !== 0) return byCwd
    }
    const rankA = sessionRank(a)
    const rankB = sessionRank(b)
    if (rankA !== rankB) return rankA - rankB
    const pinA = pinSet.has(a.id)
    const pinB = pinSet.has(b.id)
    if (pinA !== pinB) return pinA ? -1 : 1
    if (pinA && pinB) {
      const oa = pinOrderIndex(pinOrder, a.id)
      const ob = pinOrderIndex(pinOrder, b.id)
      if (oa !== ob) return oa - ob
    }
    return b.updatedAt - a.updatedAt
  })
}

function pinOrderIndex(pinOrder: readonly string[], id: string): number {
  const at = pinOrder.indexOf(id)
  return at < 0 ? Number.POSITIVE_INFINITY : at
}

function movePinned(pinOrder: readonly string[], id: string, dir: -1 | 1): string[] {
  const order = pinOrder.includes(id) ? pinOrder.slice() : [...pinOrder, id]
  const at = order.indexOf(id)
  const swapWith = at + dir
  if (at < 0 || swapWith < 0 || swapWith >= order.length) return order
  const here = order[at]
  const there = order[swapWith]
  if (here === undefined || there === undefined) return order
  order[at] = there
  order[swapWith] = here
  return order
}

function sessionRank(session: DashboardSession): number {
  if (session.blocked) return 0
  if (session.running) return 1
  if (hasError(session)) return 2
  return 3
}

function hasError(session: DashboardSession): boolean {
  return session.lastError !== undefined && session.lastError.length > 0
}

function isIdle(session: DashboardSession): boolean {
  return !session.blocked && !session.running && !hasError(session)
}

function foldedIdleIds(sessions: readonly DashboardSession[], pinned: readonly string[]): Set<string> {
  const pinSet = new Set(pinned)
  const unpinnedIdle: DashboardSession[] = []
  for (const session of sessions) {
    if (isIdle(session) && !pinSet.has(session.id)) unpinnedIdle.push(session)
  }
  if (unpinnedIdle.length <= IDLE_KEEP) return new Set()
  const newest = unpinnedIdle.slice().sort((a, b) => b.updatedAt - a.updatedAt)
  const hidden = new Set<string>()
  for (const session of newest.slice(IDLE_KEEP)) hidden.add(session.id)
  return hidden
}

function sessionMatches(session: DashboardSession, query: string): boolean {
  const lower = query.toLowerCase()
  if (lower.startsWith('s:')) {
    const token = lower.slice(2).trim()
    const want = canonicalState(token)
    if (want === undefined) return false
    return sessionKind(session) === want
  }
  const cwd = session.cwd ?? ''
  return `${session.title} ${cwd}`.toLowerCase().includes(lower)
}

function canonicalState(token: string): 'blocked' | 'running' | 'error' | 'idle' | undefined {
  switch (token) {
    case 'working':
    case 'running':
    case 'busy':
      return 'running'
    case 'idle':
      return 'idle'
    case 'error':
    case 'failed':
      return 'error'
    case 'blocked':
    case 'needs-input':
      return 'blocked'
    default:
      return undefined
  }
}

function sessionKind(session: DashboardSession): 'blocked' | 'running' | 'error' | 'idle' {
  if (session.blocked) return 'blocked'
  if (session.running) return 'running'
  if (hasError(session)) return 'error'
  return 'idle'
}

function activeQuery(state: DashboardState): string {
  return state.focus === 'search' ? state.searchDraft : state.filter
}

function selectedSession(state: DashboardState): DashboardSession | undefined {
  const row = visibleDashboardRows(state)[state.cursor]
  return row?.kind === 'session' ? row.session : undefined
}

function selectedSessionId(state: DashboardState): string | undefined {
  return selectedSession(state)?.id
}

function visibleIndexOf(state: DashboardState, id: string): number {
  const rows = visibleDashboardRows(state)
  return rows.findIndex((row) => row.kind === 'session' && row.session.id === id)
}

function cursorForId(state: DashboardState, id: string | undefined): number {
  const rows = visibleDashboardRows(state)
  const max = Math.max(0, rows.length - 1)
  if (id !== undefined) {
    const at = visibleIndexOf(state, id)
    if (at >= 0) return at
    const more = rows.findIndex((row) => row.kind === 'idle-more')
    if (more >= 0) return more
  }
  return clampCursor(state.cursor, max)
}

function isIdleMoreCursor(state: DashboardState): boolean {
  const row = visibleDashboardRows(state)[state.cursor]
  return row?.kind === 'idle-more'
}

function isCtrlX(key: Key): boolean {
  return key.kind === 'ctrl' && key.char.toLowerCase() === 'x'
}

function clearArmed(state: DashboardState): DashboardState {
  if (state.stopArmedId === undefined && state.stopArmedAt === undefined) return state
  return {
    sessions: state.sessions,
    cursor: state.cursor,
    focus: state.focus,
    draft: state.draft,
    grouping: state.grouping,
    pinned: state.pinned,
    pinOrder: state.pinOrder,
    idleExpanded: state.idleExpanded,
    filter: state.filter,
    searchDraft: state.searchDraft,
    renameDraft: state.renameDraft,
  }
}

function panelTitle(state: DashboardState): string {
  const n = state.sessions.length
  const blocked = state.sessions.some((session) => session.blocked)
  let title = blocked ? `dashboard · ${n} · awaiting` : `dashboard · ${n}`
  if (state.grouping === 'directory') title += ' · dir'
  if (state.filter.length > 0) title += ` · /${state.filter}`
  return title
}

function panelFooter(state: DashboardState): string {
  if (state.focus === 'input') return INPUT_FOOTER
  if (state.focus === 'search') return SEARCH_FOOTER
  if (state.focus === 'rename') return RENAME_FOOTER
  return LIST_FOOTER
}

function bodyLines(
  state: DashboardState,
  rows: ReadonlyArray<VisibleDashboardRow>,
  innerW: number,
  bodyH: number,
  theme: Theme,
  glyphs: Glyphs,
  spinnerFrame: number,
): OverlayLine[] {
  if (bodyH <= 0) return []

  const list = listLines(state, rows, innerW, theme, glyphs, spinnerFrame)
  const peek = peekBlock(state, rows, innerW, theme)
  const draft = draftLine(state, innerW, theme, glyphs)

  if (bodyH === 1) return [draft]

  const room = bodyH - 1
  if (list.length + peek.length <= room) return [...list, ...peek, draft]

  if (peek.length > 0 && 1 + peek.length <= room) {
    const budget = room - peek.length
    return [...windowList(list, budget, state.cursor), ...peek, draft]
  }

  return [...windowList(list, room, state.cursor), draft]
}

function listLines(
  state: DashboardState,
  rows: ReadonlyArray<VisibleDashboardRow>,
  innerW: number,
  theme: Theme,
  glyphs: Glyphs,
  spinnerFrame: number,
): OverlayLine[] {
  const lines: OverlayLine[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row === undefined) continue
    const selected = state.cursor === i
    if (row.kind === 'dispatch') {
      lines.push(dispatchRow(selected, innerW, theme, glyphs))
      continue
    }
    if (row.kind === 'idle-more') {
      lines.push(idleMoreRow(row.hidden, selected, innerW, theme, glyphs))
      continue
    }
    lines.push(sessionRow(state, row.session, selected, innerW, theme, glyphs, spinnerFrame))
  }
  return lines
}

function dispatchRow(selected: boolean, innerW: number, theme: Theme, glyphs: Glyphs): OverlayLine {
  const mark = selected ? `${glyphs.arrow} ` : '  '
  const budget = Math.max(0, innerW - stringWidth(mark))
  return {
    spans: [
      { text: mark, style: selected ? theme.accent : theme.dim },
      { text: truncate(DISPATCH_LABEL, budget), style: selected ? theme.selected : theme.text },
    ],
  }
}

function idleMoreRow(
  hidden: number,
  selected: boolean,
  innerW: number,
  theme: Theme,
  glyphs: Glyphs,
): OverlayLine {
  const mark = selected ? `${glyphs.arrow} ` : '  '
  const budget = Math.max(0, innerW - stringWidth(mark))
  return {
    spans: [
      { text: mark, style: selected ? theme.accent : theme.dim },
      { text: truncate(`${hidden} more idle · → expand`, budget), style: theme.dim },
    ],
  }
}

function sessionRow(
  state: DashboardState,
  session: DashboardSession,
  selected: boolean,
  innerW: number,
  theme: Theme,
  glyphs: Glyphs,
  spinnerFrame: number,
): OverlayLine {
  if (innerW <= 0) return { spans: [] }

  const mark = selected ? `${glyphs.arrow} ` : '  '
  const { glyph, style: glyphStyle } = statusGlyph(session, theme, glyphs, spinnerFrame)
  const kind = sessionKind(session)
  const rawStatus = statusText(session)
  const status = truncate(rawStatus, Math.min(STATUS_MAX, Math.max(4, innerW)))
  const badge = unreadBadge(session.unread)
  const pinned = state.pinned.includes(session.id)
  const renaming = state.focus === 'rename' && selected
  const title = renaming ? state.renameDraft : session.title

  const pinW = pinned ? stringWidth('* ') : 0
  const leftFixed = stringWidth(mark) + stringWidth(glyph) + 1 + pinW
  let rightW = 1 + stringWidth(status)
  if (badge.length > 0) rightW += 1 + stringWidth(badge)

  let cwdShown = ''
  let titleBudget = Math.max(0, innerW - leftFixed - rightW)
  if (
    state.grouping === 'directory'
    && session.cwd !== undefined
    && session.cwd.length > 0
    && titleBudget > 4
  ) {
    const want = Math.min(stringWidth(session.cwd), Math.max(4, Math.floor(titleBudget / 3)))
    if (titleBudget - want - 1 >= 1) {
      cwdShown = truncate(session.cwd, want)
      titleBudget -= 1 + stringWidth(cwdShown)
    }
  }
  const titleShown = truncate(title, titleBudget)
  const titleStyle = selected ? theme.selected : theme.text

  const spans: Span[] = [
    { text: mark, style: selected ? theme.accent : theme.dim },
    { text: glyph, style: glyphStyle },
    { text: ' ', style: '' },
  ]
  if (pinned) {
    spans.push({ text: '*', style: theme.accent })
    spans.push({ text: ' ', style: '' })
  }
  if (titleShown.length > 0) spans.push({ text: titleShown, style: titleStyle })
  if (cwdShown.length > 0) {
    spans.push({ text: ' ', style: '' })
    spans.push({ text: cwdShown, style: theme.dim })
  }
  spans.push({ text: ' ', style: '' })
  spans.push({ text: status, style: statusStyle(kind, theme) })
  if (badge.length > 0) {
    spans.push({ text: ' ', style: '' })
    spans.push({ text: badge, style: theme.accent })
  }
  return { spans }
}

function peekBlock(
  state: DashboardState,
  rows: ReadonlyArray<VisibleDashboardRow>,
  innerW: number,
  theme: Theme,
): OverlayLine[] {
  const row = rows[state.cursor]
  if (row === undefined || row.kind !== 'session') return []
  const session = row.session

  const lines: OverlayLine[] = [{ spans: [] }]
  const header = peekHeader(session, innerW, theme)
  if (header.spans.length > 0) lines.push(header)
  for (const line of peekLines(session.items)) {
    const text = truncate(line, innerW)
    if (text.length > 0) lines.push({ spans: [{ text, style: theme.dim }] })
  }
  return lines
}

function peekHeader(session: DashboardSession, innerW: number, theme: Theme): OverlayLine {
  if (innerW <= 0) return { spans: [] }

  const left = truncate(`peek · ${session.title}`, innerW)
  const spans: Span[] = []
  if (left.length > 0) spans.push({ text: left, style: theme.subtle })
  let used = stringWidth(left)

  if (session.pendingTool !== undefined && session.pendingTool.length > 0) {
    const bit = truncate(` · ${session.pendingTool}`, Math.max(0, innerW - used))
    if (bit.length > 0 && innerW - used >= 3) {
      spans.push({ text: bit, style: theme.dim })
      used += stringWidth(bit)
    }
  }

  if (session.model !== undefined && session.model.length > 0) {
    const model = truncate(session.model, Math.max(0, innerW - used - 1))
    const mw = stringWidth(model)
    if (mw > 0 && used + 1 + mw <= innerW) {
      spans.push({ text: ' '.repeat(innerW - used - mw), style: '' })
      spans.push({ text: model, style: theme.dim })
    }
  }

  return { spans }
}

function draftLine(state: DashboardState, innerW: number, theme: Theme, glyphs: Glyphs): OverlayLine {
  const editing = state.focus === 'input' || state.focus === 'search' || state.focus === 'rename'
  const style = editing ? theme.text : theme.dim
  let prefix = `${glyphs.arrow} `
  let text = state.draft
  if (state.focus === 'search') {
    prefix = '/ '
    text = state.searchDraft
  } else if (state.focus === 'rename') {
    text = state.renameDraft
  }
  const budget = Math.max(0, innerW - stringWidth(prefix))
  return {
    spans: [
      { text: prefix, style },
      { text: truncate(text, budget), style },
    ],
  }
}

function statusGlyph(
  session: DashboardSession,
  theme: Theme,
  glyphs: Glyphs,
  spinnerFrame: number,
): { glyph: string; style: string } {
  if (session.blocked) return { glyph: glyphs.approve, style: theme.warn }
  if (session.running) {
    const spin = spinnerGlyph(glyphs, spinnerFrame)
    return { glyph: spin.length > 0 ? spin : glyphs.idle, style: theme.running }
  }
  if (hasError(session)) return { glyph: glyphs.error, style: theme.error }
  return { glyph: glyphs.idle, style: theme.dim }
}

function statusText(session: DashboardSession): string {
  if (session.blocked) return 'blocked'
  if (session.running) {
    if (session.pendingTool !== undefined && session.pendingTool.length > 0) return session.pendingTool
    return 'running'
  }
  if (hasError(session)) return 'error'
  return 'idle'
}

function statusStyle(kind: 'blocked' | 'running' | 'error' | 'idle', theme: Theme): string {
  if (kind === 'blocked') return theme.warn
  if (kind === 'running') return theme.running
  if (kind === 'error') return theme.error
  return theme.dim
}

function unreadBadge(unread: number): string {
  if (unread <= 0) return ''
  if (unread > 99) return '99+'
  return String(unread)
}

function summarizeItem(item: TranscriptItem): string {
  switch (item.kind) {
    case 'assistant':
    case 'user':
    case 'error':
    case 'notice':
      return collapseLine(item.text)
    case 'reasoning': {
      const body = collapseLine(item.text)
      return body.length > 0 ? `thought ${body}` : 'thought'
    }
    case 'tool':
      return `${item.call.name} · ${item.call.status}`
    case 'image':
      return 'image'
    case 'turn-end':
      return ''
  }
}

function collapseLine(text: string): string {
  const first = text.split(/\r?\n/)[0] ?? ''
  return first.replace(/\s+/g, ' ').trim()
}

function windowList(lines: readonly OverlayLine[], height: number, cursor: number): OverlayLine[] {
  if (height <= 0) return []
  const start = windowStart(lines.length, height, cursor)
  return lines.slice(start, start + height)
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

function clampCursor(cursor: number, max: number): number {
  if (max < 0) return 0
  if (cursor < 0) return 0
  if (cursor > max) return max
  return cursor
}

function isPrintableChar(key: Key): key is { kind: 'char'; char: string } {
  return key.kind === 'char' && key.char.length > 0
}

function isDigitOneToNine(char: string): boolean {
  return char >= '1' && char <= '9'
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
