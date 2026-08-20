import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { TranscriptItem, TranscriptState, ToolCallEntry } from '../src/model/fold.ts'
import type { PendingApproval, SessionState } from '../src/model/store.ts'
import type { HostDescription, QueuedInboxItem, TokenUsage } from '../src/protocol/contract.ts'
import { computeLayout, type Rect } from '../src/ui/layout.ts'
import { lineText, type RenderTarget } from '../src/ui/render.ts'
import { renderComposer } from '../src/ui/composer.ts'
import { renderHelp } from '../src/ui/help.ts'
import { renderSidebar } from '../src/ui/sidebar.ts'
import { renderFooter, renderHeader, type SessionTelemetry } from '../src/ui/statusbar.ts'
import type { Glyphs, Theme } from '../src/ui/theme.ts'
import { layoutTranscript, renderTranscript } from '../src/ui/transcript.ts'
import { stringWidth } from '../src/term/width.ts'

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

const bindings = [
  { keys: 'a', label: 'allow this tool' },
  { keys: 'r', label: 'reject this tool' },
  { keys: 'tab', label: 'next session' },
  { keys: '?', label: 'toggle this panel' },
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
}

function emptyTranscript(): TranscriptState {
  return { items: [], lastSeq: 0, phase: 'idle', usage: {} }
}

function session(id: string, extra: {
  title?: string
  cwd?: string
  running?: boolean
  origin?: 'subagent'
  parentSessionId?: string
  pendingApprovals?: PendingApproval[]
  pendingApproval?: PendingApproval
  unread?: number
  lastError?: string
} = {}): SessionState {
  const row: SessionState = {
    id,
    running: extra.running ?? false,
    blank: false,
    updatedAt: 1,
    transcript: emptyTranscript(),
    historyLoaded: true,
    hasMoreHistory: false,
    queue: [],
    unread: extra.unread ?? 0,
    telemetry: {},
    modes: {},
  }
  if (extra.title !== undefined) row.title = extra.title
  if (extra.cwd !== undefined) row.cwd = extra.cwd
  if (extra.origin !== undefined) row.origin = extra.origin
  if (extra.parentSessionId !== undefined) row.parentSessionId = extra.parentSessionId
  if (extra.pendingApprovals !== undefined) row.pendingApprovals = extra.pendingApprovals
  if (extra.pendingApproval !== undefined) row.pendingApproval = extra.pendingApproval
  if (extra.lastError !== undefined) row.lastError = extra.lastError
  return row
}

function approval(toolName: string): PendingApproval {
  return { rpcId: 'rpc-1', approvalId: 'apr-1', toolName, at: 1 }
}

function toolCall(status: ToolCallEntry['status'], extra: Partial<ToolCallEntry> = {}): ToolCallEntry {
  const call: ToolCallEntry = {
    callId: extra.callId ?? 'call-1',
    name: extra.name ?? 'bash',
    argumentsRaw: extra.argumentsRaw ?? '{"command":"ls -la"}',
    status,
  }
  if (extra.args !== undefined) call.args = extra.args
  if (extra.resultText !== undefined) call.resultText = extra.resultText
  if (extra.isError !== undefined) call.isError = extra.isError
  if (extra.startedAt !== undefined) call.startedAt = extra.startedAt
  if (extra.endedAt !== undefined) call.endedAt = extra.endedAt
  return call
}

/** Inline fixture matching fold.ts image items. */
function imageItem(extra: { mediaType?: string; alt?: string } = {}): TranscriptItem {
  const item: Extract<TranscriptItem, { kind: 'image' }> = {
    kind: 'image',
    seq: 8,
    turn: 1,
    step: 3,
    alt: extra.alt ?? 'screenshot',
  }
  if (extra.mediaType !== undefined) item.mediaType = extra.mediaType
  return item
}

/** Inline fixture matching fold.ts turn-end elapsed/usage fields. */
function turnEndItem(extra: {
  reason?: string
  elapsedMs?: number
  usage?: TokenUsage
} = {}): TranscriptItem {
  const item: Extract<TranscriptItem, { kind: 'turn-end' }> = {
    kind: 'turn-end',
    seq: 9,
    turn: 1,
    reason: extra.reason ?? 'completed',
  }
  if (extra.elapsedMs !== undefined) item.elapsedMs = extra.elapsedMs
  if (extra.usage !== undefined) item.usage = extra.usage
  return item
}

function queuedItem(content: QueuedInboxItem['message']['content'], id = 'q1'): QueuedInboxItem {
  return { id, placement: 'queued', message: { role: 'user', content } }
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

function sampleItems(): TranscriptItem[] {
  return [
    { kind: 'user', seq: 1, time: 0, text: '请解释这段中文以及 a long Latin clause that must wrap on a forty-column pane.' },
    {
      kind: 'reasoning',
      seq: 2,
      turn: 1,
      step: 0,
      text: ['one', 'two', 'three', 'four', 'five'].join('\n'),
      streaming: false,
    },
    {
      kind: 'assistant',
      seq: 3,
      turn: 1,
      step: 1,
      text: 'Here is an answer with a fence:\n```\nconst n = 1\n```\nDone.',
      streaming: false,
    },
    {
      kind: 'tool',
      seq: 4,
      turn: 1,
      step: 2,
      call: toolCall('awaiting-approval', { args: { command: 'rm -rf build' } }),
    },
    { kind: 'error', seq: 5, text: 'host closed the mux socket' },
    { kind: 'notice', seq: 6, text: 'replaying history' },
    { kind: 'turn-end', seq: 7, turn: 1, reason: 'stop' },
    imageItem({ mediaType: 'image/png' }),
  ]
}

function sampleSessions(): SessionState[] {
  return [
    session('s1', { title: 'focused worker', running: true, unread: 0 }),
    session('s2', {
      title: '中文后台任务',
      pendingApproval: approval('bash'),
      unread: 4,
    }),
    session('s3', {
      title: 'child',
      origin: 'subagent',
      parentSessionId: 's1',
      cwd: '/tmp/child',
    }),
    session('s4', { lastError: 'boom', cwd: '/very/long/path/to/a/project' }),
  ]
}

function paintAll(rectFor: (kind: string, layout: ReturnType<typeof computeLayout>) => Rect, columns: number, rows: number): void {
  const layout = computeLayout(columns, rows, { composerHeight: Math.min(3, Math.max(1, rows - 6)) })
  const lines = layoutTranscript(sampleItems(), {
    width: layout.transcript.width,
    theme,
    glyphs,
    spinnerFrame: 3,
    expandTools: false,
    queue: [
      queuedItem('queued latin that should stay on one dim tail line'),
      queuedItem('中文队列'.repeat(20), 'q2'),
    ],
    retrying: { count: 2, reason: 'RATE_LIMIT' },
  })

  const header = new BoundsTarget(rectFor('header', layout))
  renderHeader(header, {
    rect: header.rect,
    host,
    connection: 'ready',
    sessionTitle: '中文会话 title that is deliberately long',
    theme,
    glyphs,
    telemetry: telemetry({
      contextWindow: 16_000,
      systemTokens: 1592,
      toolsTokens: 6409,
      messageTokens: 1945,
      decodeMs: 400,
      decodeTokens: 18,
      ttftMs: 1000,
    }),
  })

  const footer = new BoundsTarget(rectFor('footer', layout))
  renderFooter(footer, { rect: footer.rect, hints, message: undefined, theme })
  renderFooter(footer, {
    rect: footer.rect,
    hints,
    message: { text: 'waiting for approval on a background session', kind: 'warn' },
    theme,
  })

  const sidebarRect = layout.sidebar ?? { row: layout.transcript.row, col: 1, width: Math.min(18, columns), height: layout.transcript.height }
  const sidebar = new BoundsTarget(rectFor('sidebar', { ...layout, sidebar: sidebarRect }))
  renderSidebar(sidebar, {
    rect: sidebar.rect,
    sessions: sampleSessions(),
    focusedId: 's1',
    theme,
    glyphs,
    spinnerFrame: 2,
  })

  const transcript = new BoundsTarget(rectFor('transcript', layout))
  renderTranscript(transcript, {
    rect: transcript.rect,
    lines,
    scrollOffset: 0,
    theme,
  })
  renderTranscript(transcript, {
    rect: transcript.rect,
    lines,
    scrollOffset: 20,
    theme,
  })

  const composer = new BoundsTarget(rectFor('composer', layout))
  renderComposer(composer, {
    rect: composer.rect,
    draft: '中文输入 plus a wrapped paragraph that should keep the caret on screen when the draft is taller than the composer.',
    cursor: 2,
    mode: 'queue',
    busy: false,
    theme,
    glyphs,
  })
  renderComposer(composer, {
    rect: composer.rect,
    draft: 'steer me\n'.repeat(12),
    cursor: 40,
    mode: 'steer',
    busy: true,
    theme,
    glyphs,
  })

  const help = new BoundsTarget(rectFor('help', layout))
  renderHelp(help, help.rect, theme, bindings)
}

describe('widget bounds', () => {
  for (const [columns, rows] of [
    [40, 10],
    [200, 60],
  ] as const) {
    it(`never writes outside its rect on a ${columns}x${rows} viewport`, () => {
      assert.doesNotThrow(() => {
        paintAll((_kind, layout) => {
          if (_kind === 'header') return layout.header
          if (_kind === 'footer') return layout.footer
          if (_kind === 'sidebar') {
            return layout.sidebar ?? { row: layout.transcript.row, col: 1, width: Math.min(18, columns), height: layout.transcript.height }
          }
          if (_kind === 'transcript') return layout.transcript
          if (_kind === 'composer') return layout.composer
          return layout.transcript
        }, columns, rows)
      })
    })
  }
})

describe('single-session wide layout', () => {
  it('centers a readable 120-column surface in a 185-column Ghostty window', () => {
    const layout = computeLayout(185, 46, { sidebarHidden: true })
    assert.equal(layout.sidebar, undefined)
    for (const rect of [layout.header, layout.transcript, layout.composer, layout.footer]) {
      assert.equal(rect.col, 33)
      assert.equal(rect.width, 120)
    }
  })

  it('keeps the multi-session cockpit sidebar and full main pane', () => {
    const layout = computeLayout(185, 46)
    assert.equal(layout.sidebar?.width, 34)
    assert.equal(layout.transcript.col, 37)
    assert.equal(layout.transcript.width, 149)
  })
})

describe('layoutTranscript', () => {
  it('never exceeds width and never splits a wide character, including CJK', () => {
    const width = 21
    const text = '中文测试汉字宽度'.repeat(12)
    const lines = layoutTranscript([{ kind: 'user', seq: 1, time: 0, text }], {
      width,
      theme,
      glyphs,
      spinnerFrame: 0,
      expandTools: false,
    })
    assert.ok(lines.length > 1)
    const recovered: string[] = []
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
    for (const line of lines) {
      const plain = lineText(line)
      assert.ok(stringWidth(plain) <= width, `"${plain}" is ${stringWidth(plain)} cols`)
      for (const { segment } of segmenter.segment(plain)) {
        const w = stringWidth(segment)
        assert.ok(w <= 2)
        assert.ok(w !== 1 || !/[\u4e00-\u9fff]/.test(segment), 'CJK cluster must stay 2 columns')
        if (/[\u4e00-\u9fff]/.test(segment)) recovered.push(segment)
      }
    }
    assert.deepEqual(recovered, [...text])
  })

  it('collapses streaming reasoning longer than 3 lines to 3', () => {
    const text = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].join('\n')
    const lines = layoutTranscript(
      [{ kind: 'reasoning', seq: 1, turn: 1, step: 0, text, streaming: true }],
      { width: 40, theme, glyphs, spinnerFrame: 1, expandTools: false },
    )
    assert.equal(lines.length, 3)
    const plain = lines.map(lineText).join('\n')
    assert.match(plain, /delta/)
    assert.match(plain, /foxtrot/)
    assert.doesNotMatch(plain, /alpha/)
  })

  it('collapses finished reasoning to one summary line', () => {
    const text = ['alpha', 'bravo', 'charlie', 'delta'].join('\n')
    const lines = layoutTranscript(
      [{ kind: 'reasoning', seq: 1, turn: 1, step: 0, text, streaming: false }],
      { width: 40, theme, glyphs, spinnerFrame: 0, expandTools: false },
    )
    assert.equal(lines.length, 1)
    const first = lines[0]
    assert.ok(first)
    assert.match(lineText(first), /thought for \d+ lines/)
  })

  it('renders allow/reject affordances for a tool awaiting approval', () => {
    const lines = layoutTranscript(
      [
        {
          kind: 'tool',
          seq: 1,
          turn: 1,
          step: 0,
          call: toolCall('awaiting-approval', {
            name: 'bash',
            args: { command: 'rm -rf build' },
            argumentsRaw: '{"command":"rm -rf build"}',
          }),
        },
      ],
      { width: 40, theme, glyphs, spinnerFrame: 0, expandTools: false },
    )
    const plain = lines.map(lineText).join('\n')
    assert.match(plain, /\[a\] allow/)
    assert.match(plain, /\[r\] reject/)
    assert.match(plain, /bash/)
  })

  it('renders an image item as a compact card', () => {
    const lines = layoutTranscript([imageItem({ mediaType: 'image/png', alt: 'plot' })], {
      width: 40,
      theme,
      glyphs,
      spinnerFrame: 0,
      expandTools: false,
    })
    assert.equal(lines.length, 1)
    const first = lines[0]
    assert.ok(first)
    const plain = lineText(first)
    assert.match(plain, /▣/)
    assert.match(plain, /image \(png\)/)
    assert.match(plain, /ctrl\+o to view/)
    assert.ok(stringWidth(plain) <= 40)
  })

  it('turn-end includes elapsed and humanized usage when present', () => {
    const rich = layoutTranscript(
      [turnEndItem({ reason: 'completed', elapsedMs: 12_400, usage: { inputTokens: 1234, outputTokens: 458 } })],
      { width: 48, theme, glyphs, spinnerFrame: 0, expandTools: false },
    )
    const richPlain = rich.map(lineText).join('\n')
    assert.match(richPlain, /completed/)
    assert.match(richPlain, /12\.4s/)
    assert.match(richPlain, /↑1\.2k/)
    assert.match(richPlain, /↓458/)
    assert.match(richPlain, /tok/)
    for (const line of rich) assert.ok(stringWidth(lineText(line)) <= 48)

    const plain = layoutTranscript([{ kind: 'turn-end', seq: 1, turn: 1, reason: 'stop' }], {
      width: 40,
      theme,
      glyphs,
      spinnerFrame: 0,
      expandTools: false,
    })
    const plainText = plain.map(lineText).join('\n')
    assert.match(plainText, /stop/)
    assert.doesNotMatch(plainText, /tok/)
    assert.doesNotMatch(plainText, /↑/)
  })

  it('queued tail lines render dim and truncate CJK without splitting', () => {
    const width = 22
    const cjk = '中文测试汉字宽度还要更长'
    const lines = layoutTranscript([{ kind: 'user', seq: 1, time: 0, text: 'hi' }], {
      width,
      theme,
      glyphs,
      spinnerFrame: 0,
      expandTools: false,
      queue: [
        queuedItem('first line\nignored'),
        queuedItem([{ type: 'text', text: cjk }]),
      ],
    })
    const queued = lines.filter((line) => lineText(line).includes('(queued)'))
    assert.equal(queued.length, 2)
    assert.match(lineText(queued[0]!), /first line/)
    assert.doesNotMatch(lineText(queued[0]!), /ignored/)
    for (const line of queued) {
      const plain = lineText(line)
      assert.ok(stringWidth(plain) <= width, `"${plain}" is ${stringWidth(plain)} cols`)
      for (const span of line.spans) assert.equal(span.style, theme.dim)
    }
    const cjkLine = lineText(queued[1]!)
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
    const recovered: string[] = []
    for (const { segment } of segmenter.segment(cjkLine)) {
      if (/[\u4e00-\u9fff]/.test(segment)) {
        assert.equal(stringWidth(segment), 2)
        recovered.push(segment)
      }
    }
    assert.ok(recovered.length > 0)
    assert.equal(cjk.slice(0, recovered.length), recovered.join(''))
    assert.ok(cjkLine.includes('…') || recovered.join('').length < cjk.length)
  })

  it('retrying line is last and warn-colored', () => {
    const lines = layoutTranscript(
      [
        { kind: 'user', seq: 1, time: 0, text: 'go' },
        { kind: 'turn-end', seq: 2, turn: 1, reason: 'stop' },
      ],
      {
        width: 40,
        theme,
        glyphs,
        spinnerFrame: 0,
        expandTools: false,
        queue: [queuedItem('still waiting')],
        retrying: { count: 2, reason: 'RATE_LIMIT' },
      },
    )
    const last = lines[lines.length - 1]
    assert.ok(last)
    const plain = lineText(last)
    assert.match(plain, /retrying \(2\)/)
    assert.match(plain, /RATE_LIMIT/)
    assert.match(plain, /⠋/)
    assert.ok(last.spans.every((span) => span.style === theme.warn))
    const queuedAt = lines.findIndex((line) => lineText(line).includes('(queued)'))
    assert.ok(queuedAt >= 0)
    assert.ok(queuedAt < lines.length - 1)
  })
})

describe('sidebar', () => {
  it('shows the approval glyph in the warn color for a non-focused pending session', () => {
    const rect: Rect = { row: 2, col: 1, width: 24, height: 6 }
    const target = new BoundsTarget(rect)
    renderSidebar(target, {
      rect,
      sessions: sampleSessions(),
      focusedId: 's1',
      theme,
      glyphs,
      spinnerFrame: 0,
    })
    const warn = target.puts.filter((p) => p.style === theme.warn)
    assert.ok(
      warn.some((p) => p.text.includes(glyphs.approve)),
      `expected ${glyphs.approve} in warn puts, got ${JSON.stringify(target.puts)}`,
    )
    assert.ok(target.plain().includes('中文后台任务') || target.plain().includes('中文'))
  })

  it('shows the number of queued approvals beside the session', () => {
    const first = approval('bash')
    const second = { ...approval('editor'), rpcId: 'rpc-2', approvalId: 'apr-2' }
    const rect: Rect = { row: 2, col: 1, width: 32, height: 4 }
    const target = new BoundsTarget(rect)
    renderSidebar(target, {
      rect,
      sessions: [session('queued', { pendingApprovals: [first, second] })],
      focusedId: 'queued',
      theme,
      glyphs,
      spinnerFrame: 0,
    })
    assert.ok(target.plain().includes('2'), `expected pending count in ${JSON.stringify(target.puts)}`)
  })
})

describe('composer', () => {
  it('reports a caret column using stringWidth of the CJK prefix', () => {
    const rect: Rect = { row: 8, col: 3, width: 40, height: 2 }
    const target = new BoundsTarget(rect)
    const draft = '中文abc'
    const cursor = 2
    const pos = renderComposer(target, {
      rect,
      draft,
      cursor,
      mode: 'queue',
      busy: false,
      theme,
      glyphs,
    })
    assert.equal(pos.row, rect.row)
    assert.equal(pos.col, rect.col + stringWidth('中文'))
    assert.equal(stringWidth('中文'), 4)
  })

  it('locates the caret from the full word-wrapped draft', () => {
    const rect: Rect = { row: 8, col: 3, width: 10, height: 3 }
    const target = new BoundsTarget(rect)
    const pos = renderComposer(target, {
      rect,
      draft: '123456789 a',
      cursor: 10,
      mode: 'queue',
      busy: false,
      theme,
      glyphs,
    })
    assert.equal(pos.row, rect.row + 1)
    assert.equal(pos.col, rect.col)
  })

  it('shows queue/steer in accent when busy and send when idle', () => {
    const rect: Rect = { row: 8, col: 1, width: 40, height: 1 }
    const busy = new BoundsTarget(rect)
    renderComposer(busy, {
      rect,
      draft: 'hello',
      cursor: 0,
      mode: 'queue',
      busy: true,
      theme,
      glyphs,
    })
    assert.match(busy.plain(), /⏎ queue · ⌥⏎ steer/)
    assert.ok(busy.puts.some((p) => p.text.includes('queue') && p.style === theme.accent))

    const idle = new BoundsTarget(rect)
    const pos = renderComposer(idle, {
      rect,
      draft: 'hello',
      cursor: 2,
      mode: 'steer',
      busy: false,
      theme,
      glyphs,
    })
    assert.match(idle.plain(), /⏎ send/)
    assert.doesNotMatch(idle.plain(), /queue/)
    assert.ok(idle.puts.some((p) => p.text.includes('send') && p.style === theme.dim))
    assert.equal(pos.row, rect.row)
    assert.equal(pos.col, rect.col + stringWidth('he'))
  })
})

describe('header telemetry', () => {
  const sampleTel = telemetry({
    contextWindow: 1000,
    systemTokens: 80,
    toolsTokens: 20,
    messageTokens: 20,
    decodeMs: 1000,
    decodeTokens: 45,
    ttftMs: 1000,
  })

  function paint(rect: Rect, extra: { title?: string; host?: HostDescription; telemetry?: SessionTelemetry } = {}): BoundsTarget {
    const target = new BoundsTarget(rect)
    renderHeader(target, {
      rect,
      host: extra.host,
      connection: 'ready',
      sessionTitle: extra.title,
      theme,
      glyphs,
      ...(extra.telemetry !== undefined ? { telemetry: extra.telemetry } : { telemetry: sampleTel }),
    })
    return target
  }

  it('renders ctx, tok/s, and ttft before the provider·model segment', () => {
    const rect: Rect = { row: 1, col: 1, width: 80, height: 1 }
    const target = paint(rect, { title: 'ok', host })
    const plain = target.plain()
    assert.match(plain, /ctx 12%/)
    assert.match(plain, /45 tok\/s/)
    assert.match(plain, /ttft 1\.0s/)
    assert.match(plain, /deepseek · deepseek-chat/)
    const telAt = plain.indexOf('ctx 12%')
    const hostAt = plain.indexOf('deepseek ·')
    assert.ok(telAt >= 0 && hostAt > telAt)
  })

  it('uses warn at 75% context and error at 90%', () => {
    const rect: Rect = { row: 1, col: 1, width: 80, height: 1 }
    const warn = paint(rect, {
      title: 'ok',
      host,
      telemetry: telemetry({
        contextWindow: 200,
        systemTokens: 150,
        toolsTokens: 0,
        messageTokens: 0,
        decodeMs: 1000,
        decodeTokens: 10,
        ttftMs: 500,
      }),
    })
    const warnCtx = warn.puts.find((p) => p.text.includes('ctx 75%'))
    assert.ok(warnCtx, `expected ctx 75% in ${JSON.stringify(warn.puts)}`)
    assert.equal(warnCtx.style, theme.warn)

    const err = paint(rect, {
      title: 'ok',
      host,
      telemetry: telemetry({
        contextWindow: 200,
        systemTokens: 180,
        toolsTokens: 0,
        messageTokens: 0,
        decodeMs: 1000,
        decodeTokens: 10,
        ttftMs: 500,
      }),
    })
    const errCtx = err.puts.find((p) => p.text.includes('ctx 90%'))
    assert.ok(errCtx, `expected ctx 90% in ${JSON.stringify(err.puts)}`)
    assert.equal(errCtx.style, theme.error)

    const ok = paint(rect, {
      title: 'ok',
      host,
      telemetry: telemetry({
        contextWindow: 200,
        systemTokens: 148,
        toolsTokens: 0,
        messageTokens: 0,
        decodeMs: 1000,
        decodeTokens: 10,
        ttftMs: 500,
      }),
    })
    const okCtx = ok.puts.find((p) => p.text.includes('ctx 74%'))
    assert.ok(okCtx, `expected ctx 74% in ${JSON.stringify(ok.puts)}`)
    assert.equal(okCtx.style, theme.dim)
  })

  it('degrades right-to-left at 40 columns without overlapping the title', () => {
    const rect: Rect = { row: 1, col: 1, width: 40, height: 1 }
    const tight = paint(rect, { title: 'ok' })
    const tightPlain = tight.plain()
    assert.match(tightPlain, /deck/)
    assert.match(tightPlain, /ok/)
    assert.match(tightPlain, /ctx 12%/)
    assert.doesNotMatch(tightPlain, /ttft/)
    assert.equal(stringWidth(tightPlain.replace(/\s+$/, '')) <= 40, true)

    const crowded = paint(rect, {
      title: '中文会话 title that is deliberately long',
      host,
    })
    const crowdedPlain = crowded.plain()
    assert.match(crowdedPlain, /deck/)
    assert.match(crowdedPlain, /中文/)
    assert.doesNotMatch(crowdedPlain, /ttft/)
    const deckAt = crowdedPlain.indexOf('deck')
    const titleAt = crowdedPlain.indexOf('中')
    assert.ok(deckAt >= 0 && titleAt > deckAt)
  })
})
