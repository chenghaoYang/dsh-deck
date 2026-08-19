import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { TranscriptItem, TranscriptState, ToolCallEntry } from '../src/model/fold.ts'
import type { PendingApproval, SessionState } from '../src/model/store.ts'
import type { HostDescription } from '../src/protocol/contract.ts'
import { computeLayout, type Rect } from '../src/ui/layout.ts'
import { lineText, type RenderTarget } from '../src/ui/render.ts'
import { renderComposer } from '../src/ui/composer.ts'
import { renderHelp } from '../src/ui/help.ts'
import { renderSidebar } from '../src/ui/sidebar.ts'
import { renderFooter, renderHeader } from '../src/ui/statusbar.ts'
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
  }
  if (extra.title !== undefined) row.title = extra.title
  if (extra.cwd !== undefined) row.cwd = extra.cwd
  if (extra.origin !== undefined) row.origin = extra.origin
  if (extra.parentSessionId !== undefined) row.parentSessionId = extra.parentSessionId
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
  })

  const header = new BoundsTarget(rectFor('header', layout))
  renderHeader(header, {
    rect: header.rect,
    host,
    connection: 'ready',
    sessionTitle: '中文会话 title that is deliberately long',
    theme,
    glyphs,
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
})
