import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Key } from '../src/term/input.ts'
import { stringWidth } from '../src/term/width.ts'
import type { Rect } from '../src/ui/layout.ts'
import type { RenderTarget } from '../src/ui/render.ts'
import type { Glyphs, Theme } from '../src/ui/theme.ts'
import {
  createModes,
  modesHitTest,
  reduceModes,
  renderModes,
  updateModesRows,
  type ModeOption,
  type ModeRow,
  type ModeRowId,
  type ModesResult,
  type ModesState,
} from '../src/ui/modes.ts'
import { testTheme as theme, testGlyphs as glyphs } from './helpers/ui.ts'

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

function opt(value: string, extra: {
  label?: string
  detail?: string
  current?: boolean
  disabled?: string
} = {}): ModeOption {
  const item: ModeOption = { value, label: extra.label ?? value }
  if (extra.detail !== undefined) item.detail = extra.detail
  if (extra.current !== undefined) item.current = extra.current
  if (extra.disabled !== undefined) item.disabled = extra.disabled
  return item
}

function row(id: ModeRowId, extra: {
  label?: string
  value?: string
  optionsTitle?: string
  options?: ModeOption[]
  disabled?: string
} = {}): ModeRow {
  const item: ModeRow = {
    id,
    label: extra.label ?? id,
    value: extra.value ?? '',
  }
  if (extra.optionsTitle !== undefined) item.optionsTitle = extra.optionsTitle
  if (extra.options !== undefined) item.options = extra.options
  if (extra.disabled !== undefined) item.disabled = extra.disabled
  return item
}

function mustContinue(result: ModesResult): ModesState {
  assert.equal(result.kind, 'continue')
  if (result.kind !== 'continue') throw new Error('expected continue')
  return result.state
}

function feed(state: ModesState, keys: readonly Key[]): ModesResult {
  let current = state
  let last: ModesResult = { kind: 'continue', state: current }
  for (const key of keys) {
    last = reduceModes(current, key)
    if (last.kind !== 'continue') return last
    current = last.state
  }
  return last
}

const catalog: ModeRow[] = [
  row('model', {
    value: 'nvidia · inkling · high',
    optionsTitle: 'model',
    options: [
      opt('inkling', { label: 'inkling', current: true }),
      opt('other', { label: 'other' }),
    ],
  }),
  row('agent', {
    value: '标准模式',
    optionsTitle: 'agent preset',
    options: [
      opt('standard', {
        label: '标准模式',
        detail: '功能完整的编码 Agent，支持文件编辑、Shell',
        current: true,
      }),
      opt('ptc', { label: 'PTC 模式', detail: '具备标准模式的全部能力' }),
      opt('minimal', { label: '极简模式', detail: '仅提供持久 bash' }),
      opt('create', { label: '创造模式', detail: '用于创建自定义 Agent preset' }),
    ],
  }),
  row('permission', {
    value: 'workspace-write',
    options: [
      opt('workspace-write', { current: true }),
      opt('read-only'),
    ],
  }),
  row('plan', {
    value: 'off',
    options: [opt('off', { current: true }), opt('on')],
  }),
]

describe('reduceModes', () => {
  it('clamps the row cursor; tab is next; printable characters do nothing', () => {
    const start = createModes(catalog)
    assert.equal(start.cursor, 0)
    assert.equal(start.level, 'rows')

    const up = mustContinue(reduceModes(start, { kind: 'up' }))
    assert.equal(up.cursor, 0)

    const down = mustContinue(feed(start, [{ kind: 'down' }, { kind: 'down' }]))
    assert.equal(down.cursor, 2)

    const tabbed = mustContinue(reduceModes(down, { kind: 'tab' }))
    assert.equal(tabbed.cursor, 3)

    const end = mustContinue(feed(tabbed, [
      { kind: 'down' },
      { kind: 'down' },
      { kind: 'down' },
    ]))
    assert.equal(end.cursor, 3)

    const typed = mustContinue(feed(end, [
      { kind: 'char', char: '1' },
      { kind: 'char', char: 'a' },
      { kind: 'char', char: '2' },
    ]))
    assert.equal(typed.cursor, 3)
    assert.equal(typed.level, 'rows')
    assert.equal(typed, end)
  })

  it('enter drills into options and lands on the current option', () => {
    const start = createModes(catalog)
    const onAgent = mustContinue(reduceModes(start, { kind: 'down' }))
    assert.equal(onAgent.cursor, 1)

    const drilled = mustContinue(reduceModes(onAgent, { kind: 'enter' }))
    assert.equal(drilled.level, 'options')
    assert.equal(drilled.optionCursor, 0)

    const withCurrent = [
      row('agent', {
        value: '极简模式',
        optionsTitle: 'agent preset',
        options: [
          opt('standard', { label: '标准模式' }),
          opt('ptc', { label: 'PTC 模式' }),
          opt('minimal', { label: '极简模式', current: true }),
        ],
      }),
    ]
    const fromCurrent = mustContinue(reduceModes(createModes(withCurrent), { kind: 'enter' }))
    assert.equal(fromCurrent.level, 'options')
    assert.equal(fromCurrent.optionCursor, 2)
  })

  it('clamps the option cursor', () => {
    const start = createModes(catalog)
    const drilled = mustContinue(feed(start, [{ kind: 'down' }, { kind: 'enter' }]))
    assert.equal(drilled.level, 'options')
    assert.equal(drilled.optionCursor, 0)

    const up = mustContinue(reduceModes(drilled, { kind: 'up' }))
    assert.equal(up.optionCursor, 0)

    const down = mustContinue(feed(drilled, [
      { kind: 'down' },
      { kind: 'down' },
      { kind: 'tab' },
      { kind: 'down' },
      { kind: 'down' },
    ]))
    assert.equal(down.optionCursor, 3)
  })

  it('enter on an option returns chose and returns to the rows level', () => {
    const start = createModes(catalog)
    const drilled = mustContinue(feed(start, [{ kind: 'down' }, { kind: 'enter' }]))
    const moved = mustContinue(reduceModes(drilled, { kind: 'down' }))
    const chose = reduceModes(moved, { kind: 'enter' })
    assert.equal(chose.kind, 'chose')
    if (chose.kind !== 'chose') return
    assert.equal(chose.row, 'agent')
    assert.equal(chose.value, 'ptc')
    assert.equal(chose.state.level, 'rows')
    assert.equal(chose.state.cursor, 1)
  })

  it('enter on an action row returns fired', () => {
    const action = createModes([row('model', { value: 'host default' })])
    const fired = reduceModes(action, { kind: 'enter' })
    assert.equal(fired.kind, 'fired')
    if (fired.kind !== 'fired') return
    assert.equal(fired.row, 'model')
    assert.equal(fired.state.level, 'rows')

    const emptyOpts = createModes([
      row('model', { value: 'host default', options: [] }),
    ])
    const also = reduceModes(emptyOpts, { kind: 'enter' })
    assert.equal(also.kind, 'fired')
    if (also.kind !== 'fired') return
    assert.equal(also.row, 'model')
  })

  it('disabled rows and disabled options are inert', () => {
    const rows: ModeRow[] = [
      row('model', {
        value: 'locked',
        disabled: 'session is busy',
        options: [opt('a'), opt('b')],
      }),
      row('agent', {
        value: '标准模式',
        options: [
          opt('standard', { label: '标准模式', current: true }),
          opt('minimal', { label: '极简模式', disabled: 'not available' }),
        ],
      }),
    ]
    const start = createModes(rows)
    const blocked = reduceModes(start, { kind: 'enter' })
    assert.equal(blocked.kind, 'continue')
    if (blocked.kind !== 'continue') return
    assert.equal(blocked.state, start)
    assert.equal(blocked.state.level, 'rows')

    const onAgent = mustContinue(reduceModes(start, { kind: 'down' }))
    const drilled = mustContinue(reduceModes(onAgent, { kind: 'enter' }))
    const onDisabled = mustContinue(reduceModes(drilled, { kind: 'down' }))
    assert.equal(onDisabled.optionCursor, 1)
    const inert = reduceModes(onDisabled, { kind: 'enter' })
    assert.equal(inert.kind, 'continue')
    if (inert.kind !== 'continue') return
    assert.equal(inert.state, onDisabled)
    assert.equal(inert.state.level, 'options')
  })

  it('escape from options goes back to rows; escape from rows cancels', () => {
    const start = createModes(catalog)
    const drilled = mustContinue(reduceModes(start, { kind: 'enter' }))
    assert.equal(drilled.level, 'options')
    const back = mustContinue(reduceModes(drilled, { kind: 'escape' }))
    assert.equal(back.level, 'rows')
    assert.equal(back.cursor, 0)
    assert.equal(reduceModes(back, { kind: 'escape' }).kind, 'cancelled')
  })
})

describe('updateModesRows', () => {
  it('keeps the cursor on the same row id when order changes, and clamps when rows shrink', () => {
    const start = createModes(catalog)
    const onPermission = mustContinue(feed(start, [{ kind: 'down' }, { kind: 'down' }]))
    assert.equal(onPermission.rows[onPermission.cursor]?.id, 'permission')

    const reordered = updateModesRows(onPermission, [
      catalog[2]!,
      catalog[3]!,
      catalog[0]!,
    ])
    assert.equal(reordered.cursor, 0)
    assert.equal(reordered.rows[reordered.cursor]?.id, 'permission')

    const shrunk = updateModesRows(onPermission, [
      catalog[0]!,
      catalog[1]!,
    ])
    assert.equal(shrunk.cursor, 1)
    assert.equal(shrunk.rows[shrunk.cursor]?.id, 'agent')

    const onLast = mustContinue(feed(start, [
      { kind: 'down' },
      { kind: 'down' },
      { kind: 'down' },
      { kind: 'down' },
    ]))
    assert.equal(onLast.cursor, 3)
    const clamped = updateModesRows(onLast, [catalog[0]!, catalog[1]!])
    assert.equal(clamped.cursor, 1)
  })
})

function paintAll(rect: Rect): BoundsTarget {
  const target = new BoundsTarget(rect)
  const start = createModes(catalog)
  renderModes(target, rect, start, theme, glyphs)

  const drilled = mustContinue(feed(start, [{ kind: 'down' }, { kind: 'enter' }]))
  renderModes(target, rect, drilled, theme, glyphs)

  const many: ModeOption[] = []
  for (let i = 0; i < 24; i++) {
    const item = opt(`opt-${String(i).padStart(2, '0')}`, {
      label: `选项 ${i} ${'中文标题'.repeat(4)}`,
      detail: '功能完整的编码 Agent，支持文件编辑、Shell',
    })
    if (i === 11) item.current = true
    many.push(item)
  }
  const long = createModes([
    row('agent', {
      value: '标准模式',
      optionsTitle: 'agent preset',
      options: many,
    }),
  ])
  const longDrilled = mustContinue(reduceModes(long, { kind: 'enter' }))
  renderModes(target, rect, longDrilled, theme, glyphs)

  const disabled = createModes([
    row('plan', {
      value: 'off',
      disabled: 'busy',
      options: [opt('off', { current: true, disabled: 'locked' })],
    }),
  ])
  renderModes(target, rect, disabled, theme, glyphs)
  renderModes(target, rect, createModes([]), theme, glyphs)
  return target
}

describe('modes render bounds', () => {
  for (const [columns, rows] of [
    [10, 4],
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

  it('fills only the panel, not the outer transcript rect', () => {
    const rect: Rect = { row: 1, col: 1, width: 48, height: 16 }
    const target = new BoundsTarget(rect)
    renderModes(target, rect, createModes(catalog), theme, glyphs)
    assert.ok(
      !target.fills.some(
        (fill) =>
          fill.style === 'DIM' &&
          fill.row === rect.row &&
          fill.col === rect.col &&
          fill.width === rect.width &&
          fill.height === rect.height,
      ),
    )
    const panel = target.fills.find((fill) => fill.style === 'BASE')
    assert.ok(panel !== undefined)
    if (panel === undefined) return
    assert.ok(panel.height < rect.height, 'panel should float inside the transcript')
    for (const put of target.puts) {
      assert.ok(put.row >= panel.row && put.row < panel.row + panel.height)
      assert.ok(put.col >= panel.col && put.col < panel.col + panel.width)
    }
  })

  it('harness is a switchable row like model/preset', () => {
    const rows: ModeRow[] = [
      row('model', { value: 'host default' }),
      row('harness', {
        value: 'dsh',
        optionsTitle: 'harness',
        options: [
          opt('dsh', { label: 'dsh', current: true }),
          opt('codex', { label: 'codex' }),
          opt('pi', { label: 'pi', disabled: 'not on PATH' }),
        ],
      }),
    ]
    const start = createModes(rows)
    const onHarness = mustContinue(reduceModes(start, { kind: 'down' }))
    assert.equal(onHarness.rows[onHarness.cursor]?.id, 'harness')
    const drilled = mustContinue(reduceModes(onHarness, { kind: 'enter' }))
    assert.equal(drilled.level, 'options')
    const picked = reduceModes(mustContinue(reduceModes(drilled, { kind: 'down' })), { kind: 'enter' })
    assert.equal(picked.kind, 'chose')
    if (picked.kind !== 'chose') return
    assert.equal(picked.row, 'harness')
    assert.equal(picked.value, 'codex')

    const rect: Rect = { row: 2, col: 4, width: 40, height: 16 }
    const target = new BoundsTarget(rect)
    renderModes(target, rect, onHarness, theme, glyphs)
    const painted = target.puts.map((put) => put.text).join('')
    assert.ok(painted.includes('harness'))
    for (const put of target.puts) {
      assert.ok(put.row >= rect.row && put.row < rect.row + rect.height)
      assert.ok(put.col >= rect.col && put.col < rect.col + rect.width)
    }
  })

  it('does not throw on a tiny or empty rect', () => {
    for (const rect of [
      { row: 3, col: 5, width: 0, height: 0 },
      { row: 3, col: 5, width: 1, height: 1 },
      { row: 3, col: 5, width: 3, height: 2 },
    ] satisfies Rect[]) {
      const target = new BoundsTarget(rect)
      assert.doesNotThrow(() => {
        renderModes(target, rect, createModes(catalog), theme, glyphs)
      })
    }
  })
})

/**
 * Reconstruct each inner list/footer line from non-border puts. Padding by
 * String.length instead of stringWidth makes a CJK row four columns longer
 * than its ASCII siblings — equality is what catches that overhang.
 */
function innerLineTexts(target: BoundsTarget): string[] {
  const byRow = new Map<number, { col: number; text: string; style: string }[]>()
  for (const p of target.puts) {
    if (p.style === 'BORDER') continue
    let list = byRow.get(p.row)
    if (list === undefined) {
      list = []
      byRow.set(p.row, list)
    }
    list.push({ col: p.col, text: p.text, style: p.style })
  }
  const lines: string[] = []
  for (const list of byRow.values()) {
    if (list.every((p) => p.style === 'ACCENT')) continue
    list.sort((a, b) => a.col - b.col)
    const text = list.map((p) => p.text).join('')
    if (text.trim().length === 0) continue
    lines.push(text)
  }
  return lines
}

function assertUniformInner(target: BoundsTarget): string[] {
  const lines = innerLineTexts(target)
  assert.ok(lines.length >= 2, 'expected at least two painted inner rows')
  const widths = lines.map((line) => stringWidth(line))
  const first = widths[0]
  assert.ok(first !== undefined && first > 0)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const width = widths[i]
    assert.equal(
      width,
      first,
      `row ${i} is ${width} cols, others are ${first}: ${JSON.stringify(line)}`,
    )
    assert.ok(
      width !== undefined && width <= target.rect.width,
      `row ${i} exceeds the rect`,
    )
  }
  return lines
}

const LOCKED = 'locked once the session has run a turn'
const LONG_DETAIL = '功能完整的编码 Agent，支持文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流。'

describe('modes CJK safety', () => {
  it('truncates Chinese values and option details to the rect width', () => {
    const rect: Rect = { row: 2, col: 3, width: 28, height: 10 }
    const rows: ModeRow[] = [
      row('agent', {
        value: '标准模式',
        optionsTitle: 'agent preset',
        options: [
          opt('standard', {
            label: '标准模式',
            detail: '功能完整的编码 Agent，支持文件编辑、Shell',
            current: true,
          }),
          opt('minimal', { label: '极简模式', detail: '仅提供持久 bash' }),
        ],
      }),
    ]
    const start = createModes(rows)
    const target = new BoundsTarget(rect)
    assert.doesNotThrow(() => {
      renderModes(target, rect, start, theme, glyphs)
      const drilled = mustContinue(reduceModes(start, { kind: 'enter' }))
      renderModes(target, rect, drilled, theme, glyphs)
    })

    const painted = target.puts.map((p) => p.text).join('')
    assert.ok(painted.includes('标准模式') || painted.includes('极简'))
    const long = '功能完整的编码 Agent，支持文件编辑、Shell'
    assert.ok(!target.puts.some((p) => p.text.includes(long)), 'full unwrapped detail must not be painted')
    for (const p of target.puts) {
      assert.ok(stringWidth(p.text) <= rect.width)
    }
  })

  it('pads a CJK value plus disabled reason to the same inner width as ASCII rows', () => {
    const rows: ModeRow[] = [
      row('model', { value: 'nvidia · inkling' }),
      row('agent', {
        value: '标准模式',
        disabled: LOCKED,
        optionsTitle: 'agent preset',
        options: [opt('standard', { label: '标准模式', current: true })],
      }),
      row('permission', { value: 'read-only' }),
      row('plan', { value: 'off' }),
    ]
    const state = createModes(rows)
    for (const columns of [80, 100] as const) {
      const rect: Rect = { row: 1, col: 1, width: columns, height: 16 }
      const target = new BoundsTarget(rect)
      renderModes(target, rect, state, theme, glyphs)
      const lines = assertUniformInner(target)
      assert.ok(lines.some((line) => line.includes('标准模式')))
      assert.ok(lines.some((line) => line.includes('nvidia')))
      assert.ok(
        stringWidth('标准模式') === 8 && '标准模式'.length === 4,
        'fixture must stay 4 code points / 8 columns',
      )
    }
  })

  it('pads a disabled option with a CJK label to the same inner width as ASCII options', () => {
    const rows: ModeRow[] = [
      row('agent', {
        value: '标准模式',
        optionsTitle: 'agent preset',
        options: [
          opt('standard', {
            label: '标准模式',
            detail: '功能完整的编码 Agent，支持文件编辑、Shell',
            current: true,
            disabled: LOCKED,
          }),
          opt('minimal', { label: 'minimal', detail: 'bash only' }),
          opt('create', { label: 'create', detail: 'custom preset' }),
        ],
      }),
    ]
    const drilled = mustContinue(reduceModes(createModes(rows), { kind: 'enter' }))
    for (const columns of [80, 100] as const) {
      const rect: Rect = { row: 1, col: 1, width: columns, height: 16 }
      const target = new BoundsTarget(rect)
      renderModes(target, rect, drilled, theme, glyphs)
      const lines = assertUniformInner(target)
      assert.ok(lines.some((line) => line.includes('标准模式')))
    }
  })

  it('keeps a long Chinese option detail inside the inner width at 60 and 80 columns', () => {
    const rows: ModeRow[] = [
      row('agent', {
        value: '标准模式',
        optionsTitle: 'agent preset',
        options: [
          opt('standard', {
            label: '标准模式',
            detail: LONG_DETAIL,
            current: true,
          }),
          opt('minimal', { label: '极简模式', detail: '仅提供持久 bash' }),
        ],
      }),
    ]
    const drilled = mustContinue(reduceModes(createModes(rows), { kind: 'enter' }))
    for (const columns of [60, 80] as const) {
      const rect: Rect = { row: 1, col: 1, width: columns, height: 14 }
      const target = new BoundsTarget(rect)
      renderModes(target, rect, drilled, theme, glyphs)
      const lines = assertUniformInner(target)
      assert.ok(!lines.some((line) => line.includes(LONG_DETAIL)))
      for (const line of lines) {
        assert.ok(stringWidth(line) <= columns)
      }
    }
  })
})

describe('modesHitTest', () => {
  it('maps clicks to rows and options and returns undefined off-target', () => {
    const rect: Rect = { row: 1, col: 1, width: 48, height: 16 }
    const start = createModes(catalog)
    const target = new BoundsTarget(rect)
    renderModes(target, rect, start, theme, glyphs)

    const selected = target.puts.find((p) => p.text.includes(glyphs.arrow) && p.style === 'ACCENT')
    assert.ok(selected !== undefined)
    if (selected === undefined) return

    const hit = modesHitTest(start, rect, selected.row, selected.col + 2)
    assert.deepEqual(hit, { kind: 'row', index: 0 })

    const second = modesHitTest(start, rect, selected.row + 1, selected.col + 2)
    assert.deepEqual(second, { kind: 'row', index: 1 })

    assert.equal(modesHitTest(start, rect, selected.row, rect.col), undefined)
    assert.equal(modesHitTest(start, rect, selected.row, rect.col + rect.width - 1), undefined)
    assert.equal(modesHitTest(start, rect, rect.row, selected.col + 2), undefined)
    assert.equal(modesHitTest(start, rect, rect.row + rect.height - 1, selected.col + 2), undefined)
    assert.equal(modesHitTest(start, rect, 0, selected.col), undefined)
    assert.equal(modesHitTest(start, rect, selected.row, 0), undefined)

    const drilled = mustContinue(feed(start, [{ kind: 'down' }, { kind: 'enter' }]))
    const optTarget = new BoundsTarget(rect)
    renderModes(optTarget, rect, drilled, theme, glyphs)
    const optArrow = optTarget.puts.find((p) => p.text.includes(glyphs.arrow) && p.style === 'ACCENT')
    assert.ok(optArrow !== undefined)
    if (optArrow === undefined) return
    assert.deepEqual(
      modesHitTest(drilled, rect, optArrow.row, optArrow.col + 2),
      { kind: 'option', index: 0 },
    )
    assert.deepEqual(
      modesHitTest(drilled, rect, optArrow.row + 2, optArrow.col + 2),
      { kind: 'option', index: 2 },
    )
    assert.equal(modesHitTest(drilled, rect, selected.row, selected.col + 2)?.kind, 'option')
    assert.equal(modesHitTest(start, rect, optArrow.row, optArrow.col + 2)?.kind, 'row')
  })

  it('hit-tests the same scroll window renderModes paints', () => {
    const options: ModeOption[] = []
    for (let i = 0; i < 16; i++) {
      const item = opt(`v${i}`, { label: `opt-${String(i).padStart(2, '0')}` })
      if (i === 14) item.current = true
      options.push(item)
    }
    const start = createModes([row('permission', { value: 'v14', options })])
    const drilled = mustContinue(reduceModes(start, { kind: 'enter' }))
    assert.equal(drilled.optionCursor, 14)

    const rect: Rect = { row: 1, col: 1, width: 40, height: 8 }
    const target = new BoundsTarget(rect)
    renderModes(target, rect, drilled, theme, glyphs)

    const labels = target.puts
      .map((p) => {
        const match = /opt-(\d+)/.exec(p.text)
        if (match === null) return undefined
        const n = match[1]
        if (n === undefined) return undefined
        return { row: p.row, index: Number(n) }
      })
      .filter((item): item is { row: number; index: number } => item !== undefined)

    assert.ok(labels.length > 0)
    const first = labels[0]
    assert.ok(first !== undefined)
    assert.ok(first.index > 0, 'window must have scrolled past the first option')
    assert.deepEqual(
      modesHitTest(drilled, rect, first.row, rect.col + 4),
      { kind: 'option', index: first.index },
    )
    const last = labels[labels.length - 1]
    assert.ok(last !== undefined)
    assert.deepEqual(
      modesHitTest(drilled, rect, last.row, rect.col + 4),
      { kind: 'option', index: last.index },
    )
  })
})
