/**
 * Transcript layout is pure and width-correct: every returned line's display
 * width is ≤ options.width, including CJK. Paint is a window onto that list.
 *
 * Closed items are cached by seq/kind/fingerprint so a spinner tick does not
 * re-wrap the whole history. Streaming/running bodies may reuse a WeakMap hit
 * for the same object; the spinner glyph is always appended after lookup.
 */

import { stringWidth, truncate } from '../term/width.ts'
import { fileHref, linkableFilePath } from '../term/uri.ts'
import type { TranscriptItem, ToolCallEntry } from '../model/fold.ts'
import type { QueuedInboxItem, TokenUsage } from '../protocol/contract.ts'
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

/** Local stand-in until theme.glyphs grows an image mark. Do not edit theme.ts. */
const IMAGE_GLYPH = '▣'

const REASONING_TAIL_CHARS = 500
const REASONING_TAIL_SNAP = 80
const REASONING_STREAM_LINES = 3

export interface TranscriptLayoutOptions {
  width: number
  theme: Theme
  glyphs: Glyphs
  /** Animation tick for the spinner on a streaming item. */
  spinnerFrame: number
  /** Render full tool arguments/results rather than a one-line summary. */
  expandTools: boolean
  /** When omitted, follows `expandTools`. Independent of tools when set. */
  expandReasoning?: boolean
  queue?: readonly QueuedInboxItem[]
  retrying?: { count: number; reason?: string }
}

let cacheGen = ''
const closedCache = new Map<string, { fp: string; lines: RenderedLine[] }>()
const liveBodyCache = new WeakMap<object, { sig: string; lines: RenderedLine[] }>()

/** Drop cached wraps. Tests (and theme/glyph swaps) call this between fixtures. */
export function clearTranscriptLayoutCache(): void {
  closedCache.clear()
  cacheGen = ''
}

/** Pure: transcript items -> wrapped, styled lines, oldest first. */
export function layoutTranscript(
  items: readonly TranscriptItem[],
  options: TranscriptLayoutOptions,
): RenderedLine[] {
  const width = Math.max(1, options.width)
  const expandReasoning = options.expandReasoning ?? options.expandTools
  const gen = layoutGen(options, width, expandReasoning)
  if (gen !== cacheGen) {
    closedCache.clear()
    cacheGen = gen
  }

  const out: RenderedLine[] = []
  let seenTurn: number | undefined
  let emitted = 0

  for (const item of items) {
    const turn = 'turn' in item ? item.turn : undefined
    const isNewTurn = turn !== undefined && turn !== seenTurn
    if (item.kind === 'user' && emitted > 0) out.push(makeLine([], width))

    let chunk = layoutItemCached(item, options, width, expandReasoning, gen)
    if (isNewTurn && chunk[0] !== undefined) {
      seenTurn = turn
      const first = chunk[0]
      chunk = chunk.slice()
      chunk[0] = { spans: first.spans, anchor: { kind: 'turn', turn } }
    }
    out.push(...chunk)
    emitted += chunk.length
  }

  const queue = options.queue
  if (queue !== undefined) {
    for (const queued of queue) {
      out.push(layoutQueued(queued, options, width))
    }
  }

  const retrying = options.retrying
  if (retrying !== undefined) {
    out.push(layoutRetrying(retrying, options, width))
  }

  return out
}

export interface TranscriptProps {
  rect: Rect
  lines: readonly RenderedLine[]
  /** Lines scrolled up from the bottom; 0 pins to the newest line. */
  scrollOffset: number
  theme: Theme
  glyphs?: Glyphs
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
  // Short conversations start beneath the header. Bottom-pinning a three-line
  // reply in a 46-row Ghostty window makes the app look empty or broken.
  const row0 = rect.row
  const textWidth = maxScroll > 0 && rect.width > 1 ? rect.width - 1 : rect.width
  for (let i = 0; i < window.length; i++) {
    const line = window[i]
    if (line === undefined) continue
    paintLine(target, row0 + i, rect.col, textWidth, line)
  }

  if (maxScroll > 0 && rect.width >= 1) {
    paintScrollbar(target, props, maxScroll, visible, offset)
  }
  return { maxScroll, visible }
}

function paintScrollbar(
  target: RenderTarget,
  props: TranscriptProps,
  maxScroll: number,
  visible: number,
  offset: number,
): void {
  const { rect, theme, lines } = props
  const trackChar = oneCol(props.glyphs?.vline, '│')
  const thumbChar = oneCol(props.glyphs?.bar, '▎')
  const total = Math.max(lines.length, 1)
  const thumbH = Math.max(1, Math.min(visible, Math.round((visible * visible) / total)))
  const travel = Math.max(0, visible - thumbH)
  // offset 0 is bottom-pinned → thumb sits at the bottom of the track.
  const thumbTop = travel === 0 ? 0 : Math.round(((maxScroll - offset) / maxScroll) * travel)
  const x = rect.col + rect.width - 1
  for (let i = 0; i < visible; i++) {
    const thumb = i >= thumbTop && i < thumbTop + thumbH
    target.put(
      rect.row + i,
      x,
      thumb ? thumbChar : trackChar,
      thumb ? theme.accent : theme.border,
    )
  }
}

function oneCol(glyph: string | undefined, fallback: string): string {
  if (glyph === undefined || glyph.length === 0) return fallback
  return stringWidth(glyph) === 1 ? glyph : fallback
}

function layoutGen(options: TranscriptLayoutOptions, width: number, expandReasoning: boolean): string {
  return `${width}:${options.expandTools ? 1 : 0}:${expandReasoning ? 1 : 0}:${options.glyphs.assistant}:${options.glyphs.tool}:${options.glyphs.reasoning}:${options.glyphs.vline}:${options.theme.text}:${options.theme.accent}`
}

function layoutItemCached(
  item: TranscriptItem,
  options: TranscriptLayoutOptions,
  width: number,
  expandReasoning: boolean,
  gen: string,
): RenderedLine[] {
  const fp = itemFingerprint(item)
  const live = itemNeedsSpinner(item)
  let body: RenderedLine[] | undefined

  if (live) {
    const hit = liveBodyCache.get(item)
    if (hit !== undefined && hit.sig === `${gen}:${fp}`) body = hit.lines
  } else {
    const slot = `${item.seq}:${item.kind}`
    const hit = closedCache.get(slot)
    if (hit !== undefined && hit.fp === fp) body = hit.lines
  }

  if (body === undefined) {
    body = layoutItem(item, options, width, expandReasoning)
    if (live) liveBodyCache.set(item, { sig: `${gen}:${fp}`, lines: body })
    else closedCache.set(`${item.seq}:${item.kind}`, { fp, lines: body })
  }

  if (!live || body.length === 0) return body
  const last = body[body.length - 1]
  if (last === undefined) return body
  const copy = body.slice()
  copy[copy.length - 1] = appendSpinner(last, options, width, spinnerStyleFor(item, options.theme))
  return copy
}

function itemNeedsSpinner(item: TranscriptItem): boolean {
  if (item.kind === 'assistant' || item.kind === 'reasoning') return item.streaming
  if (item.kind === 'tool') {
    const status = item.call.status
    return status === 'pending' || status === 'running'
  }
  return false
}

function spinnerStyleFor(item: TranscriptItem, theme: Theme): string {
  if (item.kind === 'reasoning') return theme.reasoning
  return theme.running
}

function itemFingerprint(item: TranscriptItem): string {
  switch (item.kind) {
    case 'user':
    case 'error':
    case 'notice':
      return textFp(item.text)
    case 'assistant':
    case 'reasoning':
      return `${item.streaming ? 1 : 0}:${textFp(item.text)}`
    case 'tool':
      return toolFp(item.call)
    case 'image':
      return `${item.alt}:${item.mediaType ?? ''}:${item.attachmentId ?? ''}`
    case 'turn-end':
      return `${item.reason}:${item.elapsedMs ?? ''}:${item.usage?.inputTokens ?? ''}:${item.usage?.outputTokens ?? ''}`
    default: {
      const _never: never = item
      return _never
    }
  }
}

function textFp(text: string): string {
  const n = text.length
  if (n < 48) return text
  return `${n}:${text.slice(0, 16)}:${text.slice(-16)}`
}

function toolFp(call: ToolCallEntry): string {
  const result = call.resultText ?? ''
  return `${call.callId}:${call.name}:${call.status}:${call.isError === true ? 1 : 0}:${call.startedAt ?? ''}:${call.endedAt ?? ''}:${textFp(call.argumentsRaw)}:${textFp(result)}`
}

function layoutItem(
  item: TranscriptItem,
  options: TranscriptLayoutOptions,
  width: number,
  expandReasoning: boolean,
): RenderedLine[] {
  switch (item.kind) {
    case 'user':
      return layoutUser(item.text, options, width)
    case 'assistant':
      return layoutAssistant(item.text, options, width)
    case 'reasoning':
      return layoutReasoning(item.text, item.streaming, options, width, expandReasoning)
    case 'tool':
      return layoutTool(item.call, options, width)
    case 'image':
      return [layoutImage(item, options, width)]
    case 'turn-end':
      return [ruleLine(width, turnEndLabel(item), options.theme.dim, options.glyphs.hline)]
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

function layoutImage(
  item: Extract<TranscriptItem, { kind: 'image' }>,
  options: TranscriptLayoutOptions,
  width: number,
): RenderedLine {
  const ascii = process.env.DECK_ASCII === '1'
  const mark = ascii ? '# ' : `${IMAGE_GLYPH} `
  const short = mediaShort(item.mediaType)
  const kind = short !== undefined ? `image (${short})` : 'image'
  const text = `${mark}${kind} · ctrl+o to view`
  return makeLine([{ text: truncate(text, width), style: options.theme.subtle }], width)
}

/**
 * The inbox carries two unlike things under one shape. `queued` and `steering`
 * items are prompts the user wrote and the agent has not read yet, so they
 * belong behind the user glyph. `context` items are notes the harness injects
 * on the user's behalf — switching the permission preset appends "The approval
 * policy changed from …" — and showing those behind the same glyph reads as if
 * the user had typed them and was waiting to send. They are worth showing (the
 * agent is about to be told something) but they are not the user talking.
 */
function layoutQueued(
  item: QueuedInboxItem,
  options: TranscriptLayoutOptions,
  width: number,
): RenderedLine {
  const injected = item.placement === 'context'
  const prefix = injected
    ? `${options.glyphs.reasoning} (context) `
    : `${options.glyphs.user} (queued) `
  const prefixW = stringWidth(prefix)
  if (prefixW >= width) {
    return makeLine([{ text: truncate(prefix.trimEnd(), width), style: options.theme.dim }], width)
  }
  const preview = truncate(queuedPreview(item), width - prefixW)
  return makeLine(
    [
      { text: prefix, style: options.theme.dim },
      { text: preview, style: options.theme.dim },
    ],
    width,
  )
}

function layoutRetrying(
  retrying: { count: number; reason?: string },
  options: TranscriptLayoutOptions,
  width: number,
): RenderedLine {
  const spin = spinnerGlyph(options.glyphs, options.spinnerFrame)
  const head = spin.length > 0 ? `${spin} ` : ''
  let text = `${head}retrying (${retrying.count})`
  if (retrying.reason !== undefined && retrying.reason.length > 0) {
    text += ` — ${retrying.reason}`
  }
  return makeLine([{ text: truncate(text, width), style: options.theme.warn }], width)
}

function layoutUser(text: string, options: TranscriptLayoutOptions, width: number): RenderedLine[] {
  const prefix = `${options.glyphs.user} `
  return hanging(prefix, text, width, options.theme.user, options.theme.text)
}

function layoutAssistant(
  text: string,
  options: TranscriptLayoutOptions,
  width: number,
): RenderedLine[] {
  const { theme, glyphs } = options
  const lines: RenderedLine[] = []
  let first = true
  for (const block of splitAssistantBlocks(text)) {
    if (block.kind === 'code') {
      const rule = `${glyphs.vline} `
      const ruleW = stringWidth(rule)
      const inner = Math.max(1, width - ruleW)
      if (block.language.length > 0) {
        lines.push(
          makeLine(
            [
              { text: rule, style: theme.border },
              { text: clipToWidth(block.language, inner).text, style: theme.subtle },
            ],
            width,
          ),
        )
      }
      const body = wrapLines(block.text, inner)
      for (const row of body) {
        lines.push(
          makeLine(
            [
              { text: rule, style: theme.border },
              { text: row, style: theme.text },
            ],
            width,
          ),
        )
      }
      first = false
    } else if (block.text.length > 0) {
      const md = layoutMarkdownText(block.text, options, width, first)
      lines.push(...md)
      first = false
    }
  }
  if (lines.length === 0) lines.push(makeLine([{ text: '', style: theme.text }], width))
  return lines
}

function layoutMarkdownText(
  text: string,
  options: TranscriptLayoutOptions,
  width: number,
  prefixFirst: boolean,
): RenderedLine[] {
  const { theme, glyphs } = options
  const rows = text.replace(/\r\n/g, '\n').split('\n')
  const lines: RenderedLine[] = []
  let isFirst = prefixFirst
  for (const row of rows) {
    const lead = isFirst ? `${glyphs.assistant} ` : ''
    isFirst = false
    const heading = /^(#{1,3}) (.*)$/.exec(row)
    if (heading !== null && heading[2] !== undefined) {
      lines.push(...layoutMdLine(lead, heading[2], width, theme.accent, theme.accent, theme))
      continue
    }
    const ul = /^([-*]) (.*)$/.exec(row)
    if (ul !== null && ul[1] !== undefined && ul[2] !== undefined) {
      lines.push(...layoutMdLine(`${lead}${ul[1]} `, ul[2], width, theme.text, theme.text, theme))
      continue
    }
    const ol = /^(\d+)\. (.*)$/.exec(row)
    if (ol !== null && ol[1] !== undefined && ol[2] !== undefined) {
      lines.push(...layoutMdLine(`${lead}${ol[1]}. `, ol[2], width, theme.text, theme.text, theme))
      continue
    }
    if (row.length === 0) {
      if (lead.length > 0) {
        lines.push(makeLine([{ text: clipToWidth(lead, width).text, style: theme.assistant }], width))
      } else {
        lines.push(makeLine([], width))
      }
      continue
    }
    lines.push(...layoutMdLine(lead, row, width, theme.assistant, theme.text, theme))
  }
  return lines
}

function layoutMdLine(
  prefix: string,
  rest: string,
  width: number,
  prefixStyle: string,
  baseStyle: string,
  theme: Theme,
): RenderedLine[] {
  const prefixW = stringWidth(prefix)
  if (prefixW >= width) {
    const head = makeLine([{ text: clipToWidth(prefix, width).text, style: prefixStyle }], width)
    return [head, ...layoutMdLine('', rest, width, prefixStyle, baseStyle, theme)]
  }
  const inner = Math.max(1, width - prefixW)
  const wrapped = rest.length === 0 ? [''] : wrapLines(rest, inner)
  const indent = prefixW > 0 ? ' '.repeat(prefixW) : ''
  return wrapped.map((row, i) => {
    const head = i === 0 ? prefix : indent
    const inline = parseInline(row, baseStyle, theme)
    const spans: Span[] = []
    if (head.length > 0) spans.push({ text: head, style: i === 0 ? prefixStyle : '' })
    spans.push(...inline)
    return makeLine(spans, width)
  })
}

function parseInline(text: string, baseStyle: string, theme: Theme): Span[] {
  if (text.length === 0) return []
  const spans: Span[] = []
  let buf = ''
  let i = 0
  const flush = (style: string): void => {
    if (buf.length === 0) return
    spans.push({ text: buf, style })
    buf = ''
  }
  while (i < text.length) {
    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2)
      if (end >= i + 2) {
        flush(baseStyle)
        const inner = text.slice(i + 2, end)
        if (inner.length > 0) spans.push({ text: inner, style: theme.accent })
        i = end + 2
        continue
      }
    }
    if (text.charCodeAt(i) === 96) {
      const end = text.indexOf('`', i + 1)
      if (end > i + 1) {
        flush(baseStyle)
        spans.push({ text: text.slice(i + 1, end), style: theme.subtle })
        i = end + 1
        continue
      }
    }
    buf += text[i] ?? ''
    i += 1
  }
  flush(baseStyle)
  return spans
}

function layoutReasoning(
  text: string,
  streaming: boolean,
  options: TranscriptLayoutOptions,
  width: number,
  expandReasoning: boolean,
): RenderedLine[] {
  const { theme, glyphs } = options
  const prefix = `${glyphs.reasoning} `
  const prefixW = stringWidth(prefix)
  const inner = prefixW < width ? width - prefixW : width

  if (!streaming && !expandReasoning) {
    const n = estimateWrappedLines(text, inner)
    return hanging(prefix, `thought for ${n} lines`, width, theme.reasoning, theme.reasoning)
  }

  const source = streaming && !expandReasoning ? reasoningTailWindow(text) : text
  const wrapped = source.length === 0 ? [''] : wrapLines(source, inner)
  const visible =
    streaming && !expandReasoning && wrapped.length > REASONING_STREAM_LINES
      ? wrapped.slice(-REASONING_STREAM_LINES)
      : wrapped
  return visible.map((row) =>
    makeLine(
      [
        { text: clipPrefix(prefix, width), style: theme.reasoning },
        { text: row, style: theme.reasoning },
      ],
      width,
    ),
  )
}

function reasoningTailWindow(text: string): string {
  if (text.length <= REASONING_TAIL_CHARS) return text
  const cut = text.length - REASONING_TAIL_CHARS
  const nl = text.lastIndexOf('\n', cut)
  if (nl >= 0 && nl >= cut - REASONING_TAIL_SNAP) return text.slice(nl + 1)
  return text.slice(cut)
}

function estimateWrappedLines(text: string, inner: number): number {
  if (text.length === 0) return 1
  const cols = Math.max(1, inner)
  const paragraphs = text.replace(/\r\n/g, '\n').split('\n')
  let n = 0
  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      n += 1
      continue
    }
    n += Math.max(1, Math.ceil(stringWidth(paragraph) / cols))
  }
  return Math.max(1, n)
}

function layoutTool(call: ToolCallEntry, options: TranscriptLayoutOptions, width: number): RenderedLine[] {
  const { theme, expandTools } = options
  const awaiting = call.status === 'awaiting-approval'
  const indent = '  '
  const indentW = stringWidth(indent)
  const inner = Math.max(1, width - indentW)
  const lines: RenderedLine[] = [makeToolHeadline(call, options, width)]

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

  if (!expandTools) return lines

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

  const result = call.resultText
  if (result !== undefined && result.length > 0) {
    const resultStyle = call.isError === true || call.status === 'error' ? theme.error : theme.dim
    for (const row of wrapLines(result, inner)) {
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
  }
  return lines
}

function makeToolHeadline(call: ToolCallEntry, options: TranscriptLayoutOptions, width: number): RenderedLine {
  const { theme, glyphs } = options
  const awaiting = call.status === 'awaiting-approval'
  const headStyle = awaiting ? theme.warn : theme.tool
  const mark = `${glyphs.tool} `
  const name = call.name.trim() || 'tool'
  const args = call.args ?? parseArgs(call.argumentsRaw)
  const summary = toolArgSummary(call, args)
  const href = toolLink(call.name, args)
  const statusLabel = toolStatusLabel(call.status)
  const duration = durationLabel(call)
  const statusText = duration !== undefined ? `${statusLabel}  ${duration}` : statusLabel
  const statusStyle = toolStatusStyle(call.status, theme)
  const statusW = stringWidth(statusText)
  const gapMin = statusW > 0 ? 2 : 0
  const availLeft = Math.max(0, width - statusW - gapMin)

  const spans: Span[] = []
  const markW = stringWidth(mark)
  if (markW > availLeft) {
    const clipped = clipToWidth(`${mark}${name} ${summary} ${statusText}`.trim(), width)
    return makeLine([{ text: clipped.text, style: headStyle }], width)
  }
  spans.push({ text: mark, style: headStyle })
  let rest = availLeft - markW
  const namePart = summary.length > 0 ? `${name} ` : name
  const nameW = stringWidth(namePart)
  if (nameW > rest) {
    spans.push({ text: truncate(namePart.trimEnd(), rest), style: headStyle })
  } else {
    spans.push({ text: namePart, style: headStyle })
    rest -= nameW
    if (rest > 0 && summary.length > 0) {
      const summaryText = truncate(summary, rest)
      if (summaryText.length > 0) {
        const style = awaiting ? theme.warn : theme.subtle
        if (href === undefined) spans.push({ text: summaryText, style })
        else spans.push({ text: summaryText, style, link: href })
      }
    }
  }

  if (statusText.length > 0) {
    const leftW = spansWidth(spans)
    const padW = Math.max(gapMin, width - leftW - statusW)
    if (padW > 0) spans.push({ text: ' '.repeat(padW), style: '' })
    spans.push({ text: statusText, style: statusStyle })
  }
  return makeLine(spans, width)
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

function splitAssistantBlocks(text: string): { kind: 'text' | 'code'; text: string; language: string }[] {
  const rows = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: { kind: 'text' | 'code'; text: string; language: string }[] = []
  let buf: string[] = []
  let inCode = false
  let language = ''
  const flush = (kind: 'text' | 'code'): void => {
    if (kind === 'text' && buf.length === 0) return
    if (kind === 'code' && buf.length === 0 && language.length === 0) {
      buf = []
      return
    }
    blocks.push({ kind, text: buf.join('\n'), language })
    buf = []
    language = ''
  }
  for (const row of rows) {
    if (row.startsWith('```')) {
      if (inCode) {
        flush('code')
        inCode = false
      } else {
        flush('text')
        inCode = true
        language = row.slice(3).trim()
      }
      continue
    }
    buf.push(row)
  }
  if (inCode) {
    const open = language.length > 0 ? `\`\`\`${language}` : '```'
    buf = [open, ...buf]
    language = ''
    flush('text')
  } else {
    flush('text')
  }
  return blocks
}

function toolArgSummary(call: ToolCallEntry, args: Record<string, unknown> | undefined): string {
  if (args !== undefined) {
    const picked = pickArgSummary(call.name, args)
    if (picked !== undefined) return flattenOneLine(picked)
    return flattenOneLine(compactJson(args))
  }
  return flattenOneLine(call.argumentsRaw)
}

function toolLink(name: string, args: Record<string, unknown> | undefined): string | undefined {
  if (args === undefined) return undefined
  const key = name.trim().toLowerCase()
  if (key === 'bash' || key === 'shell' || key === 'sh' || key === 'run') return undefined
  const picked = pickArgSummary(name, args)
  if (picked === undefined || !linkableFilePath(picked)) return undefined
  const line = toolLinkLine(args)
  return line === undefined ? fileHref(picked) : fileHref(picked, line)
}

function toolLinkLine(args: Record<string, unknown>): number | undefined {
  for (const key of ['line', 'line_number', 'lineNumber', 'offset'] as const) {
    const value = args[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
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
  return formatElapsed(ms)
}

function turnEndLabel(item: Extract<TranscriptItem, { kind: 'turn-end' }>): string {
  const parts: string[] = []
  const reason = item.reason.trim()
  if (reason.length > 0) parts.push(reason)
  if (item.elapsedMs !== undefined && item.elapsedMs >= 0) parts.push(formatElapsed(item.elapsedMs))
  const usage = formatUsage(item.usage)
  if (usage !== undefined) parts.push(usage)
  return parts.join(' · ')
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatUsage(usage: TokenUsage | undefined): string | undefined {
  if (usage === undefined) return undefined
  const parts: string[] = []
  if (usage.inputTokens !== undefined) parts.push(`↑${humanizeCount(usage.inputTokens)}`)
  if (usage.outputTokens !== undefined) parts.push(`↓${humanizeCount(usage.outputTokens)}`)
  if (parts.length === 0) return undefined
  return `${parts.join(' ')} tok`
}

function humanizeCount(value: number): string {
  const sign = value < 0 ? '-' : ''
  const n = Math.abs(value)
  if (n < 1000) return `${sign}${Math.round(n)}`
  if (n < 1_000_000) return `${sign}${(n / 1000).toFixed(1)}k`
  return `${sign}${(n / 1_000_000).toFixed(1)}m`
}

function mediaShort(mediaType: string | undefined): string | undefined {
  if (mediaType === undefined || mediaType.length === 0) return undefined
  const slash = mediaType.lastIndexOf('/')
  const raw = (slash >= 0 ? mediaType.slice(slash + 1) : mediaType).trim().toLowerCase()
  return raw.length > 0 ? raw : undefined
}

function queuedPreview(item: QueuedInboxItem): string {
  const content: unknown = item.message.content
  return firstLine(extractContentText(content))
}

function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (block === null || typeof block !== 'object') continue
    const rec = block as Record<string, unknown>
    if (typeof rec.text === 'string' && (rec.type === 'text' || rec.type === undefined)) {
      parts.push(rec.text)
    }
  }
  return parts.join('')
}

function firstLine(text: string): string {
  const line = text.replace(/\r\n/g, '\n').split('\n')[0]
  return line ?? ''
}
