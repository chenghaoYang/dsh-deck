import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Key } from '../src/term/input.ts'
import { stringWidth } from '../src/term/width.ts'
import type { AskUserQuestionItem } from '../src/protocol/contract.ts'
import type { Rect } from '../src/ui/layout.ts'
import type { RenderTarget } from '../src/ui/render.ts'
import type { Glyphs, Theme } from '../src/ui/theme.ts'
import {
  createCommandPalette,
  createPickerOverlay,
  createQuestionOverlay,
  layoutImageOverlay,
  reduceCommandPalette,
  reducePickerOverlay,
  reduceQuestionOverlay,
  renderCommandPalette,
  renderImageOverlayChrome,
  renderPickerOverlay,
  renderQuestionOverlay,
  type PickerModel,
  type PickerOverlayResult,
  type PickerOverlayState,
  type QuestionOverlayResult,
  type QuestionOverlayState,
} from '../src/ui/overlay.ts'

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

function mustContinueQ(result: QuestionOverlayResult): QuestionOverlayState {
  assert.equal(result.kind, 'continue')
  if (result.kind !== 'continue') throw new Error('expected continue')
  return result.state
}

function mustContinueP(result: PickerOverlayResult): PickerOverlayState {
  assert.equal(result.kind, 'continue')
  if (result.kind !== 'continue') throw new Error('expected continue')
  return result.state
}

function feedQuestion(state: QuestionOverlayState, keys: readonly Key[]): QuestionOverlayResult {
  let current = state
  let last: QuestionOverlayResult = { kind: 'continue', state: current }
  for (const key of keys) {
    last = reduceQuestionOverlay(current, key)
    if (last.kind !== 'continue') return last
    current = last.state
  }
  return last
}

function feedPicker(state: PickerOverlayState, keys: readonly Key[]): PickerOverlayResult {
  let current = state
  let last: PickerOverlayResult = { kind: 'continue', state: current }
  for (const key of keys) {
    last = reducePickerOverlay(current, key)
    if (last.kind !== 'continue') return last
    current = last.state
  }
  return last
}

function cellInside(
  cell: { row: number; col: number; columns: number; rows: number },
  rect: Rect,
): void {
  assert.ok(cell.columns >= 1)
  assert.ok(cell.rows >= 1)
  assert.ok(cell.row >= rect.row)
  assert.ok(cell.col >= rect.col)
  assert.ok(cell.row + cell.rows - 1 <= rect.row + rect.height - 1)
  assert.ok(cell.col + cell.columns - 1 <= rect.col + rect.width - 1)
}

function rectInside(inner: Rect, outer: Rect): void {
  assert.ok(inner.width >= 1)
  assert.ok(inner.height >= 1)
  assert.ok(inner.row >= outer.row)
  assert.ok(inner.col >= outer.col)
  assert.ok(inner.row + inner.height - 1 <= outer.row + outer.height - 1)
  assert.ok(inner.col + inner.width - 1 <= outer.col + outer.width - 1)
}

const questions: readonly AskUserQuestionItem[] = [
  {
    id: 'q1',
    question: 'Ship it?',
    header: 'Release',
    detail: 'choose a lane',
    options: [{ label: 'yes' }, { label: 'no' }],
  },
  {
    id: 'q2',
    question: 'Channel?',
    options: [{ label: 'stable' }, { label: 'beta' }],
  },
]

const pickerModels: readonly PickerModel[] = [
  {
    provider: 'deepseek',
    providerName: 'DeepSeek',
    id: 'chat',
    name: 'DeepSeek Chat',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    current: true,
  },
  { provider: 'deepseek', providerName: 'DeepSeek', id: 'coder', name: 'DeepSeek Coder' },
  { provider: 'openai', id: 'gpt-4' },
]

describe('reduceQuestionOverlay', () => {
  it('single-select enter walks the batch and echoes every id', () => {
    const start = createQuestionOverlay(questions)
    const afterFirst = reduceQuestionOverlay(start, { kind: 'enter' })
    const mid = mustContinueQ(afterFirst)
    assert.equal(mid.index, 1)
    const afterDown = reduceQuestionOverlay(mid, { kind: 'down' })
    const last = reduceQuestionOverlay(mustContinueQ(afterDown), { kind: 'enter' })
    assert.equal(last.kind, 'answered')
    if (last.kind !== 'answered') return
    assert.deepEqual(last.answer, {
      answers: [
        { id: 'q1', selected: ['yes'] },
        { id: 'q2', selected: ['beta'] },
      ],
    })
  })

  it('multi-select space toggles and enter confirms the set', () => {
    const start = createQuestionOverlay([
      {
        id: 'picks',
        question: 'Which?',
        multiSelect: true,
        options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }],
      },
    ])
    const result = feedQuestion(start, [
      { kind: 'char', char: ' ' },
      { kind: 'down' },
      { kind: 'char', char: ' ' },
      { kind: 'enter' },
    ])
    assert.equal(result.kind, 'answered')
    if (result.kind !== 'answered') return
    assert.deepEqual(result.answer, { answers: [{ id: 'picks', selected: ['a', 'b'] }] })
  })

  it('o opens other; CJK appends and backspace deletes a cluster', () => {
    const start = createQuestionOverlay([
      { id: 'name', question: 'Other name?', options: [{ label: 'skip' }] },
    ])
    const result = feedQuestion(start, [
      { kind: 'char', char: 'o' },
      { kind: 'char', char: '中' },
      { kind: 'char', char: '文' },
      { kind: 'char', char: '字' },
      { kind: 'backspace' },
      { kind: 'enter' },
    ])
    assert.equal(result.kind, 'answered')
    if (result.kind !== 'answered') return
    assert.deepEqual(result.answer, { answers: [{ id: 'name', selected: [], custom: '中文' }] })
  })

  it('multi-select other keeps toggled labels and adds custom', () => {
    const start = createQuestionOverlay([
      {
        id: 'mix',
        question: 'Mix?',
        multiSelect: true,
        options: [{ label: 'keep' }, { label: 'drop' }],
      },
    ])
    const result = feedQuestion(start, [
      { kind: 'char', char: ' ' },
      { kind: 'char', char: 'o' },
      { kind: 'char', char: '另' },
      { kind: 'enter' },
    ])
    assert.equal(result.kind, 'answered')
    if (result.kind !== 'answered') return
    assert.deepEqual(result.answer, {
      answers: [{ id: 'mix', selected: ['keep'], custom: '另' }],
    })
  })

  it('a question with no options starts in text input', () => {
    const start = createQuestionOverlay([{ id: 'free', question: 'Say it' }])
    assert.equal(start.mode, 'other')
    const typed = reduceQuestionOverlay(start, { kind: 'char', char: '你' })
    const mid = mustContinueQ(typed)
    assert.equal(mid.draft, '你')
    const done = reduceQuestionOverlay(mid, { kind: 'enter' })
    assert.equal(done.kind, 'answered')
    if (done.kind !== 'answered') return
    assert.deepEqual(done.answer, { answers: [{ id: 'free', selected: [], custom: '你' }] })
  })

  it('empty options array also goes to text input', () => {
    const start = createQuestionOverlay([{ id: 'empty', question: 'Type', options: [] }])
    const result = feedQuestion(start, [
      { kind: 'char', char: '好' },
      { kind: 'enter' },
    ])
    assert.equal(result.kind, 'answered')
    if (result.kind !== 'answered') return
    assert.deepEqual(result.answer, { answers: [{ id: 'empty', selected: [], custom: '好' }] })
  })

  it('escape cancels the whole overlay, including mid-batch', () => {
    const start = createQuestionOverlay(questions)
    assert.equal(reduceQuestionOverlay(start, { kind: 'escape' }).kind, 'cancelled')
    assert.equal(reduceQuestionOverlay(start, { kind: 'ctrl', char: 'c' }).kind, 'cancelled')
    const mid = mustContinueQ(reduceQuestionOverlay(start, { kind: 'enter' }))
    assert.equal(reduceQuestionOverlay(mid, { kind: 'escape' }).kind, 'cancelled')
    const other = mustContinueQ(reduceQuestionOverlay(start, { kind: 'char', char: 'o' }))
    assert.equal(reduceQuestionOverlay(other, { kind: 'escape' }).kind, 'cancelled')
  })
})

describe('slash command palette', () => {
  const commands = [
    { name: 'model', description: 'Switch model', action: 'model' as const },
    { name: 'modes', description: 'All session modes', action: 'modes' as const },
    { name: 'permission', description: 'Switch permission', input: { hint: '<preset>' } },
    { name: 'plan', description: 'Toggle plan mode' },
  ]

  it('filters by prefix, moves, runs, completes, and restores input on escape', () => {
    let state = createCommandPalette(commands, 'mo')
    let result = reduceCommandPalette(state, { kind: 'down' })
    assert.equal(result.kind, 'continue')
    if (result.kind !== 'continue') return
    state = result.state

    result = reduceCommandPalette(state, { kind: 'enter' })
    assert.equal(result.kind, 'run')
    if (result.kind === 'run') assert.equal(result.command.name, 'modes')

    const completed = reduceCommandPalette(createCommandPalette(commands, 'per'), { kind: 'tab' })
    assert.equal(completed.kind, 'complete')
    if (completed.kind === 'complete') assert.equal(completed.command.name, 'permission')

    assert.deepEqual(
      reduceCommandPalette(createCommandPalette(commands, 'pla'), { kind: 'escape' }),
      { kind: 'cancelled', input: '/pla' },
    )
    assert.deepEqual(
      reduceCommandPalette(createCommandPalette(commands), { kind: 'backspace' }),
      { kind: 'cancelled', input: '' },
    )
  })

  it('renders a bottom-anchored, bounded menu with names and descriptions', () => {
    const rect: Rect = { row: 2, col: 5, width: 80, height: 20 }
    const target = new BoundsTarget(rect)
    renderCommandPalette(target, rect, createCommandPalette(commands, 'p'), theme, glyphs)
    const plain = target.puts.map((put) => put.text).join('')
    assert.ok(plain.includes('/permission'))
    assert.ok(plain.includes('Switch permission'))
    const commandRows = target.puts.filter((put) => put.text.includes('/permission'))
    assert.ok(commandRows.every((put) => put.row >= rect.row + rect.height - 8))
  })
})

describe('reducePickerOverlay', () => {
  it('type-to-filter narrows the list; enter picks a model without efforts', () => {
    const start = createPickerOverlay(pickerModels)
    const filtered = feedPicker(start, [
      { kind: 'char', char: 'c' },
      { kind: 'char', char: 'o' },
      { kind: 'char', char: 'd' },
    ])
    const state = mustContinueP(filtered)
    assert.equal(state.filter, 'cod')
    const picked = reducePickerOverlay(state, { kind: 'enter' })
    assert.equal(picked.kind, 'picked')
    if (picked.kind !== 'picked') return
    assert.deepEqual(picked.selection, { provider: 'deepseek', model: 'coder' })
  })

  it('backspace edits the filter', () => {
    const start = createPickerOverlay(pickerModels)
    const typed = mustContinueP(
      feedPicker(start, [
        { kind: 'char', char: 'g' },
        { kind: 'char', char: 'p' },
      ]),
    )
    const trimmed = mustContinueP(reducePickerOverlay(typed, { kind: 'backspace' }))
    assert.equal(trimmed.filter, 'g')
  })

  it('enter on a model with efforts opens a second stage; enter confirms the default', () => {
    const start = createPickerOverlay(pickerModels)
    const stage = reducePickerOverlay(start, { kind: 'enter' })
    const mid = mustContinueP(stage)
    assert.equal(mid.stage, 'efforts')
    assert.equal(mid.effortCursor, 1)
    const picked = reducePickerOverlay(mid, { kind: 'enter' })
    assert.equal(picked.kind, 'picked')
    if (picked.kind !== 'picked') return
    assert.deepEqual(picked.selection, {
      provider: 'deepseek',
      model: 'chat',
      reasoningEffort: 'medium',
    })
  })

  it('prefers the session current effort over the catalog default', () => {
    const models: readonly PickerModel[] = [
      { ...pickerModels[0]!, currentEffort: 'high' },
      ...pickerModels.slice(1),
    ]
    const stage = reducePickerOverlay(createPickerOverlay(models), { kind: 'enter' })
    const state = mustContinueP(stage)
    assert.equal(state.effortCursor, 2)

    const picked = reducePickerOverlay(state, { kind: 'enter' })
    assert.equal(picked.kind, 'picked')
    if (picked.kind !== 'picked') return
    assert.equal(picked.selection.reasoningEffort, 'high')
  })

  it('effort stage down then enter picks a non-default effort', () => {
    const start = createPickerOverlay(pickerModels)
    const mid = mustContinueP(reducePickerOverlay(start, { kind: 'enter' }))
    const moved = mustContinueP(reducePickerOverlay(mid, { kind: 'down' }))
    const picked = reducePickerOverlay(moved, { kind: 'enter' })
    assert.equal(picked.kind, 'picked')
    if (picked.kind !== 'picked') return
    assert.equal(picked.selection.reasoningEffort, 'high')
  })

  it('escape backs out of the effort stage, then cancels', () => {
    const start = createPickerOverlay(pickerModels)
    const mid = mustContinueP(reducePickerOverlay(start, { kind: 'enter' }))
    assert.equal(mid.stage, 'efforts')
    const back = reducePickerOverlay(mid, { kind: 'escape' })
    const models = mustContinueP(back)
    assert.equal(models.stage, 'models')
    assert.equal(reducePickerOverlay(models, { kind: 'escape' }).kind, 'cancelled')
  })
})

function paintAllOverlays(rect: Rect): BoundsTarget {
  const q = createQuestionOverlay([
    {
      id: 'cjk',
      header: '标题标题标题标题标题标题',
      detail: '说明说明说明说明说明说明说明',
      question: '中文问题'.repeat(20),
      multiSelect: true,
      options: [
        { label: '选项甲甲甲甲甲甲甲甲甲甲' },
        { label: '选项乙乙乙乙乙乙乙乙乙乙' },
        { label: '选项丙丙丙丙丙丙丙丙丙丙' },
      ],
    },
    { id: 'free', question: '无选项' },
  ])
  const qOther = mustContinueQ(reduceQuestionOverlay(q, { kind: 'char', char: 'o' }))
  const qTyped = mustContinueQ(reduceQuestionOverlay(qOther, { kind: 'char', char: '测' }))

  let picker = createPickerOverlay([
    ...pickerModels,
    ...Array.from({ length: 24 }, (_, i) => ({
      provider: i % 2 === 0 ? 'deepseek' : 'openai',
      id: `extra-${i}`,
      name: `Extra model ${i}`,
    })),
  ])
  for (let i = 0; i < 18; i++) picker = mustContinueP(reducePickerOverlay(picker, { kind: 'down' }))
  const pickerEfforts = mustContinueP(
    reducePickerOverlay(createPickerOverlay(pickerModels), { kind: 'enter' }),
  )
  const pickerFilter = mustContinueP(
    feedPicker(createPickerOverlay(pickerModels), [
      { kind: 'char', char: 'g' },
      { kind: 'char', char: 'p' },
    ]),
  )

  const target = new BoundsTarget(rect)
  renderQuestionOverlay(target, rect, q, theme, glyphs)
  renderQuestionOverlay(target, rect, qTyped, theme, glyphs)
  renderPickerOverlay(target, rect, picker, theme, glyphs)
  renderPickerOverlay(target, rect, pickerEfforts, theme, glyphs)
  renderPickerOverlay(target, rect, pickerFilter, theme, glyphs)
  renderCommandPalette(target, rect, createCommandPalette([
    { name: 'model', description: 'Switch model', action: 'model' },
    { name: 'permission', description: 'Switch permission', input: { hint: '<preset>' } },
  ]), theme, glyphs)

  const fitted = layoutImageOverlay(rect, '示意图'.repeat(20), {
    preferredColumns: 80,
    preferredRows: 40,
  })
  cellInside(fitted.imageCell, rect)
  rectInside(fitted.panel, rect)
  renderImageOverlayChrome(target, fitted, theme, glyphs)

  const defaulted = layoutImageOverlay(rect, 'plain alt')
  cellInside(defaulted.imageCell, rect)
  renderImageOverlayChrome(target, defaulted, theme, glyphs)
  return target
}

describe('overlay render bounds', () => {
  for (const [columns, rows] of [
    [40, 10],
    [200, 60],
  ] as const) {
    it(`never writes outside a ${columns}x${rows} rect`, () => {
      const rect: Rect = { row: 1, col: 1, width: columns, height: rows }
      assert.doesNotThrow(() => {
        paintAllOverlays(rect)
      })
    })
  }
})

describe('question CJK wrap', () => {
  it('wraps long CJK question text without exceeding the inner width', () => {
    const rect: Rect = { row: 1, col: 1, width: 40, height: 10 }
    const text = '中文测试汉字宽度'.repeat(8)
    const state = createQuestionOverlay([
      { id: 'cjk', question: text, options: [{ label: 'ok' }] },
    ])
    const target = new BoundsTarget(rect)
    renderQuestionOverlay(target, rect, state, theme, glyphs)

    const body = target.puts.filter((p) => p.style === 'TEXT' && /[\u4e00-\u9fff]/.test(p.text))
    assert.ok(body.length >= 2, 'expected the question to wrap onto multiple rows')
    const rows = new Set(body.map((p) => p.row))
    assert.ok(rows.size >= 2, 'expected CJK fragments on more than one row')

    const innerLimit = 38
    for (const p of body) {
      assert.ok(
        stringWidth(p.text) <= innerLimit,
        `"${p.text}" is ${stringWidth(p.text)} cols`,
      )
    }
    for (const p of target.puts) {
      assert.ok(stringWidth(p.text) <= rect.width)
    }
    assert.ok(!target.puts.some((p) => p.text.includes(text)), 'full unwrapped question must not be painted')
  })
})
