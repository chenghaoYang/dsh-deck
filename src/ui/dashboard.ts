/**
 * Floating session cockpit. Pure reducer + paint — the app shell owns
 * session.create / session.prompt / focus.
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

const LIST_FOOTER = '⏎ open · type to reply · ^s send+open · esc close'
const INPUT_FOOTER = '⏎ send · ^s send+open · tab list · esc back'
const DISPATCH_LABEL = '+ dispatch a new agent'

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

export interface DashboardState {
  sessions: readonly DashboardSession[]
  /** 0 = dispatch-new row; 1..n map to sessions[cursor-1] */
  cursor: number
  focus: 'list' | 'input'
  draft: string
}

export type DashboardResult =
  | { kind: 'continue'; state: DashboardState }
  | { kind: 'attach'; id: string }
  | { kind: 'reply'; id: string; text: string; attach: boolean }
  | { kind: 'dispatch'; text: string; attach: boolean }
  | { kind: 'cancelled' }

export function createDashboard(
  sessions: readonly DashboardSession[],
  focusedId?: string,
): DashboardState {
  const sorted = sortSessions(sessions)
  if (sorted.length === 0) {
    return { sessions: sorted, cursor: 0, focus: 'input', draft: '' }
  }
  let index = 0
  if (focusedId !== undefined) {
    const at = sorted.findIndex((session) => session.id === focusedId)
    if (at >= 0) index = at
  }
  return { sessions: sorted, cursor: index + 1, focus: 'list', draft: '' }
}

export function updateDashboardSessions(
  state: DashboardState,
  sessions: readonly DashboardSession[],
): DashboardState {
  const sorted = sortSessions(sessions)
  if (state.cursor === 0) {
    return { ...state, sessions: sorted, cursor: 0 }
  }
  const current = state.sessions[state.cursor - 1]
  if (current !== undefined) {
    const at = sorted.findIndex((session) => session.id === current.id)
    if (at >= 0) return { ...state, sessions: sorted, cursor: at + 1 }
  }
  return { ...state, sessions: sorted, cursor: clampCursor(state.cursor, sorted.length) }
}

export function reduceDashboard(state: DashboardState, key: Key): DashboardResult {
  if (key.kind === 'ctrl' && key.char.toLowerCase() === 'c') return { kind: 'cancelled' }

  if (key.kind === 'escape') {
    if (state.focus === 'input' && state.draft.length > 0) {
      return { kind: 'continue', state: { ...state, focus: 'list' } }
    }
    return { kind: 'cancelled' }
  }

  if (key.kind === 'tab') {
    return {
      kind: 'continue',
      state: { ...state, focus: state.focus === 'list' ? 'input' : 'list' },
    }
  }

  if (key.kind === 'ctrl' && key.char.toLowerCase() === 'u') {
    return { kind: 'continue', state: { ...state, draft: '' } }
  }

  if (key.kind === 'ctrl' && key.char.toLowerCase() === 's') return send(state, true)
  if (key.kind === 'enter') return send(state, false)

  if (key.kind === 'up' || (state.focus === 'list' && isPrintableChar(key) && key.char === 'k')) {
    return move(state, state.cursor - 1)
  }
  if (key.kind === 'down' || (state.focus === 'list' && isPrintableChar(key) && key.char === 'j')) {
    return move(state, state.cursor + 1)
  }
  if (key.kind === 'home') return move(state, 0)
  if (key.kind === 'end') return move(state, state.sessions.length)

  if (state.focus === 'list' && isPrintableChar(key) && key.char === 'i') {
    return { kind: 'continue', state: { ...state, focus: 'input' } }
  }

  if (state.focus === 'input' && key.kind === 'backspace') {
    return { kind: 'continue', state: { ...state, draft: popGrapheme(state.draft) } }
  }

  if (key.kind === 'paste') {
    const text = key.text.replace(/[\r\n]/g, '')
    if (text.length === 0) return { kind: 'continue', state }
    return { kind: 'continue', state: { ...state, draft: state.draft + text, focus: 'input' } }
  }

  if (isPrintableChar(key)) {
    return {
      kind: 'continue',
      state: { ...state, draft: state.draft + key.char, focus: 'input' },
    }
  }

  return { kind: 'continue', state }
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

  const boxW = Math.max(4, Math.min(88, rect.width > 2 ? rect.width - 2 : rect.width))
  const desiredH = Math.min(rect.height, Math.max(12, state.sessions.length + 8))
  const panel = centerBox(rect, boxW, desiredH)
  const innerW = Math.max(0, panel.width - 2)
  const bodyH = Math.max(0, panel.height - 3)
  const footer = state.focus === 'input' ? INPUT_FOOTER : LIST_FOOTER
  const body = bodyLines(state, innerW, bodyH, theme, glyphs, spinnerFrame)
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
  if (state.cursor === 0) {
    if (text.length === 0) return { kind: 'continue', state }
    return { kind: 'dispatch', text, attach }
  }
  const session = state.sessions[state.cursor - 1]
  if (session === undefined) return { kind: 'continue', state }
  if (text.length === 0) {
    return attach ? { kind: 'continue', state } : { kind: 'attach', id: session.id }
  }
  return { kind: 'reply', id: session.id, text, attach }
}

function move(state: DashboardState, cursor: number): DashboardResult {
  return { kind: 'continue', state: { ...state, cursor: clampCursor(cursor, state.sessions.length) } }
}

function sortSessions(sessions: readonly DashboardSession[]): DashboardSession[] {
  return sessions.slice().sort((a, b) => {
    const rankA = sessionRank(a)
    const rankB = sessionRank(b)
    if (rankA !== rankB) return rankA - rankB
    return b.updatedAt - a.updatedAt
  })
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

function panelTitle(state: DashboardState): string {
  const n = state.sessions.length
  const blocked = state.sessions.some((session) => session.blocked)
  return blocked ? `dashboard · ${n} · awaiting` : `dashboard · ${n}`
}

function bodyLines(
  state: DashboardState,
  innerW: number,
  bodyH: number,
  theme: Theme,
  glyphs: Glyphs,
  spinnerFrame: number,
): OverlayLine[] {
  if (bodyH <= 0) return []

  const list = listLines(state, innerW, theme, glyphs, spinnerFrame)
  const peek = peekBlock(state, innerW, theme)
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
  innerW: number,
  theme: Theme,
  glyphs: Glyphs,
  spinnerFrame: number,
): OverlayLine[] {
  const lines: OverlayLine[] = [dispatchRow(state.cursor === 0, innerW, theme, glyphs)]
  for (let i = 0; i < state.sessions.length; i++) {
    const session = state.sessions[i]
    if (session === undefined) continue
    lines.push(sessionRow(session, state.cursor === i + 1, innerW, theme, glyphs, spinnerFrame))
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

function sessionRow(
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
  const status = statusLabel(session)
  const badge = unreadBadge(session.unread)

  const leftFixed = stringWidth(mark) + stringWidth(glyph) + 1
  let rightW = 1 + stringWidth(status)
  if (badge.length > 0) rightW += 1 + stringWidth(badge)
  const titleBudget = Math.max(0, innerW - leftFixed - rightW)
  const titleShown = truncate(session.title, titleBudget)
  const titleStyle = selected ? theme.selected : theme.text

  const spans: Span[] = [
    { text: mark, style: selected ? theme.accent : theme.dim },
    { text: glyph, style: glyphStyle },
    { text: ' ', style: '' },
  ]
  if (titleShown.length > 0) spans.push({ text: titleShown, style: titleStyle })
  spans.push({ text: ' ', style: '' })
  spans.push({ text: status, style: statusStyle(status, theme) })
  if (badge.length > 0) {
    spans.push({ text: ' ', style: '' })
    spans.push({ text: badge, style: theme.accent })
  }
  return { spans }
}

function peekBlock(state: DashboardState, innerW: number, theme: Theme): OverlayLine[] {
  if (state.cursor === 0) return []
  const session = state.sessions[state.cursor - 1]
  if (session === undefined) return []

  const lines: OverlayLine[] = [{ spans: [] }]
  const header = truncate(`peek · ${session.title}`, innerW)
  if (header.length > 0) lines.push({ spans: [{ text: header, style: theme.subtle }] })
  for (const line of peekLines(session.items)) {
    const text = truncate(line, innerW)
    if (text.length > 0) lines.push({ spans: [{ text, style: theme.dim }] })
  }
  return lines
}

function draftLine(state: DashboardState, innerW: number, theme: Theme, glyphs: Glyphs): OverlayLine {
  const style = state.focus === 'input' ? theme.text : theme.dim
  const prefix = `${glyphs.arrow} `
  const budget = Math.max(0, innerW - stringWidth(prefix))
  return {
    spans: [
      { text: prefix, style },
      { text: truncate(state.draft, budget), style },
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

function statusLabel(session: DashboardSession): 'blocked' | 'running' | 'error' | 'idle' {
  if (session.blocked) return 'blocked'
  if (session.running) return 'running'
  if (hasError(session)) return 'error'
  return 'idle'
}

function statusStyle(status: 'blocked' | 'running' | 'error' | 'idle', theme: Theme): string {
  if (status === 'blocked') return theme.warn
  if (status === 'running') return theme.running
  if (status === 'error') return theme.error
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

function clampCursor(cursor: number, sessionCount: number): number {
  if (sessionCount < 0) return 0
  if (cursor < 0) return 0
  if (cursor > sessionCount) return sessionCount
  return cursor
}

function isPrintableChar(key: Key): key is { kind: 'char'; char: string } {
  return key.kind === 'char' && key.char.length > 0
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
