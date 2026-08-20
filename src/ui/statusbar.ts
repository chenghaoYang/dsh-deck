/**
 * Header / footer chrome. Saturated color is reserved for connection state,
 * transient messages, and safety chips; everything else stays dim.
 */

import { stringWidth, truncate } from '../term/width.ts'
import type { HostDescription } from '../protocol/contract.ts'
import type { SessionTelemetry } from '../model/store.ts'
import type { Theme, Glyphs } from './theme.ts'
import type { Rect } from './layout.ts'
import { type RenderTarget, type Span, paintLine, clearRect, makeLine, spansWidth } from './render.ts'

export type { SessionTelemetry }

/** Per-session dsh mode state, as shown in the header. */
export interface ModeSummary {
  /** Provider route id, e.g. "nvidia". */
  provider?: string
  /** Model id, e.g. "thinkingmachines/inkling". */
  model?: string
  /** Reasoning effort id, e.g. "high". */
  effort?: string
  /** Permission preset id, e.g. "workspace-write". */
  permission?: string
  /** Agent preset display name, possibly localized (may be CJK). */
  preset?: string
  /** Plan mode. */
  plan?: { active: boolean; pending: boolean }
}

export interface HeaderProps {
  rect: Rect
  host: HostDescription | undefined
  connection: 'connecting' | 'ready' | 'reconnecting' | 'closed'
  sessionTitle: string | undefined
  /** Basename of the focused session workspace, shown before the session title. */
  project?: string
  theme: Theme
  glyphs: Glyphs
  telemetry?: SessionTelemetry
  modes?: ModeSummary
}

export function renderHeader(target: RenderTarget, props: HeaderProps): void {
  const { rect, host, connection, sessionTitle, theme } = props
  clearRect(target, rect, theme.base)
  if (rect.width <= 0 || rect.height <= 0) return

  const ascii = process.env.DECK_ASCII === '1'
  const dot = ascii ? '*' : '●'
  const connStyle = connectionStyle(connection, theme)
  const session = sessionTitle !== undefined ? sessionTitle.trim() : ''
  const project = props.project?.trim() ?? ''
  const title = project.length === 0
    ? session
    : session.length === 0 || session === project
      ? project
      : `${project} / ${session}`
  const hostLabel = hostLabelText(host)
  const modes = props.modes

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
  const hostW = hostLabel.length > 0 ? stringWidth(hostLabel) : 0
  // Title yields to the persistent right cluster (host, or safety+short model).
  const rightReserve = modes === undefined ? hostW : reservedModesWidth(modes, host, theme)
  const hostGap = rightReserve > 0 ? 2 : 0
  const titleBudget = rect.width - used - rightReserve - hostGap

  if (title.length > 0 && titleBudget > 0) {
    spans.push({ text: truncate(title, titleBudget), style: theme.text })
  } else if (title.length === 0 && host === undefined && rect.width - used >= connCost + 1 && rect.width < 52) {
    spans.push({ text: connWord, style: connStyle })
  }

  const usedAfter = spans.reduce((n, s) => n + stringWidth(s.text), 0)
  const available = rect.width - usedAfter

  if (modes === undefined) {
    const telSpans = fitTelemetry(telemetrySegments(props.telemetry, theme), available, hostW, theme.dim)
    const telW = spansWidth(telSpans)
    const sep = telW > 0 && hostW > 0 ? 2 : 0
    const rightW = telW + sep + hostW

    if (rightW > 0 && usedAfter + rightW <= rect.width) {
      spans.push({ text: ' '.repeat(rect.width - usedAfter - rightW), style: '' })
      spans.push(...telSpans)
      if (sep > 0) spans.push({ text: '  ', style: '' })
      if (hostW > 0) spans.push({ text: hostLabel, style: theme.subtle })
    }
  } else {
    // Title budget already subtracted hostGap, but fitGroups would otherwise
    // spend those two columns on a wider cluster and land flush against the
    // title. Keep the gap reserved for whatever the first cluster element is.
    const clusterGap = title.length > 0 && titleBudget > 0 ? 2 : 0
    const rightSpans = fitGroups(
      modeGroups(modes, host, props.telemetry, theme),
      Math.max(0, available - clusterGap),
      theme.dim,
    )
    const rightW = spansWidth(rightSpans)
    if (rightW > 0 && usedAfter + clusterGap + rightW <= rect.width) {
      spans.push({ text: ' '.repeat(rect.width - usedAfter - rightW), style: '' })
      spans.push(...rightSpans)
    }
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
  const provider = host.provider?.trim() ?? ''
  const model = host.model?.trim() ?? ''
  if (provider.length > 0 && model.length > 0) return `${provider} · ${model}`
  return model.length > 0 ? model : provider
}

interface ClusterSeg {
  text: string
  style: string
}

interface ClusterGroup {
  segs: ClusterSeg[]
  /** Longer-to-shorter alternatives; used by the model label under width pressure. */
  variants?: ClusterSeg[][]
}

function modeGroups(
  modes: ModeSummary,
  host: HostDescription | undefined,
  telemetry: SessionTelemetry | undefined,
  theme: Theme,
): ClusterGroup[] {
  // Visual LTR = most important → least. fitGroups pops from the right.
  const groups: ClusterGroup[] = [...safetyChipGroups(modes, theme)]

  const variants = modelLabelVariants(modelParts(modes, host), theme.subtle)
  const longest = variants[0]
  if (longest !== undefined) groups.push({ segs: longest, variants })

  const tel = telemetrySegments(telemetry, theme)
  if (tel.length > 0) groups.push({ segs: tel })

  const preset = modes.preset?.trim() ?? ''
  if (preset.length > 0) groups.push({ segs: [{ text: preset, style: theme.dim }] })
  return groups
}

/**
 * Columns the title must leave for mode state. This reserves the shortest
 * variant that still *keeps the reasoning effort*, not the absolute shortest:
 * the title also appears in the sidebar and in the switcher, so letting it grow
 * until the header can only afford a bare model id trades state the user set on
 * purpose for a few more characters of a string shown in three other places.
 */
function reservedModesWidth(modes: ModeSummary, host: HostDescription | undefined, theme: Theme): number {
  const chips = safetyChipGroups(modes, theme)
  const parts = modelParts(modes, host)
  const variants = modelLabelVariants(parts, theme.subtle)
  const keepsEffort = (variant: readonly ClusterSeg[]): boolean =>
    parts.effort.length === 0 || variant.some((seg) => seg.text === parts.effort)
  let floor: ClusterSeg[] | undefined
  for (const variant of variants) {
    if (keepsEffort(variant)) floor = variant
  }
  const groups: ClusterGroup[] = [...chips]
  if (floor !== undefined) groups.push({ segs: floor })
  return spansWidth(joinGroups(groups, theme.dim))
}

function safetyChipGroups(modes: ModeSummary, theme: Theme): ClusterGroup[] {
  const groups: ClusterGroup[] = []
  const perm = modes.permission?.trim() ?? ''
  // workspace-write is the normal default. Omit it so the header stays quiet
  // and a non-default permission (read-only / danger-full-access) stands out.
  if (perm === 'danger-full-access') {
    groups.push({ segs: [{ text: 'full-access', style: theme.error }] })
  } else if (perm === 'read-only') {
    groups.push({ segs: [{ text: 'read-only', style: theme.warn }] })
  }
  const plan = modes.plan
  if (plan !== undefined) {
    if (plan.active) {
      groups.push({ segs: [{ text: 'plan', style: theme.accent }] })
    } else if (plan.pending) {
      groups.push({ segs: [{ text: 'plan?', style: theme.warn }] })
    }
  }
  return groups
}

function modelParts(
  modes: ModeSummary,
  host: HostDescription | undefined,
): { provider: string; model: string; effort: string } {
  const modeModel = modes.model?.trim() ?? ''
  const effort = modes.effort?.trim() ?? ''
  if (modeModel.length > 0) {
    return { provider: modes.provider?.trim() ?? '', model: modeModel, effort }
  }
  if (host === undefined) return { provider: '', model: '', effort }
  return { provider: host.provider?.trim() ?? '', model: host.model?.trim() ?? '', effort }
}

/** Strip `org/` prefixes so `thinkingmachines/inkling` can shrink to `inkling`. */
function shortModelId(model: string): string {
  const i = model.lastIndexOf('/')
  if (i === -1 || i === model.length - 1) return model
  return model.slice(i + 1)
}

function modelLabelVariants(
  parts: { provider: string; model: string; effort: string },
  style: string,
): ClusterSeg[][] {
  const provider = parts.provider
  const full = parts.model
  const short = shortModelId(full)
  const effort = parts.effort
  const seen = new Set<string>()
  const out: ClusterSeg[][] = []
  const add = (texts: string[]): void => {
    if (texts.some((t) => t.length === 0)) return
    const key = texts.join('\0')
    if (seen.has(key)) return
    seen.add(key)
    out.push(texts.map((text) => ({ text, style })))
  }
  // Ordered longest to shortest, but the effort outranks the vendor prefix at
  // every step: the effort is state the user deliberately chose, while
  // `thinkingmachines/` only repeats what the provider route already says.
  // Spending columns on the prefix and dropping `high` was the wrong trade.
  add([provider, full, effort])
  add([provider, short, effort])
  add([provider, full])
  add([provider, short])
  add([short, effort])
  add([full])
  add([short])
  add([provider])
  return out
}

function joinSegs(segs: readonly ClusterSeg[], dim: string): Span[] {
  const spans: Span[] = []
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    if (seg === undefined) continue
    if (i > 0) spans.push({ text: ' · ', style: dim })
    spans.push({ text: seg.text, style: seg.style })
  }
  return spans
}

function joinGroups(groups: readonly ClusterGroup[], dim: string): Span[] {
  const spans: Span[] = []
  for (const group of groups) {
    if (group.segs.length === 0) continue
    if (spans.length > 0) spans.push({ text: '  ', style: '' })
    spans.push(...joinSegs(group.segs, dim))
  }
  return spans
}

/**
 * Drop from the right of a most-to-least-important cluster until it fits.
 * A group with `variants` shrinks through those first; otherwise its last
 * segment is popped (telemetry right-to-left, same as fitTelemetry).
 */
function fitGroups(groups: readonly ClusterGroup[], available: number, dim: string): Span[] {
  if (available <= 0) return []
  const chosen: ClusterGroup[] = []
  for (const group of groups) {
    if (group.segs.length === 0) continue
    const copy: ClusterGroup = { segs: group.segs.slice() }
    if (group.variants !== undefined) copy.variants = group.variants.map((v) => v.slice())
    chosen.push(copy)
  }

  const widthOf = (list: readonly ClusterGroup[]): number => spansWidth(joinGroups(list, dim))

  while (chosen.length > 0 && widthOf(chosen) > available) {
    const last = chosen[chosen.length - 1]
    if (last === undefined) break
    if (last.variants !== undefined && last.variants.length > 1) {
      last.variants.shift()
      const next = last.variants[0]
      if (next !== undefined) {
        last.segs = next.slice()
        continue
      }
    }
    if (last.segs.length > 1) {
      last.segs.pop()
      continue
    }
    chosen.pop()
  }

  if (chosen.length === 0 || widthOf(chosen) > available) return []
  return joinGroups(chosen, dim)
}

type TelemetrySeg = ClusterSeg

function telemetrySegments(telemetry: SessionTelemetry | undefined, theme: Theme): TelemetrySeg[] {
  if (telemetry === undefined) return []
  const segs: TelemetrySeg[] = []
  const breakdown = telemetry.breakdown
  const window = telemetry.contextWindow
  if (breakdown !== undefined && window !== undefined && window > 0) {
    const used = breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
    const pct = Math.round((used / window) * 100)
    let style = theme.dim
    if (pct >= 90) style = theme.error
    else if (pct >= 75) style = theme.warn
    segs.push({ text: `ctx ${pct}%`, style })
  }
  const stats = telemetry.stats
  if (stats !== undefined) {
    if (stats.decodeMs > 0) {
      const rate = Math.round((stats.decodeTokens / stats.decodeMs) * 1000)
      segs.push({ text: `${rate} tok/s`, style: theme.dim })
    }
    if (stats.ttftMs > 0) {
      segs.push({ text: `ttft ${(stats.ttftMs / 1000).toFixed(1)}s`, style: theme.dim })
    }
  }
  return segs
}

function joinTelemetry(segs: readonly TelemetrySeg[], dim: string): Span[] {
  return joinSegs(segs, dim)
}

/** Drop telemetry segments right-to-left until the cluster fits beside the host. */
function fitTelemetry(segs: readonly TelemetrySeg[], available: number, hostW: number, dim: string): Span[] {
  const chosen = segs.slice()
  while (chosen.length > 0) {
    const spans = joinTelemetry(chosen, dim)
    const telW = spansWidth(spans)
    const sep = hostW > 0 ? 2 : 0
    if (telW + sep + hostW <= available) return spans
    chosen.pop()
  }
  return []
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
