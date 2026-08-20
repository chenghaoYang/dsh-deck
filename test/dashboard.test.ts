import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { TranscriptItem } from '../src/model/fold.ts'
import type { Key } from '../src/term/input.ts'
import { stringWidth } from '../src/term/width.ts'
import {
  createDashboard,
  isCtrlSlash,
  peekLines,
  reduceDashboard,
  renderDashboard,
  updateDashboardSessions,
  visibleDashboardRows,
  type DashboardResult,
  type DashboardSession,
  type DashboardState,
} from '../src/ui/dashboard.ts'
import type { Rect } from '../src/ui/layout.ts'
import type { RenderTarget } from '../src/ui/render.ts'
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

class BoundsTarget implements RenderTarget {
  readonly puts: { row: number; col: number; text: string; style: string }[] = []
  readonly fills: { row: number; col: number; width: number; height: number; style: string }[] = []
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

  fill(row: number, col: number, width: number, height: number, _char = ' ', style = ''): void {
    if (width === 0 || height === 0) return
    const { rect } = this
    if (width < 0 || height < 0) throw new Error('fill negative size')
    if (row < rect.row || row + height > rect.row + rect.height) {
      throw new Error(`fill row ${row}+${height} outside ${rect.row}..${rect.row + rect.height - 1}`)
    }
    if (col < rect.col || col + width > rect.col + rect.width) {
      throw new Error(`fill col ${col}+${width} outside ${rect.col}..${rect.col + rect.width - 1}`)
    }
    this.fills.push({ row, col, width, height, style })
  }
}

function session(id: string, extra: {
  title?: string
  cwd?: string
  running?: boolean
  unread?: number
  blocked?: boolean
  lastError?: string
  updatedAt?: number
  model?: string
  items?: readonly TranscriptItem[]
  pendingTool?: string
} = {}): DashboardSession {
  const row: DashboardSession = {
    id,
    title: extra.title ?? id,
    running: extra.running ?? false,
    unread: extra.unread ?? 0,
    blocked: extra.blocked ?? false,
    updatedAt: extra.updatedAt ?? 0,
    items: extra.items ?? [],
  }
  if (extra.cwd !== undefined) row.cwd = extra.cwd
  if (extra.lastError !== undefined) row.lastError = extra.lastError
  if (extra.model !== undefined) row.model = extra.model
  if (extra.pendingTool !== undefined) row.pendingTool = extra.pendingTool
  return row
}

function mustContinue(result: DashboardResult): DashboardState {
  assert.equal(result.kind, 'continue')
  if (result.kind !== 'continue') throw new Error('expected continue')
  return result.state
}

function feed(state: DashboardState, keys: readonly Key[]): DashboardResult {
  let current = state
  let last: DashboardResult = { kind: 'continue', state: current }
  for (const key of keys) {
    last = reduceDashboard(current, key)
    if (last.kind !== 'continue') return last
    current = last.state
  }
  return last
}

const peekItems: TranscriptItem[] = [
  { kind: 'user', seq: 1, time: 0, text: 'older prompt' },
  { kind: 'assistant', seq: 2, turn: 1, step: 1, text: 'first reply\nmore', streaming: false },
  {
    kind: 'tool',
    seq: 3,
    turn: 1,
    step: 2,
    call: { callId: 'c1', name: 'bash', argumentsRaw: '{}', status: 'ok' },
  },
  { kind: 'turn-end', seq: 4, turn: 1, reason: 'stop' },
  { kind: 'assistant', seq: 5, turn: 1, step: 3, text: '  latest   output  ', streaming: false },
]

const catalog = [
  session('alpha', { title: 'Alpha notes', cwd: '/work/alpha', updatedAt: 30, items: peekItems }),
  session('beta', {
    title: 'Beta review',
    cwd: '/tmp/beta-proj',
    running: true,
    unread: 2,
    updatedAt: 20,
    pendingTool: 'bash',
  }),
  session('gamma', {
    title: '中文会话',
    cwd: '/Users/me/中文项目',
    blocked: true,
    unread: 1,
    updatedAt: 10,
  }),
]

describe('createDashboard', () => {
  it('sorts blocked before running before lastError before idle, newest first inside a group', () => {
    const mixed = [
      session('idle-old', { updatedAt: 1 }),
      session('run-new', { running: true, updatedAt: 40 }),
      session('err', { lastError: 'boom', updatedAt: 50 }),
      session('idle-new', { updatedAt: 100 }),
      session('blocked', { blocked: true, updatedAt: 2 }),
      session('run-old', { running: true, updatedAt: 10 }),
      session('blocked-run', { blocked: true, running: true, updatedAt: 3 }),
    ]
    const state = createDashboard(mixed)
    assert.deepEqual(
      state.sessions.map((row) => row.id),
      ['blocked-run', 'blocked', 'run-new', 'run-old', 'err', 'idle-new', 'idle-old'],
    )
  })

  it('places the cursor on focusedId after sorting', () => {
    const state = createDashboard(catalog, 'alpha')
    assert.equal(state.focus, 'list')
    assert.equal(state.cursor, 3)
    assert.equal(state.sessions[state.cursor - 1]?.id, 'alpha')
    assert.deepEqual(
      state.sessions.map((row) => row.id),
      ['gamma', 'beta', 'alpha'],
    )

    const first = createDashboard(catalog)
    assert.equal(first.cursor, 1)
    assert.equal(first.sessions[0]?.id, 'gamma')

    const missing = createDashboard(catalog, 'nope')
    assert.equal(missing.cursor, 1)
  })

  it('expands idle fold so a focused older idle stays selected', () => {
    const state = createDashboard(idleCatalog(12), 'i0')
    assert.equal(state.idleExpanded, true)
    const row = visibleDashboardRows(state)[state.cursor]
    assert.equal(row?.kind, 'session')
    if (row?.kind === 'session') assert.equal(row.session.id, 'i0')
  })

  it('starts on the dispatch row when there are no sessions', () => {
    const state = createDashboard([])
    assert.equal(state.focus, 'input')
    assert.equal(state.cursor, 0)
    assert.equal(state.sessions.length, 0)
  })
})

describe('updateDashboardSessions', () => {
  it('keeps the cursor on the same session id across resorted updates', () => {
    const start = createDashboard(catalog, 'alpha')
    const next = updateDashboardSessions(start, [
      session('alpha', { title: 'Alpha notes', running: true, updatedAt: 90 }),
      session('gamma', { title: '中文会话', blocked: true, updatedAt: 10 }),
    ])
    assert.equal(next.sessions[next.cursor - 1]?.id, 'alpha')
    assert.equal(next.focus, start.focus)
    assert.equal(next.draft, start.draft)
  })

  it('clamps when the highlighted session vanishes', () => {
    const start = createDashboard(catalog, 'alpha')
    const next = updateDashboardSessions(
      start,
      catalog.filter((row) => row.id !== 'alpha'),
    )
    assert.equal(next.cursor, 2)
    assert.equal(next.sessions.length, 2)
  })
})

describe('reduceDashboard', () => {
  it('empty enter on a session row attaches', () => {
    const start = createDashboard(catalog, 'alpha')
    const result = reduceDashboard(start, { kind: 'enter' })
    assert.equal(result.kind, 'attach')
    if (result.kind !== 'attach') return
    assert.equal(result.id, 'alpha')
  })

  it('typed draft + enter on a session replies without attaching', () => {
    const start = createDashboard(catalog, 'beta')
    const typed = mustContinue(feed(start, [
      { kind: 'char', char: 'h' },
      { kind: 'char', char: 'i' },
    ]))
    assert.equal(typed.focus, 'input')
    assert.equal(typed.draft, 'hi')
    const result = reduceDashboard(typed, { kind: 'enter' })
    assert.equal(result.kind, 'reply')
    if (result.kind !== 'reply') return
    assert.equal(result.id, 'beta')
    assert.equal(result.text, 'hi')
    assert.equal(result.attach, false)
  })

  it('typed draft + enter on the dispatch row dispatches', () => {
    const start = createDashboard(catalog, 'gamma')
    const atDispatch = mustContinue(reduceDashboard(start, { kind: 'up' }))
    assert.equal(atDispatch.cursor, 0)
    const typed = mustContinue(feed(atDispatch, [
      { kind: 'char', char: 'g' },
      { kind: 'char', char: 'o' },
    ]))
    const result = reduceDashboard(typed, { kind: 'enter' })
    assert.equal(result.kind, 'dispatch')
    if (result.kind !== 'dispatch') return
    assert.equal(result.text, 'go')
    assert.equal(result.attach, false)
  })

  it('empty enter on the dispatch row is a no-op', () => {
    const start = createDashboard([])
    const result = reduceDashboard(start, { kind: 'enter' })
    assert.equal(result.kind, 'continue')
    if (result.kind !== 'continue') return
    assert.equal(result.state.cursor, 0)
  })

  it('ctrl+s sends with attach true', () => {
    const start = createDashboard(catalog, 'alpha')
    const typed = mustContinue(feed(start, [
      { kind: 'char', char: 'o' },
      { kind: 'char', char: 'k' },
    ]))
    const reply = reduceDashboard(typed, { kind: 'ctrl', char: 's' })
    assert.equal(reply.kind, 'reply')
    if (reply.kind !== 'reply') return
    assert.equal(reply.id, 'alpha')
    assert.equal(reply.text, 'ok')
    assert.equal(reply.attach, true)

    const dispatching = mustContinue(feed(createDashboard([]), [
      { kind: 'char', char: 'n' },
      { kind: 'char', char: 'e' },
      { kind: 'char', char: 'w' },
    ]))
    const dispatched = reduceDashboard(dispatching, { kind: 'ctrl', char: 'S' })
    assert.equal(dispatched.kind, 'dispatch')
    if (dispatched.kind !== 'dispatch') return
    assert.equal(dispatched.text, 'new')
    assert.equal(dispatched.attach, true)
  })

  it('j/k on list move; typing a letter from list focuses input and inserts', () => {
    const start = createDashboard(catalog, 'gamma')
    assert.equal(start.cursor, 1)

    const down = mustContinue(reduceDashboard(start, { kind: 'char', char: 'j' }))
    assert.equal(down.cursor, 2)
    assert.equal(down.focus, 'list')
    assert.equal(down.draft, '')

    const up = mustContinue(reduceDashboard(down, { kind: 'char', char: 'k' }))
    assert.equal(up.cursor, 1)
    assert.equal(up.draft, '')

    const typed = mustContinue(reduceDashboard(up, { kind: 'char', char: 'x' }))
    assert.equal(typed.focus, 'input')
    assert.equal(typed.draft, 'x')
    assert.equal(typed.cursor, 1)

    const insertI = mustContinue(feed(start, [
      { kind: 'char', char: 'i' },
      { kind: 'char', char: 'i' },
    ]))
    assert.equal(insertI.focus, 'input')
    assert.equal(insertI.draft, 'i')
  })

  it('escape from input with draft goes to list; esc then steps back to dispatch', () => {
    const start = createDashboard(catalog, 'beta')
    const typed = mustContinue(feed(start, [{ kind: 'char', char: 'a' }]))
    assert.equal(typed.focus, 'input')
    const back = mustContinue(reduceDashboard(typed, { kind: 'escape' }))
    assert.equal(back.focus, 'list')
    assert.equal(back.draft, 'a')
    const atDispatch = mustContinue(reduceDashboard(back, { kind: 'escape' }))
    assert.equal(atDispatch.cursor, 0)
    assert.equal(atDispatch.draft, 'a')
    assert.equal(reduceDashboard(atDispatch, { kind: 'escape' }).kind, 'cancelled')
  })

  it('ctrl+c cancels; empty-draft escape from input cancels', () => {
    const start = createDashboard(catalog, 'alpha')
    assert.equal(reduceDashboard(start, { kind: 'ctrl', char: 'c' }).kind, 'cancelled')
    const input = mustContinue(reduceDashboard(start, { kind: 'tab' }))
    assert.equal(input.focus, 'input')
    assert.equal(input.draft, '')
    assert.equal(reduceDashboard(input, { kind: 'escape' }).kind, 'cancelled')
  })

  it('ctrl+u clears the draft; tab toggles list and input', () => {
    const start = createDashboard(catalog, 'alpha')
    const typed = mustContinue(feed(start, [
      { kind: 'char', char: 'z' },
      { kind: 'char', char: 'z' },
    ]))
    const cleared = mustContinue(reduceDashboard(typed, { kind: 'ctrl', char: 'u' }))
    assert.equal(cleared.draft, '')
    assert.equal(cleared.focus, 'input')
    const listed = mustContinue(reduceDashboard(cleared, { kind: 'tab' }))
    assert.equal(listed.focus, 'list')
  })

  it('up/down from input still move the list cursor', () => {
    const start = createDashboard(catalog, 'gamma')
    const typed = mustContinue(feed(start, [{ kind: 'char', char: 'q' }]))
    const down = mustContinue(reduceDashboard(typed, { kind: 'down' }))
    assert.equal(down.cursor, 2)
    assert.equal(down.focus, 'input')
    assert.equal(down.draft, 'q')
  })
})

describe('peekLines', () => {
  it('extracts assistant/tool lines from the end, skipping turn-end', () => {
    const lines = peekLines(peekItems)
    assert.deepEqual(lines, ['older prompt', 'first reply', 'bash · ok', 'latest output'])
    assert.deepEqual(peekLines(peekItems, 2), ['bash · ok', 'latest output'])

    const extra: TranscriptItem[] = [
      ...peekItems,
      { kind: 'notice', seq: 6, text: '  heads   up  ' },
      { kind: 'reasoning', seq: 7, turn: 2, step: 1, text: 'maybe\nlater', streaming: true },
      { kind: 'image', seq: 8, turn: 2, step: 2, alt: 'plot' },
    ]
    assert.deepEqual(peekLines(extra, 4), [
      'latest output',
      'heads up',
      'thought maybe',
      'image',
    ])
  })
})

function sessionIds(state: DashboardState): string[] {
  const ids: string[] = []
  for (const row of visibleDashboardRows(state)) {
    if (row.kind === 'session') ids.push(row.session.id)
  }
  return ids
}

function selectedId(state: DashboardState): string | undefined {
  const row = visibleDashboardRows(state)[state.cursor]
  return row?.kind === 'session' ? row.session.id : undefined
}

function idleCatalog(count: number): DashboardSession[] {
  const rows: DashboardSession[] = []
  for (let i = 0; i < count; i++) {
    rows.push(session(`i${i}`, { title: `idle ${i}`, updatedAt: i, cwd: `/work/${i}` }))
  }
  return rows
}

function paintAll(rect: Rect): BoundsTarget {
  const target = new BoundsTarget(rect)
  const start = createDashboard(catalog, 'beta')
  renderDashboard(target, rect, start, theme, glyphs)

  const typed = mustContinue(feed(start, [
    { kind: 'char', char: '中' },
    { kind: 'char', char: '文' },
  ]))
  renderDashboard(target, rect, typed, theme, glyphs, 1)

  const many: DashboardSession[] = []
  for (let i = 0; i < 24; i++) {
    many.push(session(`s${i}`, {
      title: `会话 ${i} ${'中文标题'.repeat(6)}`,
      cwd: `/Users/me/project-${i}/深度路径`,
      running: i % 3 === 0,
      blocked: i % 5 === 0,
      unread: i % 4 === 0 ? 12 : 0,
      updatedAt: Date.now() - i * 3_600_000,
      items: peekItems,
      ...i % 3 === 0 ? { pendingTool: 'very-long-pending-tool-name' } : {},
    }))
  }
  renderDashboard(target, rect, createDashboard(many, 's11'), theme, glyphs)
  renderDashboard(target, rect, createDashboard(many, 's11', {
    grouping: 'directory',
    pinned: ['s11', 's0'],
    pinOrder: ['s11', 's0'],
  }), theme, glyphs)
  renderDashboard(target, rect, createDashboard([], undefined), theme, glyphs)

  const longDraft = mustContinue(feed(createDashboard(catalog, 'alpha'), [
    { kind: 'char', char: '很长的中文草稿'.repeat(12) },
  ]))
  renderDashboard(target, rect, longDraft, theme, glyphs)

  const searching = mustContinue(feed(createDashboard(catalog, 'beta'), [
    { kind: 'ctrl', char: '/' },
    { kind: 'char', char: 's' },
    { kind: 'char', char: ':' },
    { kind: 'char', char: 'blocked' },
  ]))
  renderDashboard(target, rect, searching, theme, glyphs)

  const renaming = mustContinue(reduceDashboard(createDashboard(catalog, 'alpha'), { kind: 'ctrl', char: 'r' }))
  renderDashboard(target, rect, renaming, theme, glyphs)

  const folded = createDashboard(idleCatalog(12), undefined, {
    pinned: ['i0'],
    pinOrder: ['i0'],
  })
  renderDashboard(target, rect, folded, theme, glyphs)
  const filtered = mustContinue(reduceDashboard(
    mustContinue(feed(createDashboard(catalog, 'alpha'), [
      { kind: 'ctrl', char: '/' },
      { kind: 'char', char: 'Alpha' },
    ])),
    { kind: 'enter' },
  ))
  renderDashboard(target, rect, filtered, theme, glyphs)
  return target
}

describe('dashboard render', () => {
  for (const [columns, rows] of [
    [40, 10],
    [200, 60],
  ] as const) {
    it(`never writes outside a ${columns}x${rows} rect`, () => {
      const rect: Rect = { row: 1, col: 1, width: columns, height: rows }
      assert.doesNotThrow(() => {
        paintAll(rect)
      })
    })
  }

  it('stays in bounds and includes dashboard and dispatch', () => {
    const rect: Rect = { row: 1, col: 1, width: 80, height: 24 }
    const target = new BoundsTarget(rect)
    renderDashboard(target, rect, createDashboard(catalog, 'beta'), theme, glyphs)
    const plain = target.puts.map((put) => put.text).join('')
    assert.ok(plain.includes('dashboard'))
    assert.ok(plain.includes('dispatch'))
    assert.ok(
      !target.fills.some(
        (fill) =>
          fill.style === 'DIM' &&
          fill.width === rect.width &&
          fill.height === rect.height,
      ),
    )
    const panel = target.fills.find((fill) => fill.style === 'BASE')
    assert.ok(panel !== undefined)
    if (panel === undefined) return
    assert.ok(panel.width < rect.width && panel.height <= rect.height)
    for (const put of target.puts) {
      assert.ok(put.row >= panel.row && put.row < panel.row + panel.height)
      assert.ok(put.col >= panel.col && put.col < panel.col + panel.width)
    }
  })

  it('animates running entries from spinnerFrame', () => {
    const rect: Rect = { row: 1, col: 1, width: 48, height: 16 }
    const start = createDashboard(catalog, 'beta')
    const frame0 = new BoundsTarget(rect)
    renderDashboard(frame0, rect, start, theme, glyphs, 0)
    const frame1 = new BoundsTarget(rect)
    renderDashboard(frame1, rect, start, theme, glyphs, 1)
    const spin0 = glyphs.running[0]
    const spin1 = glyphs.running[1]
    assert.ok(spin0 !== undefined && frame0.puts.some((p) => p.text.includes(spin0)))
    assert.ok(spin1 !== undefined && frame1.puts.some((p) => p.text.includes(spin1)))
  })

  it('shows pendingTool in the rendered status for a running session', () => {
    const rect: Rect = { row: 1, col: 1, width: 80, height: 24 }
    const target = new BoundsTarget(rect)
    renderDashboard(target, rect, createDashboard(catalog, 'beta'), theme, glyphs)
    const plain = target.puts.map((put) => put.text).join('')
    assert.ok(plain.includes('bash'))
    assert.ok(!plain.includes('running'))
  })
})

describe('dashboard search', () => {
  it('isCtrlSlash accepts all three encodings', () => {
    assert.equal(isCtrlSlash({ kind: 'ctrl', char: '/' }), true)
    assert.equal(isCtrlSlash({ kind: 'ctrl', char: '_' }), true)
    assert.equal(isCtrlSlash({ kind: 'ctrl', char: '\x7f' }), true)
    assert.equal(isCtrlSlash({ kind: 'ctrl', char: 'c' }), false)
    assert.equal(isCtrlSlash({ kind: 'char', char: '/' }), false)
  })

  it('Ctrl+/ search filters; Enter applies; Esc clears; s:blocked prefix', () => {
    const start = createDashboard(catalog, 'alpha')
    const searching = mustContinue(reduceDashboard(start, { kind: 'ctrl', char: '/' }))
    assert.equal(searching.focus, 'search')
    assert.equal(searching.searchDraft, '')
    assert.equal(searching.draft, '')

    const typed = mustContinue(feed(searching, [
      { kind: 'char', char: 's' },
      { kind: 'char', char: ':' },
      { kind: 'char', char: 'b' },
      { kind: 'char', char: 'l' },
      { kind: 'char', char: 'o' },
      { kind: 'char', char: 'c' },
      { kind: 'char', char: 'k' },
      { kind: 'char', char: 'e' },
      { kind: 'char', char: 'd' },
    ]))
    assert.equal(typed.searchDraft, 's:blocked')
    assert.equal(typed.draft, '')
    assert.deepEqual(sessionIds(typed), ['gamma'])

    const applied = mustContinue(reduceDashboard(typed, { kind: 'enter' }))
    assert.equal(applied.focus, 'list')
    assert.equal(applied.filter, 's:blocked')
    assert.deepEqual(sessionIds(applied), ['gamma'])

    const cleared = mustContinue(reduceDashboard(applied, { kind: 'escape' }))
    assert.equal(cleared.filter, '')
    assert.equal(cleared.searchDraft, '')
    assert.deepEqual(sessionIds(cleared), ['gamma', 'beta', 'alpha'])

    const again = mustContinue(reduceDashboard(cleared, { kind: 'ctrl', char: '_' }))
    assert.equal(again.focus, 'search')
    const cancelled = mustContinue(reduceDashboard(again, { kind: 'ctrl', char: '\x7f' }))
    assert.equal(cancelled.focus, 'list')
    assert.equal(cancelled.filter, '')
  })
})

describe('dashboard pins, grouping, idle fold', () => {
  it('createDashboard options apply pinned and grouping', () => {
    const state = createDashboard(catalog, 'alpha', {
      grouping: 'directory',
      pinned: ['alpha'],
      pinOrder: ['alpha'],
    })
    assert.equal(state.grouping, 'directory')
    assert.deepEqual([...state.pinned], ['alpha'])
    assert.deepEqual([...state.pinOrder], ['alpha'])
    assert.equal(selectedId(state), 'alpha')
    assert.deepEqual(
      state.sessions.map((row) => row.id),
      [...catalog]
        .sort((a, b) => (a.cwd ?? '').localeCompare(b.cwd ?? ''))
        .map((row) => row.id),
    )
  })

  it('updateDashboardSessions preserves pin and selected id', () => {
    const start = createDashboard(catalog, 'beta', {
      pinned: ['beta'],
      pinOrder: ['beta'],
    })
    const next = updateDashboardSessions(start, [
      session('beta', { title: 'Beta review', running: true, updatedAt: 1 }),
      session('alpha', { title: 'Alpha notes', updatedAt: 99 }),
    ])
    assert.deepEqual([...next.pinned], ['beta'])
    assert.deepEqual([...next.pinOrder], ['beta'])
    assert.equal(next.grouping, start.grouping)
    assert.equal(selectedId(next), 'beta')
  })

  it('Ctrl+T pin moves row; pinned idle is not folded', () => {
    const pair = createDashboard([
      session('old', { title: 'old', updatedAt: 1 }),
      session('new', { title: 'new', updatedAt: 2 }),
    ], 'old')
    assert.deepEqual(pair.sessions.map((row) => row.id), ['new', 'old'])
    const pinned = mustContinue(reduceDashboard(pair, { kind: 'ctrl', char: 't' }))
    assert.deepEqual([...pinned.pinned], ['old'])
    assert.deepEqual([...pinned.pinOrder], ['old'])
    assert.deepEqual(pinned.sessions.map((row) => row.id), ['old', 'new'])
    assert.equal(selectedId(pinned), 'old')

    const atOldest = createDashboard(idleCatalog(10), 'i0', { idleExpanded: true })
    const pinnedOld = mustContinue(reduceDashboard(atOldest, { kind: 'ctrl', char: 't' }))
    const folded = mustContinue(reduceDashboard(pinnedOld, { kind: 'char', char: 'h' }))
    assert.equal(folded.idleExpanded, false)
    assert.ok(sessionIds(folded).includes('i0'))
    const more = visibleDashboardRows(folded).find((row) => row.kind === 'idle-more')
    assert.equal(more?.kind, 'idle-more')
    if (more?.kind === 'idle-more') assert.equal(more.hidden, 1)
  })

  it('idle fold keeps 8 and Enter on the more-row expands', () => {
    const state = createDashboard(idleCatalog(10))
    const rows = visibleDashboardRows(state)
    assert.equal(rows.length, 1 + 8 + 1)
    assert.deepEqual(sessionIds(state), ['i9', 'i8', 'i7', 'i6', 'i5', 'i4', 'i3', 'i2'])
    const last = rows[rows.length - 1]
    assert.equal(last?.kind, 'idle-more')
    if (last?.kind === 'idle-more') assert.equal(last.hidden, 2)

    const atMore = mustContinue(reduceDashboard(state, { kind: 'end' }))
    assert.equal(visibleDashboardRows(atMore)[atMore.cursor]?.kind, 'idle-more')
    const expanded = mustContinue(reduceDashboard(atMore, { kind: 'enter' }))
    assert.equal(expanded.idleExpanded, true)
    assert.equal(visibleDashboardRows(expanded).some((row) => row.kind === 'idle-more'), false)
    assert.deepEqual(sessionIds(expanded), ['i9', 'i8', 'i7', 'i6', 'i5', 'i4', 'i3', 'i2', 'i1', 'i0'])

    const rect: Rect = { row: 1, col: 1, width: 80, height: 24 }
    const target = new BoundsTarget(rect)
    renderDashboard(target, rect, state, theme, glyphs)
    assert.ok(target.puts.map((put) => put.text).join('').includes('more idle'))
  })

  it('Ctrl+G groups by cwd', () => {
    const start = createDashboard([
      session('b', { title: 'b', cwd: '/z', blocked: true, updatedAt: 2 }),
      session('a', { title: 'a', cwd: '/a', updatedAt: 1 }),
    ], 'b')
    assert.equal(start.grouping, 'state')
    assert.equal(start.sessions[0]?.id, 'b')
    const grouped = mustContinue(reduceDashboard(start, { kind: 'ctrl', char: 'g' }))
    assert.equal(grouped.grouping, 'directory')
    assert.deepEqual(grouped.sessions.map((row) => row.id), ['a', 'b'])
    assert.equal(selectedId(grouped), 'b')
  })
})

describe('dashboard rename, stop, esc', () => {
  it('Ctrl+R rename result', () => {
    const start = createDashboard(catalog, 'alpha')
    const renaming = mustContinue(reduceDashboard(start, { kind: 'ctrl', char: 'r' }))
    assert.equal(renaming.focus, 'rename')
    assert.equal(renaming.renameDraft, 'Alpha notes')
    const edited = mustContinue(feed(renaming, [
      { kind: 'ctrl', char: 'u' },
      { kind: 'char', char: 'N' },
      { kind: 'char', char: 'e' },
      { kind: 'char', char: 'w' },
    ]))
    const result = reduceDashboard(edited, { kind: 'enter' })
    assert.equal(result.kind, 'rename')
    if (result.kind !== 'rename') return
    assert.equal(result.id, 'alpha')
    assert.equal(result.title, 'New')
    assert.equal(result.state.focus, 'list')
    assert.equal(result.state.renameDraft, '')
  })

  it('Ctrl+X running cancels; Ctrl+X idle twice archives', () => {
    const running = reduceDashboard(createDashboard(catalog, 'beta'), { kind: 'ctrl', char: 'x' })
    assert.equal(running.kind, 'cancel')
    if (running.kind === 'cancel') {
      assert.equal(running.id, 'beta')
      assert.equal(running.state.stopArmedId, undefined)
    }

    const idle = createDashboard(catalog, 'alpha')
    const archived = feed(idle, [
      { kind: 'ctrl', char: 'x' },
      { kind: 'ctrl', char: 'x' },
    ])
    assert.equal(archived.kind, 'archive')
    if (archived.kind !== 'archive') return
    assert.equal(archived.id, 'alpha')
    assert.equal(archived.state.stopArmedId, undefined)
  })

  it('Esc from a session row goes to cursor 0; second Esc cancels', () => {
    const start = createDashboard(catalog, 'alpha')
    assert.ok(start.cursor > 0)
    const atDispatch = mustContinue(reduceDashboard(start, { kind: 'escape' }))
    assert.equal(atDispatch.cursor, 0)
    assert.equal(atDispatch.focus, 'list')
    assert.equal(reduceDashboard(atDispatch, { kind: 'escape' }).kind, 'cancelled')
  })
})

