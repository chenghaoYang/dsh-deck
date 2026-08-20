import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { HostDescription } from '../src/protocol/contract.ts'
import { graphemes, stringWidth } from '../src/term/width.ts'
import type { Rect } from '../src/ui/layout.ts'
import { type RenderTarget } from '../src/ui/render.ts'
import {
  renderFooter,
  renderHeader,
  type ModeSummary,
  type SessionTelemetry,
} from '../src/ui/statusbar.ts'
import type { Glyphs, Theme } from '../src/ui/theme.ts'

const theme: Theme = {
  base: 'BASE',
  dim: 'DIM',
  subtle: 'SUBTLE',
  text: 'TEXT',
  accent: 'ACCENT',
  user: 'USER',
  assistant: 'ASSISTANT',
  reasoning: 'REASONING',
  tool: 'TOOL',
  ok: 'OK',
  warn: 'WARN',
  error: 'ERROR',
  running: 'RUNNING',
  selected: 'SELECTED',
  border: 'BORDER',
  reset: 'RESET',
}

const glyphs: Glyphs = {
  running: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  idle: '○',
  error: '✖',
  user: '▸',
  assistant: '◆',
  reasoning: '·',
  tool: '⚙',
  approve: '⚠',
  hline: '─',
  vline: '│',
  corner: { tl: '╭', tr: '╮', bl: '╰', br: '╯' },
  tee: { left: '├', right: '┤', down: '┬', up: '┴' },
  bar: '▎',
  arrow: '›',
}

const host: HostDescription = {
  version: '0.1.0',
  cwd: '/tmp/workspace',
  provider: 'deepseek',
  model: 'deepseek-chat',
  attachedSessions: 3,
  home: '/home/deck',
  canOpenPath: true,
}

const hints = [
  { key: 'a', label: 'allow' },
  { key: 'r', label: 'reject' },
  { key: '?', label: 'help' },
  { key: 'C-c', label: 'quit' },
] as const

class BoundsTarget implements RenderTarget {
  readonly puts: { row: number; col: number; text: string; style: string }[] = []
  readonly rect: Rect

  constructor(rect: Rect) {
    this.rect = rect
  }

  put(row: number, col: number, text: string, style = ''): void {
    const width = stringWidth(text)
    const { rect } = this
    if (row < rect.row || row >= rect.row + rect.height) {
      throw new Error(`put row ${row} outside ${rect.row}..${rect.row + rect.height - 1}`)
    }
    if (width === 0) {
      this.puts.push({ row, col, text, style })
      return
    }
    if (col < rect.col || col + width > rect.col + rect.width) {
      throw new Error(
        `put col ${col}+${width} outside ${rect.col}..${rect.col + rect.width - 1} (${JSON.stringify(text)})`,
      )
    }
    this.puts.push({ row, col, text, style })
  }

  fill(row: number, col: number, width: number, height: number, _char = ' ', _style = ''): void {
    if (width === 0 || height === 0) return
    const { rect } = this
    if (width < 0 || height < 0) throw new Error('fill negative size')
    if (row < rect.row || row + height > rect.row + rect.height) {
      throw new Error(`fill row ${row}+${height} outside ${rect.row}..${rect.row + rect.height - 1}`)
    }
    if (col < rect.col || col + width > rect.col + rect.width) {
      throw new Error(`fill col ${col}+${width} outside ${rect.col}..${rect.col + rect.width - 1}`)
    }
  }

  plain(): string {
    return this.puts.map((p) => p.text).join('')
  }

  paintedWidth(): number {
    return stringWidth(this.plain())
  }
}

function telemetry(pctParts: {
  contextWindow?: number
  systemTokens?: number
  toolsTokens?: number
  messageTokens?: number
  decodeMs?: number
  decodeTokens?: number
  ttftMs?: number
}): SessionTelemetry {
  const row: SessionTelemetry = {}
  if (pctParts.contextWindow !== undefined) row.contextWindow = pctParts.contextWindow
  if (
    pctParts.systemTokens !== undefined ||
    pctParts.toolsTokens !== undefined ||
    pctParts.messageTokens !== undefined
  ) {
    row.breakdown = {
      systemTokens: pctParts.systemTokens ?? 0,
      toolsTokens: pctParts.toolsTokens ?? 0,
      messageTokens: pctParts.messageTokens ?? 0,
    }
  }
  if (
    pctParts.decodeMs !== undefined ||
    pctParts.decodeTokens !== undefined ||
    pctParts.ttftMs !== undefined
  ) {
    row.stats = {
      turns: 1,
      steps: 1,
      llmMs: 1,
      toolMs: 1,
      ttftMs: pctParts.ttftMs ?? 0,
      ttftSteps: 1,
      decodeMs: pctParts.decodeMs ?? 0,
      decodeTokens: pctParts.decodeTokens ?? 0,
    }
  }
  return row
}

const sampleTel = telemetry({
  contextWindow: 1000,
  systemTokens: 80,
  toolsTokens: 20,
  messageTokens: 20,
  decodeMs: 1000,
  decodeTokens: 45,
  ttftMs: 1000,
})

const sessionModes: ModeSummary = {
  provider: 'nvidia',
  model: 'thinkingmachines/inkling',
  effort: 'high',
  permission: 'danger-full-access',
  preset: '标准模式',
  plan: { active: true, pending: false },
}

function paintHeader(
  width: number,
  extra: {
    title?: string
    project?: string
    host?: HostDescription
    telemetry?: SessionTelemetry
    modes?: ModeSummary
    connection?: 'connecting' | 'ready' | 'reconnecting' | 'closed'
  } = {},
): BoundsTarget {
  const rect: Rect = { row: 1, col: 1, width, height: 1 }
  const target = new BoundsTarget(rect)
  renderHeader(target, {
    rect,
    host: extra.host,
    connection: extra.connection ?? 'ready',
    sessionTitle: extra.title,
    ...(extra.project !== undefined ? { project: extra.project } : {}),
    theme,
    glyphs,
    ...(extra.telemetry !== undefined ? { telemetry: extra.telemetry } : { telemetry: sampleTel }),
    ...(extra.modes !== undefined ? { modes: extra.modes } : {}),
  })
  return target
}

function paintFooter(
  width: number,
  extra: { message?: { text: string; kind: 'info' | 'warn' | 'error' } } = {},
): BoundsTarget {
  const rect: Rect = { row: 10, col: 1, width, height: 1 }
  const target = new BoundsTarget(rect)
  renderFooter(target, {
    rect,
    hints,
    message: extra.message,
    theme,
  })
  return target
}

describe('renderHeader without modes', () => {
  it('survives a host description without provider or model on the first frame', () => {
    const { provider: _provider, model: _model, ...hostWithoutModel } = host
    const target = paintHeader(80, {
      title: 'starting',
      host: hostWithoutModel,
      telemetry: {},
    })
    assert.doesNotThrow(() => target.plain())
    assert.doesNotMatch(target.plain(), /undefined/)
    assert.match(target.plain(), /starting/)
  })

  it('shows the current project separately from the session title', () => {
    const target = paintHeader(120, {
      project: 'data-agent-nl2sql',
      title: '你好',
      telemetry: {},
    })
    assert.match(target.plain(), /data-agent-nl2sql \/ 你好/)
  })

  it('renders the captured 80-col header byte-for-byte', () => {
    const target = paintHeader(80, { title: 'ok', host })
    assert.deepEqual(target.puts, [
      { row: 1, col: 1, text: 'deck', style: 'ACCENT' },
      { row: 1, col: 5, text: '  ', style: '' },
      { row: 1, col: 7, text: '●', style: 'OK' },
      { row: 1, col: 8, text: ' ', style: '' },
      { row: 1, col: 9, text: 'ready', style: 'OK' },
      { row: 1, col: 14, text: '  ', style: '' },
      { row: 1, col: 16, text: 'ok', style: 'TEXT' },
      { row: 1, col: 18, text: '       ', style: '' },
      { row: 1, col: 25, text: 'ctx 12%', style: 'DIM' },
      { row: 1, col: 32, text: ' · ', style: 'DIM' },
      { row: 1, col: 35, text: '45 tok/s', style: 'DIM' },
      { row: 1, col: 43, text: ' · ', style: 'DIM' },
      { row: 1, col: 46, text: 'ttft 1.0s', style: 'DIM' },
      { row: 1, col: 55, text: '  ', style: '' },
      { row: 1, col: 57, text: 'deepseek · deepseek-chat', style: 'SUBTLE' },
    ])
  })

  it('renders the captured 40-col header byte-for-byte', () => {
    const target = paintHeader(40, { title: 'ok', host })
    assert.deepEqual(target.puts, [
      { row: 1, col: 1, text: 'deck', style: 'ACCENT' },
      { row: 1, col: 5, text: '  ', style: '' },
      { row: 1, col: 7, text: '●', style: 'OK' },
      { row: 1, col: 8, text: '  ', style: '' },
      { row: 1, col: 10, text: 'ok', style: 'TEXT' },
      { row: 1, col: 12, text: '     ', style: '' },
      { row: 1, col: 17, text: 'deepseek · deepseek-chat', style: 'SUBTLE' },
    ])
  })
})

describe('renderHeader safety chips', () => {
  it('styles danger-full-access as an error chip', () => {
    const target = paintHeader(80, {
      title: 'ok',
      host,
      modes: { permission: 'danger-full-access' },
    })
    const chip = target.puts.find((p) => p.text === 'full-access')
    assert.ok(chip, `expected full-access chip in ${JSON.stringify(target.puts)}`)
    assert.equal(chip.style, theme.error)
    assert.match(target.plain(), /full-access/)
    assert.doesNotMatch(target.plain(), /danger-full-access/)
  })

  it('styles read-only as a warn chip', () => {
    const target = paintHeader(80, {
      title: 'ok',
      host,
      modes: { permission: 'read-only' },
    })
    const chip = target.puts.find((p) => p.text === 'read-only')
    assert.ok(chip, `expected read-only chip in ${JSON.stringify(target.puts)}`)
    assert.equal(chip.style, theme.warn)
  })

  it('omits a workspace-write permission chip', () => {
    const target = paintHeader(80, {
      title: 'ok',
      host,
      modes: { permission: 'workspace-write', model: 'inkling', provider: 'nvidia' },
    })
    const plain = target.plain()
    assert.doesNotMatch(plain, /workspace-write/)
    assert.doesNotMatch(plain, /full-access/)
    assert.doesNotMatch(plain, /read-only/)
    assert.ok(!target.puts.some((p) => p.style === theme.error && p.text.includes('access')))
    assert.match(plain, /nvidia/)
  })
})

describe('renderHeader plan chips', () => {
  it('renders active plan as an accent chip and pending as a distinct warn chip', () => {
    const active = paintHeader(80, {
      title: 'ok',
      host,
      modes: { plan: { active: true, pending: false } },
    })
    const plan = active.puts.find((p) => p.text === 'plan')
    assert.ok(plan, `expected plan chip in ${JSON.stringify(active.puts)}`)
    assert.equal(plan.style, theme.accent)
    assert.ok(!active.puts.some((p) => p.text === 'plan?'))

    const pending = paintHeader(80, {
      title: 'ok',
      host,
      modes: { plan: { active: false, pending: true } },
    })
    const queued = pending.puts.find((p) => p.text === 'plan?')
    assert.ok(queued, `expected plan? chip in ${JSON.stringify(pending.puts)}`)
    assert.equal(queued.style, theme.warn)
    assert.ok(!pending.puts.some((p) => p.text === 'plan'))

    const both = paintHeader(80, {
      title: 'ok',
      host,
      modes: { plan: { active: true, pending: true } },
    })
    assert.ok(both.puts.some((p) => p.text === 'plan' && p.style === theme.accent))
    assert.ok(!both.puts.some((p) => p.text === 'plan?'))
  })
})

describe('renderHeader model label', () => {
  it('prefers modes.provider/model over the host default', () => {
    const target = paintHeader(80, {
      title: 'ok',
      host,
      modes: { provider: 'nvidia', model: 'thinkingmachines/inkling' },
    })
    const plain = target.plain()
    assert.match(plain, /nvidia/)
    assert.match(plain, /thinkingmachines\/inkling|inkling/)
    assert.doesNotMatch(plain, /deepseek-chat/)
    assert.doesNotMatch(plain, /deepseek ·/)
  })

  it('shortens thinkingmachines/inkling to inkling under width pressure', () => {
    const wide = paintHeader(80, {
      title: 'ok',
      host,
      modes: { provider: 'nvidia', model: 'thinkingmachines/inkling' },
    })
    assert.match(wide.plain(), /thinkingmachines\/inkling/)

    const tight = paintHeader(40, {
      title: 'ok',
      host,
      modes: {
        provider: 'nvidia',
        model: 'thinkingmachines/inkling',
        permission: 'danger-full-access',
        plan: { active: true, pending: false },
      },
    })
    const tightPlain = tight.plain()
    assert.match(tightPlain, /inkling/)
    assert.doesNotMatch(tightPlain, /thinkingmachines/)
    assert.ok(tight.paintedWidth() <= 40)
  })

  it('appends effort when there is room and drops it when there is not', () => {
    const roomy = paintHeader(80, {
      title: 'ok',
      host,
      modes: { provider: 'nvidia', model: 'thinkingmachines/inkling', effort: 'high' },
    })
    assert.match(roomy.plain(), / · high/)

    const squeezed = paintHeader(40, {
      title: 'ok',
      host,
      modes: {
        provider: 'nvidia',
        model: 'thinkingmachines/inkling',
        effort: 'high',
        permission: 'danger-full-access',
        plan: { active: true, pending: false },
      },
    })
    assert.doesNotMatch(squeezed.plain(), /high/)
    assert.match(squeezed.plain(), /inkling/)
    assert.ok(squeezed.paintedWidth() <= 40)
  })

  /**
   * Regression from live verification: at 100 columns with a long title and two
   * safety chips the header kept `thinkingmachines/inkling` and dropped `high`,
   * spending columns on a vendor prefix that only repeats the provider route
   * while discarding state the user had just chosen on purpose.
   */
  it('gives up the vendor prefix before the reasoning effort', () => {
    const painted = paintHeader(100, {
      title: 'Reply with exactly this and nothing else: deck-verify-ok',
      host,
      modes: {
        provider: 'nvidia',
        model: 'thinkingmachines/inkling',
        effort: 'high',
        permission: 'read-only',
        plan: { active: true, pending: false },
      },
    })
    const plain = painted.plain()
    assert.match(plain, /high/, 'the chosen effort must survive')
    assert.match(plain, /inkling/)
    assert.doesNotMatch(plain, /thinkingmachines/, 'the vendor prefix goes first')
    assert.ok(painted.paintedWidth() <= 100)
  })

  it('keeps the full model id when nothing is competing for the room', () => {
    const painted = paintHeader(120, {
      title: 'ok',
      host,
      modes: { provider: 'nvidia', model: 'thinkingmachines/inkling', effort: 'high' },
    })
    assert.match(painted.plain(), /thinkingmachines\/inkling · high/)
  })
})

describe('renderHeader CJK and narrow widths', () => {
  it('never overflows the rect when showing a CJK preset name', () => {
    const wide = paintHeader(120, {
      title: 'ok',
      host,
      telemetry: {},
      modes: {
        provider: 'nvidia',
        model: 'inkling',
        preset: '标准模式',
      },
    })
    assert.match(wide.plain(), /标准模式/)
    assert.equal(stringWidth('标准模式'), 8)
    assert.ok(wide.paintedWidth() <= 120)

    const tight = paintHeader(40, {
      title: '中文会话',
      host,
      modes: { ...sessionModes },
    })
    assert.ok(tight.paintedWidth() <= 40)
    const presetSpan = tight.puts.find((p) => p.text.includes('标') || p.text.includes('模式'))
    if (presetSpan !== undefined) {
      assert.ok(stringWidth(presetSpan.text) <= 40)
    }
  })

  it('renders at 40, 44, 52, 60, 80, and 120 columns without overflow or throwing', () => {
    for (const width of [40, 44, 52, 60, 80, 120] as const) {
      assert.doesNotThrow(() => {
        const withModes = paintHeader(width, {
          title: '中文会话 title that is deliberately long',
          host,
          modes: sessionModes,
        })
        assert.ok(
          withModes.paintedWidth() <= width,
          `${width}-col modes header painted ${withModes.paintedWidth()}`,
        )

        const noModes = paintHeader(width, { title: 'ok', host })
        assert.ok(
          noModes.paintedWidth() <= width,
          `${width}-col no-modes header painted ${noModes.paintedWidth()}`,
        )
      }, `width ${width}`)
    }
  })
})

const chromeTexts = new Set(['deck', '●', '*', 'ready', 'connecting', 'reconnecting', 'closed'])

function columnChars(target: BoundsTarget): string[] {
  const cols = Array.from({ length: target.rect.width }, () => ' ')
  for (const put of target.puts) {
    let x = put.col - target.rect.col
    for (const g of graphemes(put.text)) {
      const w = stringWidth(g)
      if (w <= 0) continue
      if (x >= 0 && x < cols.length) cols[x] = g
      x += w
    }
  }
  return cols
}

function firstClusterPut(
  target: BoundsTarget,
): { row: number; col: number; text: string; style: string } | undefined {
  for (const put of target.puts) {
    if (put.text.trim() === '') continue
    if (put.style === theme.text) continue
    if (chromeTexts.has(put.text)) continue
    return put
  }
  return undefined
}

function assertTitleClusterGap(target: BoundsTarget, minGap = 2): void {
  assert.ok(target.paintedWidth() <= target.rect.width, `painted ${target.paintedWidth()} > ${target.rect.width}`)
  const title = target.puts.find((p) => p.style === theme.text)
  const cluster = firstClusterPut(target)
  if (title === undefined || cluster === undefined) return
  const cols = columnChars(target)
  const clusterAt = cluster.col - target.rect.col
  for (let i = 1; i <= minGap; i++) {
    const cell = cols[clusterAt - i]
    assert.equal(
      cell,
      ' ',
      `expected ${minGap}-col gap before ${JSON.stringify(cluster.text)} at col ${cluster.col}; cell -${i} is ${JSON.stringify(cell)} in ${JSON.stringify(target.plain())}`,
    )
  }
}

describe('renderHeader title / cluster gap', () => {
  const longTitle =
    'List the files in the current directory using a tool, then tell me how many there are.'
  const liveModes: ModeSummary = {
    permission: 'read-only',
    provider: 'nvidia',
    model: 'thinkingmachines/inkling',
  }
  const liveTel = telemetry({
    contextWindow: 1000,
    systemTokens: 40,
    toolsTokens: 0,
    messageTokens: 0,
    decodeMs: 1000,
    decodeTokens: 40,
  })

  it('keeps two blank columns between a maxed title and the read-only chip', () => {
    const target = paintHeader(100, {
      title: longTitle,
      host,
      modes: liveModes,
      telemetry: liveTel,
    })
    const chip = target.puts.find((p) => p.text === 'read-only')
    assert.ok(chip, `expected read-only chip in ${JSON.stringify(target.puts)}`)
    const cols = columnChars(target)
    const chipAt = chip.col - target.rect.col
    assert.equal(cols[chipAt], 'r')
    assert.equal(cols[chipAt - 1], ' ', `cell before chip is ${JSON.stringify(cols[chipAt - 1])}`)
    assert.equal(cols[chipAt - 2], ' ', `two cells before chip is ${JSON.stringify(cols[chipAt - 2])}`)
    assert.ok(target.paintedWidth() <= 100)
  })

  it('keeps the gap when the title is exactly the budget or one column short', () => {
    const probe = paintHeader(100, {
      title: 'T'.repeat(200),
      host,
      modes: liveModes,
      telemetry: liveTel,
    })
    const titlePut = probe.puts.find((p) => p.style === theme.text)
    assert.ok(titlePut, 'expected a truncated title on the probe paint')
    const budget = stringWidth(titlePut.text)
    assert.ok(budget > 1, `budget was ${budget}`)

    for (const len of [budget, budget - 1]) {
      const target = paintHeader(100, {
        title: 'T'.repeat(len),
        host,
        modes: liveModes,
        telemetry: liveTel,
      })
      const paintedTitle = target.puts.find((p) => p.style === theme.text)
      assert.ok(paintedTitle, `expected title of length ${len}`)
      assert.equal(stringWidth(paintedTitle.text), len)
      assertTitleClusterGap(target, 2)
      const cluster = firstClusterPut(target)
      assert.ok(cluster, `expected a right-hand cluster at title length ${len}`)
      const end = cluster.col + stringWidth(cluster.text)
      const last = target.puts[target.puts.length - 1]
      assert.ok(last)
      assert.equal(
        last.col + stringWidth(last.text),
        target.rect.col + target.rect.width,
        `cluster should right-align at title length ${len}: ${JSON.stringify(target.plain())}`,
      )
      assert.ok(end <= target.rect.col + target.rect.width)
    }
  })

  it('never lets a title run into the cluster across widths and title lengths', () => {
    const cjkTitle = '迁移数据库到 Postgres 并保留现有数据'
    const titles: string[] = ['']
    for (let n = 1; n <= 140; n++) titles.push('x'.repeat(n))
    titles.push(longTitle, cjkTitle, `${cjkTitle} ${longTitle}`)

    for (const width of [40, 44, 52, 60, 72, 80, 100, 120] as const) {
      for (const title of titles) {
        const target = paintHeader(width, {
          title,
          host,
          modes: liveModes,
          telemetry: liveTel,
        })
        assert.ok(
          target.paintedWidth() <= width,
          `${width}-col title ${JSON.stringify(title.slice(0, 24))} painted ${target.paintedWidth()}`,
        )
        if (title.length > 0) assertTitleClusterGap(target, 2)
        else {
          const cluster = firstClusterPut(target)
          if (cluster !== undefined) {
            const cols = columnChars(target)
            const at = cluster.col - target.rect.col
            assert.equal(cols[at - 1], ' ', `empty title still needs a space before ${cluster.text}`)
          }
        }
      }
    }
  })

  it('keeps the gap for a CJK title that lands on a wide-character boundary', () => {
    const target = paintHeader(80, {
      title: '迁移数据库到 Postgres 并保留现有数据',
      host,
      modes: liveModes,
      telemetry: liveTel,
    })
    const titlePut = target.puts.find((p) => p.style === theme.text)
    assert.ok(titlePut, 'expected a CJK title span')
    assertTitleClusterGap(target, 2)
    assert.ok(target.paintedWidth() <= 80)
  })
})

describe('renderFooter regression', () => {
  it('still paints the hint row and warn messages as before', () => {
    const hintsRow = paintFooter(80)
    assert.deepEqual(hintsRow.puts, [
      { row: 10, col: 1, text: 'a', style: 'ACCENT' },
      { row: 10, col: 2, text: ' ', style: '' },
      { row: 10, col: 3, text: 'allow', style: 'DIM' },
      { row: 10, col: 8, text: '  ', style: '' },
      { row: 10, col: 10, text: 'r', style: 'ACCENT' },
      { row: 10, col: 11, text: ' ', style: '' },
      { row: 10, col: 12, text: 'reject', style: 'DIM' },
      { row: 10, col: 18, text: '  ', style: '' },
      { row: 10, col: 20, text: '?', style: 'ACCENT' },
      { row: 10, col: 21, text: ' ', style: '' },
      { row: 10, col: 22, text: 'help', style: 'DIM' },
      { row: 10, col: 26, text: '  ', style: '' },
      { row: 10, col: 28, text: 'C-c', style: 'ACCENT' },
      { row: 10, col: 31, text: ' ', style: '' },
      { row: 10, col: 32, text: 'quit', style: 'DIM' },
    ])

    const message = paintFooter(80, { message: { text: 'waiting for approval', kind: 'warn' } })
    assert.deepEqual(message.puts, [{ row: 10, col: 1, text: 'waiting for approval', style: 'WARN' }])
  })
})
