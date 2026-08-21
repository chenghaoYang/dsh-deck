/**
 * Session list. An approval waiting on a background session is painted in the
 * warn color — that hang is otherwise invisible to the user.
 */

import { stringWidth, truncate } from '../term/width.ts'
import { pendingApprovalsOf, pendingQuestionsOf, type SessionState } from '../model/store.ts'
import { harnessLabel } from '../harness/catalog.ts'
import type { Theme, Glyphs } from './theme.ts'
import type { Rect } from './layout.ts'
import {
  type RenderTarget,
  type Span,
  paintLine,
  clearRect,
  makeLine,
  spinnerGlyph,
  unreadBadge,
} from './render.ts'

export interface SidebarProps {
  rect: Rect
  sessions: readonly SessionState[]
  focusedId: string | undefined
  theme: Theme
  glyphs: Glyphs
  spinnerFrame: number
}

export function renderSidebar(target: RenderTarget, props: SidebarProps): void {
  const { rect, sessions, focusedId, theme, glyphs, spinnerFrame } = props
  clearRect(target, rect, theme.base)
  if (rect.width <= 0 || rect.height <= 0) return

  const ids = new Set(sessions.map((s) => s.id))
  const focusedAt = focusedId === undefined ? 0 : sessions.findIndex((s) => s.id === focusedId)
  const window = visibleWindow(sessions.length, rect.height, focusedAt < 0 ? 0 : focusedAt)
  const idxDigits = Math.max(1, stringWidth(String(sessions.length)))

  for (let i = 0; i < window.length; i++) {
    const index = window.start + i
    const session = sessions[index]
    if (session === undefined) continue
    const row = makeSessionRow(session, {
      index: index + 1,
      idxDigits,
      width: rect.width,
      focused: session.id === focusedId,
      child: session.origin === 'subagent' && session.parentSessionId !== undefined && ids.has(session.parentSessionId),
      theme,
      glyphs,
      spinnerFrame,
    })
    paintLine(target, rect.row + i, rect.col, rect.width, row)
  }
}

/**
 * Map a clicked terminal row back to the session it shows, using the exact
 * windowing renderSidebar painted with. Undefined outside the list.
 */
export function sidebarHitTest(
  sessions: readonly SessionState[],
  focusedId: string | undefined,
  rect: Rect,
  row: number,
): SessionState | undefined {
  if (row < rect.row || row >= rect.row + rect.height) return undefined
  const focusedAt = focusedId === undefined ? 0 : sessions.findIndex((s) => s.id === focusedId)
  const window = visibleWindow(sessions.length, rect.height, focusedAt < 0 ? 0 : focusedAt)
  const offset = row - rect.row
  if (offset >= window.length) return undefined
  return sessions[window.start + offset]
}

function visibleWindow(
  count: number,
  height: number,
  focusedAt: number,
): { start: number; length: number } {
  if (count <= height) return { start: 0, length: count }
  const maxStart = count - height
  let start = focusedAt - Math.floor(height / 2)
  if (start < 0) start = 0
  if (start > maxStart) start = maxStart
  return { start, length: height }
}

function makeSessionRow(
  session: SessionState,
  opts: {
    index: number
    idxDigits: number
    width: number
    focused: boolean
    child: boolean
    theme: Theme
    glyphs: Glyphs
    spinnerFrame: number
  },
) {
  const { theme, glyphs, width } = opts
  const { glyph, style: glyphStyle } = statusGlyph(session, opts)
  const bar = opts.focused ? glyphs.bar : ' '
  const indent = opts.child ? ' ' : ''
  const idx = String(opts.index).padStart(opts.idxDigits, ' ')
  const label = sessionLabel(session)
  const waiting = pendingApprovalsOf(session).length + pendingQuestionsOf(session).length
  const blocked = waiting > 0
  const badge = blocked ? '' : unreadBadge(session.unread)
  const waitingBadge = waitingBadgeText(waiting)

  const rest =
    stringWidth(bar) +
    stringWidth(indent) +
    stringWidth(glyph) +
    1 +
    stringWidth(idx) +
    1 +
    (badge.length > 0 ? 1 + stringWidth(badge) : 0) +
    (waitingBadge.length > 0 ? 1 + stringWidth(waitingBadge) : 0)
  const titleBudget = Math.max(0, width - rest)
  const title = titleBudget > 0 ? truncate(label.text, titleBudget) : ''

  const bodyStyle = opts.focused ? theme.selected : theme.text
  const titleStyle = label.untitled && !opts.focused ? theme.dim : bodyStyle
  const idxStyle = opts.focused ? theme.selected : theme.dim

  const spans: Span[] = [
    { text: bar, style: opts.focused ? theme.selected : theme.dim },
    { text: indent, style: '' },
    { text: glyph, style: glyphStyle },
    { text: ` ${idx} `, style: idxStyle },
  ]
  if (title.length > 0) spans.push({ text: title, style: titleStyle })
  if (badge.length > 0) {
    spans.push({ text: ' ', style: '' })
    spans.push({ text: badge, style: theme.accent })
  }
  if (waitingBadge.length > 0) {
    spans.push({ text: ' ', style: theme.warn })
    spans.push({ text: waitingBadge, style: theme.warn })
  }
  return makeLine(spans, width)
}

function statusGlyph(
  session: SessionState,
  opts: { theme: Theme; glyphs: Glyphs; spinnerFrame: number },
): { glyph: string; style: string } {
  const { theme, glyphs, spinnerFrame } = opts
  // Approval wins: a blocked background agent must not look merely idle/running.
  if (pendingApprovalsOf(session).length > 0) {
    return { glyph: glyphs.approve, style: theme.warn }
  }
  if (pendingQuestionsOf(session).length > 0) {
    return { glyph: glyphs.approve, style: theme.accent }
  }
  if (session.lastError !== undefined && session.lastError.length > 0) {
    return { glyph: glyphs.error, style: theme.error }
  }
  if (session.running) {
    return { glyph: spinnerGlyph(glyphs, spinnerFrame), style: theme.running }
  }
  return { glyph: glyphs.idle, style: theme.dim }
}

function sessionLabel(session: SessionState): { text: string; untitled: boolean } {
  const title = session.title
  let text: string
  let untitled = false
  if (title !== undefined && title.trim().length > 0) {
    text = title.trim()
  } else {
    const cwd = session.cwd
    const base = cwd !== undefined && cwd.length > 0
      ? cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
      : undefined
    if (base !== undefined && base.length > 0) text = base
    else {
      text = 'untitled'
      untitled = true
    }
  }
  if (session.harness !== undefined) text = `${harnessLabel(session.harness)} · ${text}`
  return { text, untitled }
}

function waitingBadgeText(count: number): string {
  if (count <= 0) return ''
  return count > 99 ? '99+' : String(count)
}
