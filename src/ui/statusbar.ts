/**
 * Header / footer chrome. Saturated color is reserved for connection state
 * and transient messages; everything else stays dim.
 */

import { stringWidth, truncate } from '../term/width.ts'
import type { HostDescription } from '../protocol/contract.ts'
import type { Theme, Glyphs } from './theme.ts'
import type { Rect } from './layout.ts'
import { type RenderTarget, type Span, paintLine, clearRect, makeLine } from './render.ts'

export interface HeaderProps {
  rect: Rect
  host: HostDescription | undefined
  connection: 'connecting' | 'ready' | 'reconnecting' | 'closed'
  sessionTitle: string | undefined
  theme: Theme
  glyphs: Glyphs
}

export function renderHeader(target: RenderTarget, props: HeaderProps): void {
  const { rect, host, connection, sessionTitle, theme } = props
  clearRect(target, rect, theme.base)
  if (rect.width <= 0 || rect.height <= 0) return

  const ascii = process.env.DECK_ASCII === '1'
  const dot = ascii ? '*' : '●'
  const connStyle = connectionStyle(connection, theme)
  const title = sessionTitle !== undefined ? sessionTitle.trim() : ''
  const hostLabel = hostLabelText(host)

  const spans: Span[] = [
    { text: 'deck', style: theme.accent },
    { text: '  ', style: '' },
    { text: dot, style: connStyle },
  ]

  // Connection word is chrome; drop it before the session title on a 40-col screen.
  const connWord = connection
  const connCost = 1 + stringWidth(connWord)
  if (rect.width >= 52) {
    spans.push({ text: ' ', style: '' }, { text: connWord, style: connStyle })
  } else if (rect.width >= 44 && title.length === 0) {
    spans.push({ text: ' ', style: '' }, { text: connWord, style: connStyle })
  }

  spans.push({ text: '  ', style: '' })
  const used = spans.reduce((n, s) => n + stringWidth(s.text), 0)
  const rightW = hostLabel.length > 0 ? stringWidth(hostLabel) : 0
  const gap = rightW > 0 ? 2 : 0
  const titleBudget = rect.width - used - rightW - gap

  if (title.length > 0 && titleBudget > 0) {
    spans.push({ text: truncate(title, titleBudget), style: theme.text })
  } else if (title.length === 0 && host === undefined && rect.width - used >= connCost + 1 && rect.width < 52) {
    spans.push({ text: connWord, style: connStyle })
  }

  const usedAfter = spans.reduce((n, s) => n + stringWidth(s.text), 0)
  if (rightW > 0 && usedAfter + gap + rightW <= rect.width) {
    spans.push({ text: ' '.repeat(rect.width - usedAfter - rightW), style: '' })
    spans.push({ text: hostLabel, style: theme.subtle })
  }

  paintLine(target, rect.row, rect.col, rect.width, makeLine(spans, rect.width))
}

export interface FooterProps {
  rect: Rect
  hints: readonly { key: string; label: string }[]
  message: { text: string; kind: 'info' | 'warn' | 'error' } | undefined
  theme: Theme
}

export function renderFooter(target: RenderTarget, props: FooterProps): void {
  const { rect, hints, message, theme } = props
  clearRect(target, rect, theme.base)
  if (rect.width <= 0 || rect.height <= 0) return

  if (message !== undefined) {
    const style =
      message.kind === 'error' ? theme.error : message.kind === 'warn' ? theme.warn : theme.subtle
    paintLine(
      target,
      rect.row,
      rect.col,
      rect.width,
      makeLine([{ text: truncate(message.text, rect.width), style }], rect.width),
    )
    return
  }

  const kept: { key: string; label: string }[] = []
  for (const hint of hints) {
    const next = [...kept, hint]
    if (hintsWidth(next) > rect.width) break
    kept.push(hint)
  }

  // Elide from the right: we stop appending once the row would overflow.
  if (kept.length === 0 && hints[0] !== undefined) {
    const first = hints[0]
    const keyW = stringWidth(first.key) + 1
    const label = keyW < rect.width ? truncate(first.label, rect.width - keyW) : ''
    kept.push({ key: first.key, label })
  }

  const spans: Span[] = []
  for (let i = 0; i < kept.length; i++) {
    const hint = kept[i]
    if (hint === undefined) continue
    if (i > 0) spans.push({ text: '  ', style: '' })
    spans.push({ text: hint.key, style: theme.accent })
    if (hint.label.length > 0) {
      spans.push({ text: ' ', style: '' })
      spans.push({ text: hint.label, style: theme.dim })
    }
  }
  paintLine(target, rect.row, rect.col, rect.width, makeLine(spans, rect.width))
}

function connectionStyle(connection: HeaderProps['connection'], theme: Theme): string {
  switch (connection) {
    case 'ready':
      return theme.ok
    case 'reconnecting':
      return theme.warn
    case 'closed':
      return theme.error
    case 'connecting':
      return theme.dim
    default: {
      const _never: never = connection
      return _never
    }
  }
}

function hostLabelText(host: HostDescription | undefined): string {
  if (host === undefined) return ''
  const provider = host.provider.trim()
  const model = host.model.trim()
  if (provider.length > 0 && model.length > 0) return `${provider} · ${model}`
  return model.length > 0 ? model : provider
}

function hintsWidth(hints: readonly { key: string; label: string }[]): number {
  let width = 0
  for (let i = 0; i < hints.length; i++) {
    const hint = hints[i]
    if (hint === undefined) continue
    if (i > 0) width += 2
    width += stringWidth(hint.key)
    if (hint.label.length > 0) width += 1 + stringWidth(hint.label)
  }
  return width
}
