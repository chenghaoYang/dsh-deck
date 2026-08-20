import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Key } from '../src/term/input.ts'
import { stringWidth } from '../src/term/width.ts'
import type { Rect } from '../src/ui/layout.ts'
import type { RenderTarget } from '../src/ui/render.ts'
import type { Glyphs, Theme } from '../src/ui/theme.ts'
import {
  createSwitcher,
  reduceSwitcher,
  renderSwitcher,
  updateSwitcherEntries,
  type SwitcherEntry,
  type SwitcherResult,
  type SwitcherState,
} from '../src/ui/switcher.ts'

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
}

function entry(id: string, extra: {
  title?: string
  cwd?: string
  running?: boolean
  unread?: number
  blocked?: boolean
  updatedAt?: number
} = {}): SwitcherEntry {
  const row: SwitcherEntry = {
    id,
    title: extra.title ?? id,
    running: extra.running ?? false,
    unread: extra.unread ?? 0,
    blocked: extra.blocked ?? false,
    updatedAt: extra.updatedAt ?? 0,
  }
  if (extra.cwd !== undefined) row.cwd = extra.cwd
  return row
}

function mustContinue(result: SwitcherResult): SwitcherState {
  assert.equal(result.kind, 'continue')
  if (result.kind !== 'continue') throw new Error('expected continue')
  return result.state
}

function feed(state: SwitcherState, keys: readonly Key[]): SwitcherResult {
  let current = state
  let last: SwitcherResult = { kind: 'continue', state: current }
  for (const key of keys) {
    last = reduceSwitcher(current, key)
    if (last.kind !== 'continue') return last
    current = last.state
  }
  return last
}

const catalog = [
  entry('alpha', { title: 'Alpha notes', cwd: '/work/alpha', updatedAt: 30 }),
  entry('beta', { title: 'Beta review', cwd: '/tmp/beta-proj', running: true, unread: 2, updatedAt: 20 }),
  entry('gamma', { title: '中文会话', cwd: '/Users/me/中文项目', blocked: true, unread: 1, updatedAt: 10 }),
]

describe('reduceSwitcher', () => {
  it('type-to-filter narrows; enter focuses the highlighted id', () => {
    const start = createSwitcher(catalog, 'alpha')
    assert.equal(start.cursor, 0)

    const filtered = mustContinue(feed(start, [
      { kind: 'char', char: 'b' },
      { kind: 'char', char: 'e' },
      { kind: 'char', char: 't' },
    ]))
    assert.equal(filtered.filter, 'bet')
    assert.equal(filtered.cursor, 0)

    const focused = reduceSwitcher(filtered, { kind: 'enter' })
    assert.equal(focused.kind, 'focus')
    if (focused.kind !== 'focus') return
    assert.equal(focused.id, 'beta')
  })

  it('filter matches a cwd basename subsequence and resets the cursor', () => {
    const start = createSwitcher(catalog, 'gamma')
    assert.equal(start.cursor, 2)
    const filtered = mustContinue(feed(start, [
      { kind: 'char', char: 'b' },
      { kind: 'char', char: 't' },
      { kind: 'char', char: 'p' },
    ]))
    assert.equal(filtered.cursor, 0)
    const focused = reduceSwitcher(filtered, { kind: 'enter' })
    assert.equal(focused.kind, 'focus')
    if (focused.kind !== 'focus') return
    assert.equal(focused.id, 'beta')
  })

  it('ctrl+x archives the highlighted id and stays open after entries update', () => {
    const start = createSwitcher(catalog, 'beta')
    const archived = reduceSwitcher(start, { kind: 'ctrl', char: 'x' })
    assert.equal(archived.kind, 'archive')
    if (archived.kind !== 'archive') return
    assert.equal(archived.id, 'beta')
    assert.equal(archived.state.stage, 'list')

    const remaining = catalog.filter((item) => item.id !== 'beta')
    const refreshed = updateSwitcherEntries(archived.state, remaining)
    assert.equal(refreshed.cursor, 1)
    assert.equal(refreshed.entries.length, 2)

    const next = reduceSwitcher(refreshed, { kind: 'enter' })
    assert.equal(next.kind, 'focus')
    if (next.kind !== 'focus') return
    assert.equal(next.id, 'gamma')
  })

  it('clamps the cursor when updateSwitcherEntries removes the last row', () => {
    const start = createSwitcher(catalog, 'gamma')
    assert.equal(start.cursor, 2)
    const archived = reduceSwitcher(start, { kind: 'ctrl', char: 'x' })
    assert.equal(archived.kind, 'archive')
    if (archived.kind !== 'archive') return
    const refreshed = updateSwitcherEntries(
      archived.state,
      catalog.filter((item) => item.id !== 'gamma'),
    )
    assert.equal(refreshed.cursor, 1)
    const focused = reduceSwitcher(refreshed, { kind: 'enter' })
    assert.equal(focused.kind, 'focus')
    if (focused.kind !== 'focus') return
    assert.equal(focused.id, 'beta')
  })

  it('rename stage edits CJK text and enter emits the new title', () => {
    const start = createSwitcher(catalog, 'gamma')
    const renaming = mustContinue(reduceSwitcher(start, { kind: 'ctrl', char: 'r' }))
    assert.equal(renaming.stage, 'rename')
    assert.equal(renaming.renameDraft, '中文会话')

    const edited = mustContinue(feed(renaming, [
      { kind: 'char', char: '测' },
      { kind: 'char', char: '试' },
      { kind: 'backspace' },
      { kind: 'char', char: '名' },
    ]))
    assert.equal(edited.renameDraft, '中文会话测名')

    const done = reduceSwitcher(edited, { kind: 'enter' })
    assert.equal(done.kind, 'rename')
    if (done.kind !== 'rename') return
    assert.equal(done.id, 'gamma')
    assert.equal(done.title, '中文会话测名')
  })

  it('esc from rename returns to the list; esc from the list cancels', () => {
    const start = createSwitcher(catalog)
    const renaming = mustContinue(reduceSwitcher(start, { kind: 'ctrl', char: 'r' }))
    const back = mustContinue(reduceSwitcher(renaming, { kind: 'escape' }))
    assert.equal(back.stage, 'list')
    assert.equal(reduceSwitcher(back, { kind: 'escape' }).kind, 'cancelled')
  })

  it('ctrl+n creates a session from the list', () => {
    const start = createSwitcher(catalog)
    assert.equal(reduceSwitcher(start, { kind: 'ctrl', char: 'n' }).kind, 'create')
  })
})

function paintAll(rect: Rect): BoundsTarget {
  const target = new BoundsTarget(rect)
  const start = createSwitcher(catalog, 'beta')
  renderSwitcher(target, rect, start, theme, glyphs)

  const filtered = mustContinue(feed(start, [
    { kind: 'char', char: '中' },
  ]))
  renderSwitcher(target, rect, filtered, theme, glyphs)

  const renaming = mustContinue(reduceSwitcher(start, { kind: 'ctrl', char: 'r' }))
  const typed = mustContinue(feed(renaming, [
    { kind: 'char', char: '很长的中文标题'.repeat(8) },
  ]))
  renderSwitcher(target, rect, typed, theme, glyphs)

  const many: SwitcherEntry[] = []
  for (let i = 0; i < 24; i++) {
    many.push(entry(`s${i}`, {
      title: `会话 ${i} ${'中文标题'.repeat(6)}`,
      cwd: `/Users/me/project-${i}/深度路径`,
      running: i % 3 === 0,
      blocked: i % 5 === 0,
      unread: i % 4 === 0 ? 12 : 0,
      updatedAt: Date.now() - i * 3_600_000,
    }))
  }
  renderSwitcher(target, rect, createSwitcher(many, 's11'), theme, glyphs)
  renderSwitcher(target, rect, createSwitcher([], undefined), theme, glyphs)
  return target
}

describe('switcher render bounds', () => {
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
})
