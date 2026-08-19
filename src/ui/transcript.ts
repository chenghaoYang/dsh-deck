/**
 * Transcript layout is pure and width-correct: every returned line's display
 * width is ≤ options.width, including CJK. Paint is a window onto that list.
 */

import { stringWidth, truncate } from '../term/width.ts'
import type { TranscriptItem, ToolCallEntry } from '../model/fold.ts'
import type { Theme, Glyphs } from './theme.ts'
import type { Rect } from './layout.ts'
import {
  type RenderTarget,
  type RenderedLine,
  type Span,
  makeLine,
  wrapLines,
  paintLine,
  clearRect,
  spinnerGlyph,
  clipToWidth,
  spansWidth,
  fitSpans,
  repeatToWidth,
} from './render.ts'

export type { RenderedLine, RenderTarget } from './render.ts'

export interface TranscriptLayoutOptions {
  width: number
  theme: Theme
  glyphs: Glyphs
  /** Animation tick for the spinner on a streaming item. */
  spinnerFrame: number
  /** Render full tool arguments/results rather than a one-line summary. */
  expandTools: boolean
}

/** Pure: transcript items -> wrapped, styled lines, oldest first. */
export function layoutTranscript(
  items: readonly TranscriptItem[],
  options: TranscriptLayoutOptions,
): RenderedLine[] {
  const width = Math.max(1, options.width)
  const out: RenderedLine[] = []
  let seenTurn: number | undefined
  let emitted = 0

  for (const item of items) {
    const turn = 'turn' in item ? item.turn : undefined
    const isNewTurn = turn !== undefined && turn !== seenTurn
    if (item.kind === 'user' && emitted > 0) out.push(makeLine([], width))

    const chunk = layoutItem(item, options, width)
    if (isNewTurn && chunk[0] !== undefined) {
      seenTurn = turn
      const first = chunk[0]
      chunk[0] = { spans: first.spans, anchor: { kind: 'turn', turn } }
    }
    out.push(...chunk)
    emitted += chunk.length
  }
  return out
}

export interface TranscriptProps {
  rect: Rect
  lines: readonly RenderedLine[]
  /** Lines scrolled up from the bottom; 0 pins to the newest line. */
  scrollOffset: number
  theme: Theme
}

/** Paints the visible window and returns what the shell needs for the scrollbar. */
export function renderTranscript(
  target: RenderTarget,
  props: TranscriptProps,
): { maxScroll: number; visible: number } {
  const { rect, lines, theme } = props
  clearRect(target, rect, theme.base)
  const visible = Math.max(0, rect.height)
  if (rect.width <= 0 || visible === 0) return { maxScroll: 0, visible }

  const maxScroll = Math.max(0, lines.length - visible)
  const offset = Math.min(Math.max(0, props.scrollOffset), maxScroll)
  const end = lines.length - offset
  const start = Math.max(0, end - visible)
  const window = lines.slice(start, end)
  // Chat pin: fewer lines than the pane sit on the bottom edge.
  const row0 = rect.row + (visible - window.length)
  for (let i = 0; i < window.length; i++) {
    const line = window[i]
    if (line === undefined) continue
    paintLine(target, row0 + i, rect.col, rect.width, line)
  }
  return { maxScroll, visible }
}

function layoutItem(item: TranscriptItem, options: TranscriptLayoutOptions, width: number): RenderedLine[] {
  switch (item.kind) {
    case 'user':
      return layoutUser(item.text, options, width)
    case 'assistant':
      return layoutAssistant(item.text, item.streaming, options, width)
    case 'reasoning':
      return layoutReasoning(item.text, item.streaming, options, width)
    case 'tool':
      return layoutTool(item.call, options, width)
    case 'turn-end':
      return [ruleLine(width, item.reason, options.theme.dim, options.glyphs.hline)]
    case 'error':
      return hanging(
        `${options.glyphs.error} `,
        item.text,
        width,
        options.theme.error,
        options.theme.error,
      )
    case 'notice':
      return hanging('', item.text, width, options.theme.dim, options.theme.dim)
    default: {
      const _never: never = item
      return _never
    }
  }
}

function layoutUser(text: string, options: TranscriptLayoutOptions, width: number): RenderedLine[] {
  const prefix = `${options.glyphs.user} `
  return hanging(prefix, text, width, options.theme.user, options.theme.text)
}

function layoutAssistant(
  text: string,
  streaming: boolean,
  options: TranscriptLayoutOptions,
  width: number,
): RenderedLine[] {
  const { theme, glyphs } = options
  const lines: RenderedLine[] = []
  for (const block of splitAssistantBlocks(text)) {
    if (block.kind === 'code') {
      const rule = `${glyphs.vline} `
      const ruleW = stringWidth(rule)
      const inner = Math.max(1, width - ruleW)
      const body = wrapLines(block.text, inner)
      for (const row of body) {
        lines.push(
          makeLine(
            [
              { text: rule, style: theme.border },
              { text: row, style: theme.subtle },
            ],
            width,
          ),
        )
      }
    } else if (block.text.length > 0) {
      for (const row of wrapLines(block.text, width)) {
        lines.push(makeLine([{ text: row, style: theme.text }], width))
      }
    }
  }
  if (lines.length === 0) lines.push(makeLine([{ text: '', style: theme.text }], width))
  if (streaming) {
    const last = lines[lines.length - 1]
    if (last !== undefined) {
      lines[lines.length - 1] = appendSpinner(last, options, width, theme.running)
    }
  }
  return lines
}

function layoutReasoning(
  text: string,
  streaming: boolean,
  options: TranscriptLayoutOptions,
  width: number,
): RenderedLine[] {
  const { theme, glyphs, expandTools } = options
  const prefix = `${glyphs.reasoning} `
  const prefixW = stringWidth(prefix)
  const inner = prefixW < width ? width - prefixW : width
  const wrapped = text.length === 0 ? [''] : wrapLines(text, inner)
  const n = Math.max(1, wrapped.length)

  if (!streaming && !expandTools) {
    return hanging(prefix, `thought for ${n} lines`, width, theme.reasoning, theme.reasoning)
  }

  const visible = streaming && wrapped.length > 3 ? wrapped.slice(-3) : wrapped
  const lines = visible.map((row) =>
    makeLine(
      [
        { text: clipPrefix(prefix, width), style: theme.reasoning },
        { text: row, style: theme.reasoning },
      ],
      width,
    ),
  )
  if (streaming) {
    const last = lines[lines.length - 1]
    if (last !== undefined) {
      lines[lines.length - 1] = appendSpinner(last, options, width, theme.reasoning)
    }
  }
  return lines
}

function layoutTool(call: ToolCallEntry, options: TranscriptLayoutOptions, width: number): RenderedLine[] {
  const { theme, glyphs, expandTools } = options
  const awaiting = call.status === 'awaiting-approval'
  const headStyle = awaiting ? theme.warn : theme.tool
  const indent = '  '
  const indentW = stringWidth(indent)
  const inner = Math.max(1, width - indentW)
  const lines: RenderedLine[] = []

  const name = call.name.trim() || 'tool'
  const summary = toolArgSummary(call)
  const mark = `${glyphs.tool} `
  const namePart = summary.length > 0 ? `${name} ` : name
  const fixed = stringWidth(mark) + stringWidth(namePart)
  const summaryBudget = Math.max(0, width - fixed)
  const summaryText = summaryBudget > 0 && summary.length > 0 ? truncate(summary, summaryBudget) : ''
  const head: Span[] = [
    { text: mark, style: headStyle },
    { text: namePart, style: headStyle },
  ]
  if (summaryText.length > 0) head.push({ text: summaryText, style: awaiting ? theme.warn : theme.subtle })
  lines.push(makeLine(head, width))

  const statusStyle = toolStatusStyle(call.status, theme)
  const statusLabel = toolStatusLabel(call.status)
  const duration = durationLabel(call)
  const statusText = duration !== undefined ? `${statusLabel}  ${duration}` : statusLabel
  lines.push(
    makeLine(
      [
        { text: indent, style: '' },
        { text: statusText, style: statusStyle },
      ],
      width,
    ),
  )

  if (awaiting) {
    const affordance = '[a] allow  [r] reject'
    lines.push(
      makeLine(
        [
          { text: indent, style: '' },
          { text: clipToWidth(affordance, inner).text, style: theme.warn },
        ],
        width,
      ),
    )
  }

  if (expandTools) {
    const raw = expandedArgs(call)
    if (raw.length > 0) {
      for (const row of wrapLines(raw, inner)) {
        lines.push(
          makeLine(
            [
              { text: indent, style: '' },
              { text: row, style: theme.dim },
            ],
            width,
          ),
        )
      }
    }
  }

  const result = call.resultText
  if (result !== undefined && result.length > 0) {
    const resultStyle = call.isError === true || call.status === 'error' ? theme.error : theme.dim
    const wrapped = wrapLines(result, inner)
    const shown = expandTools ? wrapped : wrapped.slice(0, 6)
    for (const row of shown) {
      lines.push(
        makeLine(
          [
            { text: indent, style: '' },
            { text: row, style: resultStyle },
          ],
          width,
        ),
      )
    }
    if (!expandTools && wrapped.length > 6) {
      const more = `… +${wrapped.length - 6} more lines`
      lines.push(
        makeLine(
          [
            { text: indent, style: '' },
            { text: clipToWidth(more, inner).text, style: theme.dim },
          ],
          width,
        ),
      )
    }
  }

  if (call.status === 'pending' || call.status === 'running') {
    const last = lines[lines.length - 1]
    if (last !== undefined) {
      lines[lines.length - 1] = appendSpinner(last, options, width, theme.running)
    }
  }
  return lines
}

function hanging(
  prefix: string,
  text: string,
  width: number,
  prefixStyle: string,
  bodyStyle: string,
): RenderedLine[] {
  const prefixW = stringWidth(prefix)
  if (prefixW === 0) {
    return wrapLines(text, width).map((row) => makeLine([{ text: row, style: bodyStyle }], width))
  }
  if (prefixW >= width) {
    const head = makeLine([{ text: clipToWidth(prefix, width).text, style: prefixStyle }], width)
    const rest = wrapLines(text, width).map((row) => makeLine([{ text: row, style: bodyStyle }], width))
    return [head, ...rest]
  }
  const inner = width - prefixW
  const body = wrapLines(text, inner)
  const indent = ' '.repeat(prefixW)
  const shown = body.length > 0 ? body : ['']
  return shown.map((row, i) =>
    makeLine(
      [
        { text: i === 0 ? prefix : indent, style: i === 0 ? prefixStyle : '' },
        { text: row, style: bodyStyle },
      ],
      width,
    ),
  )
}

function clipPrefix(prefix: string, width: number): string {
  return clipToWidth(prefix, width).text
}

function appendSpinner(
  line: RenderedLine,
  options: TranscriptLayoutOptions,
  width: number,
  style: string,
): RenderedLine {
  const spin = spinnerGlyph(options.glyphs, options.spinnerFrame)
  if (spin.length === 0) return line
  const extra = ` ${spin}`
  const extraW = stringWidth(extra)
  const used = spansWidth(line.spans)
  const budget = extraW <= width ? width - extraW : 0
  const head = used + extraW <= width ? line.spans : fitSpans(line.spans, budget)
  const spans = [...head, { text: extra, style }]
  if (line.anchor !== undefined) return makeLine(spans, width, line.anchor)
  return makeLine(spans, width)
}

function ruleLine(width: number, label: string, style: string, hline: string): RenderedLine {
  const unit = stringWidth(hline) === 1 ? hline : '─'
  const trimmed = label.trim()
  if (trimmed.length === 0) {
    return makeLine([{ text: repeatToWidth(unit, width), style }], width)
  }
  const inner = ` ${trimmed} `
  const innerW = stringWidth(inner)
  if (innerW >= width) {
    return makeLine([{ text: truncate(trimmed, width), style }], width)
  }
  const rest = width - innerW
  const left = Math.floor(rest / 2)
  const right = rest - left
  return makeLine(
    [{ text: repeatToWidth(unit, left) + inner + repeatToWidth(unit, right), style }],
    width,
  )
}

function splitAssistantBlocks(text: string): { kind: 'text' | 'code'; text: string }[] {
  const rows = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: { kind: 'text' | 'code'; text: string }[] = []
  let buf: string[] = []
  let inCode = false
  const flush = (kind: 'text' | 'code'): void => {
    if (kind === 'text' && buf.length === 0) return
    if (kind === 'code' && buf.length === 0) {
      buf = []
      return
    }
    blocks.push({ kind, text: buf.join('\n') })
    buf = []
  }
  for (const row of rows) {
    if (row.startsWith('```')) {
      if (inCode) {
        flush('code')
        inCode = false
      } else {
        flush('text')
        inCode = true
      }
      continue
    }
    buf.push(row)
  }
  flush(inCode ? 'code' : 'text')
  return blocks
}

function toolArgSummary(call: ToolCallEntry): string {
  const args = call.args ?? parseArgs(call.argumentsRaw)
  if (args !== undefined) {
    const picked = pickArgSummary(call.name, args)
    if (picked !== undefined) return flattenOneLine(picked)
    return flattenOneLine(compactJson(args))
  }
  return flattenOneLine(call.argumentsRaw)
}

function expandedArgs(call: ToolCallEntry): string {
  if (call.args !== undefined) return compactJson(call.args)
  const parsed = parseArgs(call.argumentsRaw)
  if (parsed !== undefined) return compactJson(parsed)
  return call.argumentsRaw
}

function parseArgs(raw: string): Record<string, unknown> | undefined {
  if (raw.length === 0) return undefined
  try {
    const value: unknown = JSON.parse(raw)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch {
    return undefined
  }
  return undefined
}

function pickArgSummary(name: string, args: Record<string, unknown>): string | undefined {
  const key = name.toLowerCase()
  if (key === 'bash' || key === 'shell' || key === 'sh' || key === 'run') {
    const command = args.command
    if (typeof command === 'string') return command
  }
  const pathKeys = [
    'path',
    'file_path',
    'filePath',
    'target_file',
    'filename',
    'file',
    'target',
    'uri',
    'dir',
    'directory',
    'glob',
    'pattern',
  ] as const
  for (const pathKey of pathKeys) {
    const value = args[pathKey]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

function flattenOneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function toolStatusLabel(status: ToolCallEntry['status']): string {
  switch (status) {
    case 'awaiting-approval':
      return 'awaiting approval'
    case 'pending':
      return 'pending'
    case 'running':
      return 'running'
    case 'ok':
      return 'ok'
    case 'error':
      return 'error'
    case 'cancelled':
      return 'cancelled'
    default: {
      const _never: never = status
      return _never
    }
  }
}

function toolStatusStyle(status: ToolCallEntry['status'], theme: Theme): string {
  switch (status) {
    case 'awaiting-approval':
      return theme.warn
    case 'running':
      return theme.running
    case 'ok':
      return theme.ok
    case 'error':
      return theme.error
    case 'pending':
    case 'cancelled':
      return theme.dim
    default: {
      const _never: never = status
      return _never
    }
  }
}

function durationLabel(call: ToolCallEntry): string | undefined {
  if (call.startedAt === undefined || call.endedAt === undefined) return undefined
  const ms = call.endedAt - call.startedAt
  if (ms < 0) return undefined
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
