/**
 * Modal key-binding panel. Glyphs follow DECK_ASCII because the signature
 * does not receive a Glyphs object.
 */

import { stringWidth, truncate } from '../term/width.ts'
import type { Theme } from './theme.ts'
import type { Rect } from './layout.ts'
import { type RenderTarget, clearRect, clipToWidth, padTo, repeatToWidth } from './render.ts'

export function renderHelp(
  target: RenderTarget,
  rect: Rect,
  theme: Theme,
  bindings: readonly { keys: string; label: string }[],
): void {
  if (rect.width <= 0 || rect.height <= 0) return

  const box = boxChars()
  const keyW = bindings.reduce((n, b) => Math.max(n, stringWidth(b.keys)), 0)
  const labelW = bindings.reduce((n, b) => Math.max(n, stringWidth(b.label)), 0)
  const innerMin = Math.max(10, keyW + 2 + labelW)
  const boxW = Math.min(rect.width, Math.max(16, innerMin + 4))
  const boxH = Math.min(rect.height, Math.max(3, bindings.length + 2))
  if (boxW < 4 || boxH < 2) return

  const row = rect.row + Math.floor((rect.height - boxH) / 2)
  const col = rect.col + Math.floor((rect.width - boxW) / 2)
  const innerW = boxW - 2

  clearRect(target, { row, col, width: boxW, height: boxH }, theme.base)

  const labeled = ' help '
  const titleW = stringWidth(labeled)
  target.put(row, col, box.tl, theme.border)
  if (boxW >= 2) target.put(row, col + boxW - 1, box.tr, theme.border)
  if (innerW > 0) {
    if (titleW + 2 <= innerW) {
      const rest = innerW - titleW
      const left = 1
      const right = rest - left
      let x = col + 1
      if (left > 0) {
        target.put(row, x, repeatToWidth(box.h, left), theme.border)
        x += left
      }
      target.put(row, x, labeled, theme.accent)
      x += titleW
      if (right > 0) target.put(row, x, repeatToWidth(box.h, right), theme.border)
    } else {
      const cut = truncate('help', innerW)
      const cutW = stringWidth(cut)
      if (cutW > 0) target.put(row, col + 1, cut, theme.accent)
      if (cutW < innerW) {
        target.put(row, col + 1 + cutW, repeatToWidth(box.h, innerW - cutW), theme.border)
      }
    }
  }

  const bodyRows = boxH - 2
  for (let i = 0; i < bodyRows; i++) {
    const binding = bindings[i]
    let content = ''
    if (binding !== undefined) {
      const keys = padTo(binding.keys, keyW)
      const budget = Math.max(0, innerW - 2 - stringWidth(keys) - 2)
      const label = budget > 0 ? truncate(binding.label, budget) : ''
      content = ` ${keys}  ${label}`
    }
    const mid = padTo(clipToWidth(content, innerW).text, innerW)
    target.put(row + 1 + i, col, box.v, theme.border)
    if (mid.length > 0) target.put(row + 1 + i, col + 1, mid, theme.text)
    target.put(row + 1 + i, col + boxW - 1, box.v, theme.border)
  }

  const bot = `${box.bl}${repeatToWidth(box.h, innerW)}${box.br}`
  target.put(row + boxH - 1, col, clipToWidth(bot, boxW).text, theme.border)
}

function boxChars(): { h: string; v: string; tl: string; tr: string; bl: string; br: string } {
  if (process.env.DECK_ASCII === '1') {
    return { h: '-', v: '|', tl: '+', tr: '+', bl: '+', br: '+' }
  }
  return { h: '─', v: '│', tl: '╭', tr: '╮', bl: '╰', br: '╯' }
}
