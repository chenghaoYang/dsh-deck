/**
 * Modal overlays: ask-user questions, model picker, image chrome.
 *
 * Pure reducers + paint. The app shell owns focus, RPC respond(), and Kitty
 * graphics; this module never writes the terminal except through RenderTarget.
 *
 * One ask_user server-request is one batch — the overlay walks questions
 * sequentially but only the terminal `answered` result is sent back. Esc/Ctrl+C
 * cancel the whole batch through the host response path.
 */

import type { Key } from '../term/input.ts'
import { stringWidth, truncate } from '../term/width.ts'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  CommandDescriptor,
} from '../protocol/contract.ts'
import type { Glyphs, Theme } from './theme.ts'
import type { Rect } from './layout.ts'
import {
  type RenderTarget,
  type Span,
  clearRect,
  clipToWidth,
  fitSpans,
  isSubsequence,
  paintLine,
  repeatToWidth,
  spansWidth,
  wrapLines,
} from './render.ts'

const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' })

const IMAGE_FOOTER = 'esc close · y copy label'

// ---------------------------------------------------------------------------
// Shared panel chrome (help.ts geometry: centered box, theme.border frame,
// title inset on the top rule). Title ink is theme.accent.
// ---------------------------------------------------------------------------

export interface OverlayLine {
  spans: Span[]
}

function centerBox(rect: Rect, width: number, height: number): Rect {
  const w = Math.max(0, Math.min(width, Math.max(0, rect.width)))
  const h = Math.max(0, Math.min(height, Math.max(0, rect.height)))
  return {
    row: rect.row + Math.floor((Math.max(0, rect.height) - h) / 2),
    col: rect.col + Math.floor((Math.max(0, rect.width) - w) / 2),
    width: w,
    height: h,
  }
}

/** Command suggestions belong next to the composer, not in the visual center. */
function bottomBox(rect: Rect, width: number, height: number): Rect {
  const box = centerBox(rect, width, height)
  return { ...box, row: rect.row + Math.max(0, rect.height - box.height) }
}

function putGlyph(
  target: RenderTarget,
  row: number,
  col: number,
  ch: string,
  style: string,
): void {
  const clipped = clipToWidth(ch, 1)
  if (clipped.text.length === 0) return
  target.put(row, col, clipped.text, style)
}

function paintTopRule(
  target: RenderTarget,
  panel: Rect,
  title: string,
  theme: Theme,
  glyphs: Glyphs,
): void {
  const { row, col, width } = panel
  if (width <= 0) return
  putGlyph(target, row, col, glyphs.corner.tl, theme.border)
  if (width === 1) return
  putGlyph(target, row, col + width - 1, glyphs.corner.tr, theme.border)
  const innerW = width - 2
  if (innerW <= 0) return

  const labeled = title.length > 0 ? ` ${title} ` : ''
  const titleW = stringWidth(labeled)
  if (labeled.length > 0 && titleW + 2 <= innerW) {
    const rest = innerW - titleW
    const left = 1
    const right = rest - left
    let x = col + 1
    if (left > 0) {
      target.put(row, x, repeatToWidth(glyphs.hline, left), theme.border)
      x += left
    }
    target.put(row, x, labeled, theme.accent)
    x += titleW
    if (right > 0) target.put(row, x, repeatToWidth(glyphs.hline, right), theme.border)
    return
  }
  if (labeled.length > 0 && titleW <= innerW) {
    const pad = innerW - titleW
    const left = Math.floor(pad / 2)
    const right = pad - left
    let x = col + 1
    if (left > 0) {
      target.put(row, x, repeatToWidth(glyphs.hline, left), theme.border)
      x += left
    }
    target.put(row, x, labeled, theme.accent)
    x += titleW
    if (right > 0) target.put(row, x, repeatToWidth(glyphs.hline, right), theme.border)
    return
  }
  const cut = truncate(title, innerW)
  const cutW = stringWidth(cut)
  if (cutW > 0) target.put(row, col + 1, cut, theme.accent)
  if (cutW < innerW) {
    target.put(row, col + 1 + cutW, repeatToWidth(glyphs.hline, innerW - cutW), theme.border)
  }
}

function paintBottomRule(
  target: RenderTarget,
  panel: Rect,
  theme: Theme,
  glyphs: Glyphs,
): void {
  const { width } = panel
  if (width <= 0 || panel.height < 2) return
  const row = panel.row + panel.height - 1
  putGlyph(target, row, panel.col, glyphs.corner.bl, theme.border)
  if (width === 1) return
  putGlyph(target, row, panel.col + width - 1, glyphs.corner.br, theme.border)
  const innerW = width - 2
  if (innerW > 0) {
    target.put(row, panel.col + 1, repeatToWidth(glyphs.hline, innerW), theme.border)
  }
}

function paintSideRules(
  target: RenderTarget,
  row: number,
  panel: Rect,
  theme: Theme,
  glyphs: Glyphs,
): void {
  if (panel.width <= 0) return
  putGlyph(target, row, panel.col, glyphs.vline, theme.border)
  if (panel.width >= 2) {
    putGlyph(target, row, panel.col + panel.width - 1, glyphs.vline, theme.border)
  }
}

function paintInner(
  target: RenderTarget,
  row: number,
  panel: Rect,
  spans: readonly Span[],
  padStyle: string,
): void {
  const innerW = panel.width - 2
  if (innerW <= 0) return
  const fitted = fitSpans(spans, innerW)
  const used = spansWidth(fitted)
  const padded = used >= innerW ? fitted : [...fitted, { text: ' '.repeat(innerW - used), style: padStyle }]
  paintLine(target, row, panel.col + 1, innerW, { spans: padded })
}

/**
 * Fill and frame a floating panel. The outer transcript rect is left alone so
 * conversation text stays visible around the box.
 */
export function paintFloatingPanel(
  target: RenderTarget,
  panel: Rect,
  theme: Theme,
  glyphs: Glyphs,
  title: string,
  body: readonly OverlayLine[],
  footer: string,
): void {
  if (panel.width <= 0 || panel.height <= 0) return
  clearRect(target, panel, theme.base)
  paintTopRule(target, panel, title, theme, glyphs)
  paintBottomRule(target, panel, theme, glyphs)

  const innerH = Math.max(0, panel.height - 2)
  const innerW = Math.max(0, panel.width - 2)
  const footerRow = innerH >= 1 ? innerH - 1 : -1
  for (let i = 0; i < innerH; i++) {
    const row = panel.row + 1 + i
    paintSideRules(target, row, panel, theme, glyphs)
    if (i === footerRow) {
      if (innerW > 0) {
        paintInner(target, row, panel, [{ text: truncate(footer, innerW), style: theme.dim }], theme.base)
      }
      continue
    }
    const line = body[i]
    if (line !== undefined) paintInner(target, row, panel, line.spans, theme.base)
  }
}

function windowAround(
  lines: readonly OverlayLine[],
  height: number,
  focus: number,
): OverlayLine[] {
  if (height <= 0) return []
  if (lines.length <= height) return lines.slice()
  const at = Math.min(Math.max(0, focus), lines.length - 1)
  let start = at - Math.floor(height / 2)
  const maxStart = lines.length - height
  if (start < 0) start = 0
  if (start > maxStart) start = maxStart
  return lines.slice(start, start + height)
}

function popGrapheme(text: string): string {
  const parts = [...SEGMENTER.segment(text)]
  if (parts.length === 0) return ''
  parts.pop()
  let out = ''
  for (const part of parts) out += part.segment
  return out
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0
  if (index < 0) return 0
  if (index >= length) return length - 1
  return index
}

function isPrintableChar(key: Key): key is { kind: 'char'; char: string } {
  return key.kind === 'char' && key.char.length > 0
}

// ---------------------------------------------------------------------------
// Question overlay
// ---------------------------------------------------------------------------

export interface QuestionOverlayState {
  questions: readonly AskUserQuestionItem[]
  index: number
  answers: readonly AskUserQuestionAnswerItem[]
  mode: 'list' | 'other'
  cursor: number
  /** Option labels toggled in multi-select; kept when `o` opens Other. */
  toggled: readonly string[]
  draft: string
}

export type QuestionOverlayResult =
  | { kind: 'continue'; state: QuestionOverlayState }
  | { kind: 'answered'; answer: AskUserQuestionAnswer }
  | { kind: 'cancelled' }

function questionOptions(question: AskUserQuestionItem | undefined): readonly {
  label: string
  description?: string
}[] {
  const options = question?.options
  if (options === undefined) return []
  return options
}

function beginQuestion(
  questions: readonly AskUserQuestionItem[],
  index: number,
  answers: readonly AskUserQuestionAnswerItem[],
): QuestionOverlayState {
  const options = questionOptions(questions[index])
  return {
    questions,
    index,
    answers,
    mode: options.length === 0 ? 'other' : 'list',
    cursor: 0,
    toggled: [],
    draft: '',
  }
}

export function createQuestionOverlay(
  questions: readonly AskUserQuestionItem[],
): QuestionOverlayState {
  return beginQuestion(questions, 0, [])
}

function answerItem(
  id: string,
  selected: string[],
  custom: string | undefined,
): AskUserQuestionAnswerItem {
  if (custom !== undefined && custom.length > 0) {
    return { id, selected, custom }
  }
  return { id, selected }
}

function selectedLabels(
  question: AskUserQuestionItem,
  toggled: readonly string[],
): string[] {
  const out: string[] = []
  for (const opt of questionOptions(question)) {
    if (toggled.includes(opt.label)) out.push(opt.label)
  }
  return out
}

function commitQuestion(
  state: QuestionOverlayState,
  item: AskUserQuestionAnswerItem,
): QuestionOverlayResult {
  const answers = [...state.answers, item]
  const next = state.index + 1
  if (next >= state.questions.length) {
    return { kind: 'answered', answer: { answers } }
  }
  return { kind: 'continue', state: beginQuestion(state.questions, next, answers) }
}

function reduceQuestionOther(
  state: QuestionOverlayState,
  question: AskUserQuestionItem,
  key: Key,
): QuestionOverlayResult {
  if (key.kind === 'paste') {
    return { kind: 'continue', state: { ...state, draft: state.draft + key.text } }
  }
  if (key.kind === 'backspace') {
    return { kind: 'continue', state: { ...state, draft: popGrapheme(state.draft) } }
  }
  if (isPrintableChar(key)) {
    return { kind: 'continue', state: { ...state, draft: state.draft + key.char } }
  }
  if (key.kind !== 'enter') return { kind: 'continue', state }

  const multi = question.multiSelect === true
  const selected = multi ? selectedLabels(question, state.toggled) : []
  const custom = state.draft.length > 0 ? state.draft : undefined
  return commitQuestion(state, answerItem(question.id, selected, custom))
}

function reduceQuestionList(
  state: QuestionOverlayState,
  question: AskUserQuestionItem,
  key: Key,
): QuestionOverlayResult {
  const options = questionOptions(question)
  const last = options.length - 1
  if (key.kind === 'up') {
    return { kind: 'continue', state: { ...state, cursor: clampIndex(state.cursor - 1, options.length) } }
  }
  if (key.kind === 'down') {
    return { kind: 'continue', state: { ...state, cursor: clampIndex(state.cursor + 1, options.length) } }
  }
  if (key.kind === 'home') {
    return { kind: 'continue', state: { ...state, cursor: 0 } }
  }
  if (key.kind === 'end' && last >= 0) {
    return { kind: 'continue', state: { ...state, cursor: last } }
  }
  if (isPrintableChar(key) && key.char === 'o') {
    return { kind: 'continue', state: { ...state, mode: 'other', draft: '' } }
  }
  if (isPrintableChar(key) && key.char === ' ' && question.multiSelect === true) {
    const opt = options[state.cursor]
    if (opt === undefined) return { kind: 'continue', state }
    const on = state.toggled.includes(opt.label)
    const toggled = on
      ? state.toggled.filter((label) => label !== opt.label)
      : [...state.toggled, opt.label]
    return { kind: 'continue', state: { ...state, toggled } }
  }
  if (key.kind !== 'enter') return { kind: 'continue', state }

  if (question.multiSelect === true) {
    return commitQuestion(state, answerItem(question.id, selectedLabels(question, state.toggled), undefined))
  }
  const opt = options[state.cursor]
  if (opt === undefined) return { kind: 'continue', state }
  return commitQuestion(state, answerItem(question.id, [opt.label], undefined))
}

export function reduceQuestionOverlay(
  state: QuestionOverlayState,
  key: Key,
): QuestionOverlayResult {
  if (key.kind === 'escape' || (key.kind === 'ctrl' && key.char.toLowerCase() === 'c')) {
    return { kind: 'cancelled' }
  }

  const question = state.questions[state.index]
  if (question === undefined) {
    if (key.kind === 'enter') return { kind: 'answered', answer: { answers: [...state.answers] } }
    return { kind: 'continue', state }
  }

  if (state.mode === 'other' || questionOptions(question).length === 0) {
    return reduceQuestionOther({ ...state, mode: 'other' }, question, key)
  }
  return reduceQuestionList(state, question, key)
}

function questionFooter(state: QuestionOverlayState, question: AskUserQuestionItem | undefined): string {
  if (question === undefined || state.mode === 'other' || questionOptions(question).length === 0) {
    return '⏎ ok · esc cancel'
  }
  if (question.multiSelect === true) return 'space toggle · ⏎ confirm · o other · esc'
  return '⏎ pick · o other · esc'
}

function questionBody(
  state: QuestionOverlayState,
  innerW: number,
  theme: Theme,
  glyphs: Glyphs,
): { lines: OverlayLine[]; focus: number } {
  const question = state.questions[state.index]
  const lines: OverlayLine[] = []
  if (question === undefined || innerW <= 0) return { lines, focus: 0 }

  const header = question.header
  if (header !== undefined && header.length > 0) {
    for (const text of wrapLines(header, innerW)) {
      lines.push({ spans: [{ text, style: theme.subtle }] })
    }
  }
  const detail = question.detail
  if (detail !== undefined && detail.length > 0) {
    for (const text of wrapLines(detail, innerW)) {
      lines.push({ spans: [{ text, style: theme.dim }] })
    }
  }
  for (const text of wrapLines(question.question, innerW)) {
    lines.push({ spans: [{ text, style: theme.text }] })
  }

  const options = questionOptions(question)
  const other = state.mode === 'other' || options.length === 0
  if (other) {
    lines.push({ spans: [] })
    const prefix = `${glyphs.arrow} `
    const budget = Math.max(0, innerW - stringWidth(prefix))
    lines.push({
      spans: [
        { text: prefix, style: theme.accent },
        { text: truncate(state.draft, budget), style: theme.text },
      ],
    })
    return { lines, focus: lines.length - 1 }
  }

  if (lines.length > 0) lines.push({ spans: [] })
  let focus = lines.length
  const multi = question.multiSelect === true
  for (let i = 0; i < options.length; i++) {
    const opt = options[i]
    if (opt === undefined) continue
    const selected = i === state.cursor
    if (selected) focus = lines.length
    const mark = selected ? `${glyphs.arrow} ` : '  '
    const checked = state.toggled.includes(opt.label)
    const box = multi ? (checked ? '[x] ' : '[ ] ') : ''
    const prefix = mark + box
    const budget = Math.max(0, innerW - stringWidth(prefix))
    const label = truncate(opt.label, budget)
    const style = selected ? theme.selected : theme.text
    const spans: Span[] = [{ text: mark, style: selected ? theme.accent : theme.dim }]
    if (box.length > 0) spans.push({ text: box, style })
    if (label.length > 0) spans.push({ text: label, style })
    lines.push({ spans })
  }
  return { lines, focus }
}

export function renderQuestionOverlay(
  target: RenderTarget,
  rect: Rect,
  state: QuestionOverlayState,
  theme: Theme,
  glyphs: Glyphs,
): void {
  if (rect.width <= 0 || rect.height <= 0) return
  const boxW = Math.max(4, Math.min(rect.width, 72))
  const innerW = Math.max(1, boxW - 2)
  const { lines, focus } = questionBody(state, innerW, theme, glyphs)
  const total = state.questions.length
  const shown = total === 0 ? 0 : Math.min(state.index + 1, total)
  const title = `question ${shown}/${total}`
  const footer = questionFooter(state, state.questions[state.index])
  const desiredH = Math.min(rect.height, Math.max(4, lines.length + 3))
  const panel = centerBox(rect, boxW, desiredH)
  const bodyH = Math.max(0, panel.height - 3)
  paintFloatingPanel(target, panel, theme, glyphs, title, windowAround(lines, bodyH, focus), footer)
}

// ---------------------------------------------------------------------------
// Read-only information panel
// ---------------------------------------------------------------------------

export interface InfoOverlayState {
  title: string
  lines: readonly string[]
  offset?: number
  footer?: string
}

export function renderInfoOverlay(
  target: RenderTarget,
  rect: Rect,
  state: InfoOverlayState,
  theme: Theme,
  glyphs: Glyphs,
): void {
  if (rect.width <= 0 || rect.height <= 0) return
  const boxW = Math.max(4, Math.min(rect.width, 80))
  const desiredH = Math.min(rect.height, Math.max(5, state.lines.length + 3))
  const panel = centerBox(rect, boxW, desiredH)
  const innerW = Math.max(1, panel.width - 2)
  const bodyH = Math.max(1, panel.height - 3)
  const maxStart = Math.max(0, state.lines.length - bodyH)
  const start = Math.min(Math.max(0, state.offset ?? 0), maxStart)
  const body: OverlayLine[] = []
  for (const line of state.lines.slice(start, start + bodyH)) {
    for (const wrapped of wrapLines(line, innerW)) {
      body.push({ spans: [{ text: wrapped, style: theme.text }] })
    }
  }
  const footer = state.footer !== undefined && state.footer.length > 0
    ? state.footer
    : '↑↓ scroll · ⏎/esc close'
  paintFloatingPanel(target, panel, theme, glyphs, state.title, body, footer)
}

// ---------------------------------------------------------------------------
// Slash-command palette
// ---------------------------------------------------------------------------

export type DeckCommandAction =
  | 'model'
  | 'modes'
  | 'sessions'
  | 'clear'
  | 'rename'
  | 'new'
  | 'fork'
  | 'rewind'
  | 'help'
  | 'quit'
  | 'cancel'
  | 'status'
  | 'cost'
  | 'skills'
  | 'agents'
  | 'workspaces'
  | 'search'
  | 'interrupt-agent'
  | 'queue'
  | 'remove-queued'
  | 'steer-queued'
  | 'dashboard'
  | 'doctor'
  | 'vim'

export interface SlashCommandEntry extends CommandDescriptor {
  /** Deck-local chrome action; absent entries execute through commands/execute. */
  action?: DeckCommandAction
  /** Model-invocable skill; dispatched through session.prompt, not commands/execute. */
  skill?: boolean
}

export interface CommandPaletteState {
  commands: readonly SlashCommandEntry[]
  filter: string
  cursor: number
}

export type CommandPaletteResult =
  | { kind: 'continue'; state: CommandPaletteState }
  | { kind: 'run'; command: SlashCommandEntry }
  | { kind: 'complete'; command: SlashCommandEntry }
  | { kind: 'cancelled'; input: string }

function commandName(command: SlashCommandEntry): string {
  return command.name.replace(/^\/+/, '')
}

function matchingCommands(state: CommandPaletteState): SlashCommandEntry[] {
  const query = state.filter
  return state.commands.filter((command) =>
    isSubsequence(query, commandName(command)) || isSubsequence(query, command.description),
  )
}

export function createCommandPalette(
  commands: readonly SlashCommandEntry[],
  filter = '',
): CommandPaletteState {
  return { commands, filter, cursor: 0 }
}

export function reduceCommandPalette(
  state: CommandPaletteState,
  key: Key,
): CommandPaletteResult {
  if (key.kind === 'escape') return { kind: 'cancelled', input: `/${state.filter}` }
  if (key.kind === 'backspace') {
    if (state.filter.length === 0) return { kind: 'cancelled', input: '' }
    return { kind: 'continue', state: { ...state, filter: popGrapheme(state.filter), cursor: 0 } }
  }
  if (key.kind === 'paste') {
    const text = key.text.replace(/[\r\n]/g, '')
    return { kind: 'continue', state: { ...state, filter: state.filter + text, cursor: 0 } }
  }
  if (isPrintableChar(key)) {
    if (key.char === ' ') {
      const command = matchingCommands(state)[clampIndex(state.cursor, matchingCommands(state).length)]
      return command === undefined ? { kind: 'continue', state } : { kind: 'complete', command }
    }
    return { kind: 'continue', state: { ...state, filter: state.filter + key.char, cursor: 0 } }
  }

  const commands = matchingCommands(state)
  if (key.kind === 'up') {
    return { kind: 'continue', state: { ...state, cursor: clampIndex(state.cursor - 1, commands.length) } }
  }
  if (key.kind === 'down') {
    return { kind: 'continue', state: { ...state, cursor: clampIndex(state.cursor + 1, commands.length) } }
  }
  if (key.kind === 'home') return { kind: 'continue', state: { ...state, cursor: 0 } }
  if (key.kind === 'end') {
    return { kind: 'continue', state: { ...state, cursor: clampIndex(commands.length - 1, commands.length) } }
  }
  const command = commands[clampIndex(state.cursor, commands.length)]
  if (key.kind === 'tab') {
    return command === undefined ? { kind: 'continue', state } : { kind: 'complete', command }
  }
  if (key.kind === 'enter') {
    return command === undefined ? { kind: 'continue', state } : { kind: 'run', command }
  }
  return { kind: 'continue', state }
}

export function renderCommandPalette(
  target: RenderTarget,
  rect: Rect,
  state: CommandPaletteState,
  theme: Theme,
  glyphs: Glyphs,
): void {
  if (rect.width <= 0 || rect.height <= 0) return
  const commands = matchingCommands(state)
  const boxW = Math.max(4, Math.min(rect.width, 76))
  const shownRows = Math.min(commands.length, Math.max(1, Math.min(10, rect.height - 4)))
  const desiredH = Math.min(rect.height, Math.max(5, shownRows + 4))
  const panel = bottomBox(rect, boxW, desiredH)
  const innerW = Math.max(1, panel.width - 2)
  const bodyH = Math.max(0, panel.height - 3)
  const cursor = clampIndex(state.cursor, commands.length)
  const start = commands.length <= bodyH
    ? 0
    : Math.max(0, Math.min(cursor - Math.floor(bodyH / 2), commands.length - bodyH))
  const body: OverlayLine[] = [{ spans: [{ text: truncate(`/${state.filter}`, innerW), style: theme.subtle }] }]
  const listH = Math.max(0, bodyH - 1)
  const visible = commands.slice(start, start + listH)
  if (visible.length === 0 && listH > 0) {
    body.push({ spans: [{ text: '  no matching commands', style: theme.dim }] })
  }
  for (let i = 0; i < visible.length; i++) {
    const command = visible[i]
    if (command === undefined) continue
    const selected = start + i === cursor
    const mark = selected ? `${glyphs.arrow} ` : '  '
    const name = `/${commandName(command)}`
    const prefix = `${mark}${name}`
    const gap = 2
    const descriptionBudget = Math.max(0, innerW - stringWidth(prefix) - gap)
    const spans: Span[] = [
      { text: mark, style: selected ? theme.accent : theme.dim },
      { text: name, style: selected ? theme.selected : theme.text },
    ]
    if (descriptionBudget > 0) {
      spans.push({ text: ' '.repeat(gap), style: '' })
      spans.push({ text: truncate(command.description, descriptionBudget), style: theme.dim })
    }
    body.push({ spans })
  }
  paintFloatingPanel(target, panel, theme, glyphs, 'commands', body, '↑↓ move · ⏎ run · tab complete · esc')
}

// ---------------------------------------------------------------------------
// Model picker
// ---------------------------------------------------------------------------

export interface PickerModel {
  provider: string
  providerName?: string
  id: string
  name?: string
  efforts?: readonly string[]
  defaultEffort?: string
  /** The effort this session is currently using for this model, when known. */
  currentEffort?: string
  current?: boolean
}

export interface PickerOverlayState {
  models: readonly PickerModel[]
  filter: string
  cursor: number
  stage: 'models' | 'efforts'
  effortCursor: number
}

export type PickerOverlayResult =
  | { kind: 'continue'; state: PickerOverlayState }
  | { kind: 'picked'; selection: { provider: string; model: string; reasoningEffort?: string } }
  | { kind: 'cancelled' }

type PickerRow =
  | { kind: 'heading'; text: string }
  | { kind: 'model'; index: number; model: PickerModel }

function modelHaystack(model: PickerModel): string {
  const name = model.name ?? ''
  const providerName = model.providerName ?? ''
  return `${model.provider}/${model.id}/${name} ${providerName}`
}

function groupByProvider(models: readonly PickerModel[]): PickerModel[] {
  const groups = new Map<string, PickerModel[]>()
  const order: string[] = []
  for (const model of models) {
    let list = groups.get(model.provider)
    if (list === undefined) {
      list = []
      groups.set(model.provider, list)
      order.push(model.provider)
    }
    list.push(model)
  }
  const out: PickerModel[] = []
  for (const provider of order) {
    const list = groups.get(provider)
    if (list !== undefined) out.push(...list)
  }
  return out
}

function filteredModels(state: PickerOverlayState): PickerModel[] {
  const matched = state.models.filter((model) => isSubsequence(state.filter, modelHaystack(model)))
  return groupByProvider(matched)
}

function pickerRows(models: readonly PickerModel[]): PickerRow[] {
  const rows: PickerRow[] = []
  let last: string | undefined
  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    if (model === undefined) continue
    if (model.provider !== last) {
      rows.push({ kind: 'heading', text: model.providerName ?? model.provider })
      last = model.provider
    }
    rows.push({ kind: 'model', index: i, model })
  }
  return rows
}

function modelEfforts(model: PickerModel): readonly string[] {
  return model.efforts ?? []
}

function defaultEffortIndex(model: PickerModel): number {
  const efforts = modelEfforts(model)
  const current = model.currentEffort
  if (current !== undefined) {
    const i = efforts.indexOf(current)
    if (i >= 0) return i
  }
  const fallback = model.defaultEffort
  if (fallback !== undefined) {
    const i = efforts.indexOf(fallback)
    if (i >= 0) return i
  }
  return 0
}

function pickModel(model: PickerModel, effort: string | undefined): PickerOverlayResult {
  if (effort !== undefined && effort.length > 0) {
    return {
      kind: 'picked',
      selection: { provider: model.provider, model: model.id, reasoningEffort: effort },
    }
  }
  return { kind: 'picked', selection: { provider: model.provider, model: model.id } }
}

export function createPickerOverlay(models: readonly PickerModel[]): PickerOverlayState {
  const grouped = groupByProvider(models)
  const currentAt = grouped.findIndex((model) => model.current === true)
  return {
    models,
    filter: '',
    cursor: currentAt < 0 ? 0 : currentAt,
    stage: 'models',
    effortCursor: 0,
  }
}

function setFilter(state: PickerOverlayState, filter: string): PickerOverlayState {
  return { ...state, filter, cursor: 0, stage: 'models' }
}

export function reducePickerOverlay(state: PickerOverlayState, key: Key): PickerOverlayResult {
  if (key.kind === 'escape') {
    if (state.stage === 'efforts') {
      return { kind: 'continue', state: { ...state, stage: 'models' } }
    }
    return { kind: 'cancelled' }
  }

  if (state.stage === 'efforts') {
    const models = filteredModels(state)
    const model = models[state.cursor]
    const efforts = model === undefined ? [] : modelEfforts(model)
    if (key.kind === 'up') {
      return { kind: 'continue', state: { ...state, effortCursor: clampIndex(state.effortCursor - 1, efforts.length) } }
    }
    if (key.kind === 'down') {
      return { kind: 'continue', state: { ...state, effortCursor: clampIndex(state.effortCursor + 1, efforts.length) } }
    }
    if (key.kind === 'enter') {
      if (model === undefined) return { kind: 'continue', state }
      const effort = efforts[state.effortCursor]
      if (effort === undefined) return pickModel(model, undefined)
      return pickModel(model, effort)
    }
    return { kind: 'continue', state }
  }

  if (key.kind === 'paste') return { kind: 'continue', state: setFilter(state, state.filter + key.text) }
  if (key.kind === 'backspace') return { kind: 'continue', state: setFilter(state, popGrapheme(state.filter)) }
  if (isPrintableChar(key)) return { kind: 'continue', state: setFilter(state, state.filter + key.char) }

  const models = filteredModels(state)
  if (key.kind === 'up') {
    return { kind: 'continue', state: { ...state, cursor: clampIndex(state.cursor - 1, models.length) } }
  }
  if (key.kind === 'down') {
    return { kind: 'continue', state: { ...state, cursor: clampIndex(state.cursor + 1, models.length) } }
  }
  if (key.kind === 'home') {
    return { kind: 'continue', state: { ...state, cursor: 0 } }
  }
  if (key.kind === 'end') {
    return { kind: 'continue', state: { ...state, cursor: clampIndex(models.length - 1, models.length) } }
  }
  if (key.kind !== 'enter') return { kind: 'continue', state }

  const model = models[state.cursor]
  if (model === undefined) return { kind: 'continue', state }
  const efforts = modelEfforts(model)
  if (efforts.length === 0) return pickModel(model, undefined)
  return {
    kind: 'continue',
    state: { ...state, stage: 'efforts', effortCursor: defaultEffortIndex(model) },
  }
}

function modelLabel(model: PickerModel): string {
  const name = model.name
  if (name !== undefined && name.length > 0) return name
  return model.id
}

function pickerModelBody(
  state: PickerOverlayState,
  innerW: number,
  listH: number,
  theme: Theme,
  glyphs: Glyphs,
): OverlayLine[] {
  const models = filteredModels(state)
  const cursor = clampIndex(state.cursor, models.length)
  const rows = pickerRows(models)
  const focusAt = rows.findIndex((row) => row.kind === 'model' && row.index === cursor)
  let start = 0
  if (rows.length > listH && listH > 0) {
    const at = focusAt < 0 ? 0 : focusAt
    const headingAt = at > 0 && rows[at - 1]?.kind === 'heading' ? at - 1 : at
    start = headingAt
    if (start > rows.length - listH) start = Math.max(0, rows.length - listH)
    if (at >= start + listH) start = at - listH + 1
    if (start < 0) start = 0
  }

  const out: OverlayLine[] = []
  const slice = rows.slice(start, start + Math.max(0, listH))
  for (const row of slice) {
    if (row.kind === 'heading') {
      out.push({ spans: [{ text: truncate(row.text, innerW), style: theme.dim }] })
      continue
    }
    const current = row.model.current === true
    const selected = row.index === cursor
    const bar = current ? glyphs.bar : ' '
    const mark = selected ? `${glyphs.arrow} ` : '  '
    const prefix = `${bar}${mark}`
    const budget = Math.max(0, innerW - stringWidth(prefix))
    const label = truncate(modelLabel(row.model), budget)
    const spans: Span[] = [
      { text: bar, style: current ? theme.accent : theme.dim },
      { text: mark, style: selected ? theme.accent : theme.dim },
    ]
    if (label.length > 0) spans.push({ text: label, style: selected ? theme.selected : theme.text })
    out.push({ spans })
  }
  return out
}

function pickerEffortBody(
  state: PickerOverlayState,
  innerW: number,
  listH: number,
  theme: Theme,
  glyphs: Glyphs,
): OverlayLine[] {
  const models = filteredModels(state)
  const model = models[state.cursor]
  const efforts = model === undefined ? [] : modelEfforts(model)
  const cursor = clampIndex(state.effortCursor, efforts.length)
  const out: OverlayLine[] = []
  if (model !== undefined) {
    const sub = truncate(`${model.provider}/${model.id}`, innerW)
    out.push({ spans: [{ text: sub, style: theme.dim }] })
  }
  const remaining = Math.max(0, listH - out.length)
  let start = 0
  if (efforts.length > remaining && remaining > 0) {
    start = cursor
    if (start > efforts.length - remaining) start = Math.max(0, efforts.length - remaining)
    if (cursor >= start + remaining) start = cursor - remaining + 1
  }
  for (let i = 0; i < remaining; i++) {
    const effort = efforts[start + i]
    if (effort === undefined) break
    const selected = start + i === cursor
    const mark = selected ? `${glyphs.arrow} ` : '  '
    const budget = Math.max(0, innerW - stringWidth(mark))
    out.push({
      spans: [
        { text: mark, style: selected ? theme.accent : theme.dim },
        { text: truncate(effort, budget), style: selected ? theme.selected : theme.text },
      ],
    })
  }
  return out
}

export function renderPickerOverlay(
  target: RenderTarget,
  rect: Rect,
  state: PickerOverlayState,
  theme: Theme,
  glyphs: Glyphs,
): void {
  if (rect.width <= 0 || rect.height <= 0) return
  const models = filteredModels(state)
  const focused = models[state.cursor]
  const rows = state.stage === 'efforts'
    ? 2 + (focused === undefined ? 0 : modelEfforts(focused).length)
    : 1 + pickerRows(models).length
  const boxW = Math.max(4, Math.min(rect.width, 56))
  const desiredH = Math.min(rect.height, Math.max(5, rows + 3))
  const panel = centerBox(rect, boxW, desiredH)
  const innerW = Math.max(1, panel.width - 2)
  const innerH = Math.max(0, panel.height - 2)
  const footer = state.stage === 'efforts'
    ? '↑↓ choose · ⏎ apply model · esc back'
    : '↑↓ choose · ⏎ next · type filter · esc close'
  const title = state.stage === 'efforts' ? 'effort · step 2/2' : 'models · step 1/2'

  const body: OverlayLine[] = []
  if (state.stage === 'models' && innerH >= 3) {
    const filterText = truncate(`/${state.filter}`, innerW)
    body.push({ spans: [{ text: filterText, style: theme.subtle }] })
  }
  const listH = Math.max(0, innerH - 1 - body.length)
  if (state.stage === 'efforts') {
    body.push(...pickerEffortBody(state, innerW, listH, theme, glyphs))
  } else {
    body.push(...pickerModelBody(state, innerW, listH, theme, glyphs))
  }
  paintFloatingPanel(target, panel, theme, glyphs, title, body, footer)
}

// ---------------------------------------------------------------------------
// Rewind overlay — pick a turn to fork from (double-Esc).
// ---------------------------------------------------------------------------

const REWIND_FOOTER = '⏎ fork here · esc cancel'

export interface RewindTurn {
  seq: number
  turn: number
  preview: string
}

export interface RewindOverlayState {
  turns: readonly RewindTurn[]
  cursor: number
}

export type RewindOverlayResult =
  | { kind: 'continue'; state: RewindOverlayState }
  | { kind: 'picked'; seq: number }
  | { kind: 'cancelled' }

export function createRewindOverlay(turns: readonly RewindTurn[]): RewindOverlayState {
  return { turns, cursor: turns.length === 0 ? 0 : turns.length - 1 }
}

export function reduceRewindOverlay(state: RewindOverlayState, key: Key): RewindOverlayResult {
  if (key.kind === 'escape' || (key.kind === 'ctrl' && key.char.toLowerCase() === 'c')) {
    return { kind: 'cancelled' }
  }
  if (key.kind === 'up') {
    return { kind: 'continue', state: { ...state, cursor: clampIndex(state.cursor - 1, state.turns.length) } }
  }
  if (key.kind === 'down' || key.kind === 'tab') {
    return { kind: 'continue', state: { ...state, cursor: clampIndex(state.cursor + 1, state.turns.length) } }
  }
  if (key.kind === 'home') {
    return { kind: 'continue', state: { ...state, cursor: 0 } }
  }
  if (key.kind === 'end') {
    return { kind: 'continue', state: { ...state, cursor: clampIndex(state.turns.length - 1, state.turns.length) } }
  }
  if (key.kind !== 'enter') return { kind: 'continue', state }
  const turn = state.turns[state.cursor]
  if (turn === undefined) return { kind: 'continue', state }
  return { kind: 'picked', seq: turn.seq }
}

function rewindBody(
  state: RewindOverlayState,
  innerW: number,
  theme: Theme,
  glyphs: Glyphs,
): OverlayLine[] {
  const lines: OverlayLine[] = []
  for (let i = 0; i < state.turns.length; i++) {
    const turn = state.turns[i]
    if (turn === undefined) continue
    const selected = i === state.cursor
    const mark = selected ? `${glyphs.arrow} ` : '  '
    const tag = `#${String(turn.turn)} `
    const prefixW = stringWidth(mark) + stringWidth(tag)
    const preview = truncate(turn.preview.replace(/\s+/g, ' ').trim(), Math.max(0, innerW - prefixW))
    const spans: Span[] = [
      { text: mark, style: selected ? theme.accent : theme.dim },
      { text: tag, style: selected ? theme.selected : theme.subtle },
    ]
    if (preview.length > 0) {
      spans.push({ text: preview, style: selected ? theme.selected : theme.text })
    }
    lines.push({ spans })
  }
  return lines
}

export function renderRewindOverlay(
  target: RenderTarget,
  rect: Rect,
  state: RewindOverlayState,
  theme: Theme,
  glyphs: Glyphs,
): void {
  if (rect.width <= 0 || rect.height <= 0) return
  const boxW = Math.max(4, Math.min(rect.width, 72))
  const desiredH = Math.min(rect.height, Math.max(5, state.turns.length + 3))
  const panel = centerBox(rect, boxW, desiredH)
  const innerW = Math.max(1, panel.width - 2)
  const bodyH = Math.max(0, panel.height - 3)
  const lines = rewindBody(state, innerW, theme, glyphs)
  const focus = clampIndex(state.cursor, lines.length)
  paintFloatingPanel(target, panel, theme, glyphs, 'rewind', windowAround(lines, bodyH, focus), REWIND_FOOTER)
}

// ---------------------------------------------------------------------------
// Queue overlay — pending queued/steering messages (edit, remove, steer).
// ---------------------------------------------------------------------------

const QUEUE_LIST_FOOTER = '⏎/e edit · d remove · s steer · esc close'
const QUEUE_EDIT_FOOTER = '⏎ save · esc back'

export interface QueueOverlayItem {
  id: string
  placement: 'queued' | 'steering'
  preview: string
  text: string
}

export interface QueueOverlayState {
  items: readonly QueueOverlayItem[]
  cursor: number
  stage: 'list' | 'edit'
  editDraft: string
}

export type QueueOverlayResult =
  | { kind: 'continue'; state: QueueOverlayState }
  | { kind: 'remove'; id: string; state: QueueOverlayState }
  | { kind: 'steer'; id: string; state: QueueOverlayState }
  | { kind: 'edit'; id: string; text: string; state: QueueOverlayState }
  | { kind: 'cancelled' }

export function createQueueOverlay(items: readonly QueueOverlayItem[]): QueueOverlayState {
  return { items, cursor: 0, stage: 'list', editDraft: '' }
}

export function updateQueueOverlayItems(
  state: QueueOverlayState,
  items: readonly QueueOverlayItem[],
): QueueOverlayState {
  const current = state.items[state.cursor]
  const at = current === undefined ? -1 : items.findIndex((item) => item.id === current.id)
  const cursor = clampIndex(at < 0 ? state.cursor : at, items.length)
  if (state.stage === 'edit') {
    const editingId = current?.id
    if (editingId === undefined || !items.some((item) => item.id === editingId)) {
      return { items, cursor, stage: 'list', editDraft: '' }
    }
  }
  return { ...state, items, cursor }
}

export function reduceQueueOverlay(state: QueueOverlayState, key: Key): QueueOverlayResult {
  if (state.stage === 'edit') return reduceQueueEdit(state, key)

  if (key.kind === 'escape' || (key.kind === 'ctrl' && key.char.toLowerCase() === 'c')) {
    return { kind: 'cancelled' }
  }
  if (key.kind === 'up') {
    return { kind: 'continue', state: { ...state, cursor: clampIndex(state.cursor - 1, state.items.length) } }
  }
  if (key.kind === 'down' || key.kind === 'tab') {
    return { kind: 'continue', state: { ...state, cursor: clampIndex(state.cursor + 1, state.items.length) } }
  }
  if (key.kind === 'home') {
    return { kind: 'continue', state: { ...state, cursor: 0 } }
  }
  if (key.kind === 'end') {
    return { kind: 'continue', state: { ...state, cursor: clampIndex(state.items.length - 1, state.items.length) } }
  }

  const item = state.items[state.cursor]
  if (key.kind === 'enter' || (isPrintableChar(key) && key.char === 'e')) {
    if (item === undefined) return { kind: 'continue', state }
    return { kind: 'continue', state: { ...state, stage: 'edit', editDraft: item.text } }
  }
  if (key.kind === 'backspace' || key.kind === 'delete' || (isPrintableChar(key) && key.char === 'd')) {
    if (item === undefined) return { kind: 'continue', state }
    return { kind: 'remove', id: item.id, state }
  }
  if (isPrintableChar(key) && key.char === 's') {
    if (item === undefined) return { kind: 'continue', state }
    return { kind: 'steer', id: item.id, state }
  }
  return { kind: 'continue', state }
}

function reduceQueueEdit(state: QueueOverlayState, key: Key): QueueOverlayResult {
  if (key.kind === 'escape') {
    return { kind: 'continue', state: { ...state, stage: 'list', editDraft: '' } }
  }
  if (key.kind === 'paste') {
    return { kind: 'continue', state: { ...state, editDraft: state.editDraft + key.text } }
  }
  if (key.kind === 'backspace') {
    return { kind: 'continue', state: { ...state, editDraft: popGrapheme(state.editDraft) } }
  }
  if (isPrintableChar(key)) {
    return { kind: 'continue', state: { ...state, editDraft: state.editDraft + key.char } }
  }
  if (key.kind !== 'enter') return { kind: 'continue', state }

  const item = state.items[state.cursor]
  if (item === undefined) {
    return { kind: 'continue', state: { ...state, stage: 'list', editDraft: '' } }
  }
  const text = state.editDraft.trim()
  if (text.length === 0) return { kind: 'continue', state }
  return {
    kind: 'edit',
    id: item.id,
    text,
    state: { ...state, stage: 'list', editDraft: '' },
  }
}

function queuePlacementTag(placement: QueueOverlayItem['placement']): string {
  return placement === 'steering' ? 'steer ' : 'queued '
}

function queueBody(
  state: QueueOverlayState,
  innerW: number,
  theme: Theme,
  glyphs: Glyphs,
): OverlayLine[] {
  const lines: OverlayLine[] = []
  if (state.items.length === 0) {
    lines.push({ spans: [{ text: 'no pending messages', style: theme.dim }] })
    return lines
  }
  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i]
    if (item === undefined) continue
    const selected = i === state.cursor
    const mark = selected ? `${glyphs.arrow} ` : '  '
    const tag = queuePlacementTag(item.placement)
    const raw = state.stage === 'edit' && selected
      ? state.editDraft
      : item.preview.replace(/\s+/g, ' ').trim()
    const prefixW = stringWidth(mark) + stringWidth(tag)
    const preview = truncate(raw, Math.max(0, innerW - prefixW))
    const spans: Span[] = [
      { text: mark, style: selected ? theme.accent : theme.dim },
      { text: tag, style: selected ? theme.selected : theme.subtle },
    ]
    if (preview.length > 0) {
      spans.push({ text: preview, style: selected ? theme.selected : theme.text })
    }
    lines.push({ spans })
  }
  return lines
}

export function renderQueueOverlay(
  target: RenderTarget,
  rect: Rect,
  state: QueueOverlayState,
  theme: Theme,
  glyphs: Glyphs,
): void {
  if (rect.width <= 0 || rect.height <= 0) return
  const boxW = Math.max(4, Math.min(rect.width, 72))
  const desiredH = Math.min(rect.height, Math.max(5, state.items.length + 3))
  const panel = centerBox(rect, boxW, desiredH)
  const innerW = Math.max(1, panel.width - 2)
  const bodyH = Math.max(0, panel.height - 3)
  const lines = queueBody(state, innerW, theme, glyphs)
  const focus = clampIndex(state.cursor, lines.length)
  const footer = state.stage === 'edit' ? QUEUE_EDIT_FOOTER : QUEUE_LIST_FOOTER
  paintFloatingPanel(target, panel, theme, glyphs, 'queue', windowAround(lines, bodyH, focus), footer)
}

// ---------------------------------------------------------------------------
// Image overlay — layout + chrome only. Kitty APC is the app's job.
// ---------------------------------------------------------------------------

export interface ImageOverlayLayout {
  panel: Rect
  imageCell: { row: number; col: number; columns: number; rows: number }
  title: string
  footer: string
}

function clampInt(n: number, min: number, max: number): number {
  if (n < min) return min
  if (n > max) return max
  return n
}

function clampCellToRect(
  cell: { row: number; col: number; columns: number; rows: number },
  rect: Rect,
): { row: number; col: number; columns: number; rows: number } {
  if (rect.width <= 0 || rect.height <= 0) {
    return { row: rect.row, col: rect.col, columns: 1, rows: 1 }
  }
  const row = clampInt(cell.row, rect.row, rect.row + rect.height - 1)
  const col = clampInt(cell.col, rect.col, rect.col + rect.width - 1)
  const maxCols = rect.col + rect.width - col
  const maxRows = rect.row + rect.height - row
  return {
    row,
    col,
    columns: clampInt(cell.columns, 1, Math.max(1, maxCols)),
    rows: clampInt(cell.rows, 1, Math.max(1, maxRows)),
  }
}

export function layoutImageOverlay(
  rect: Rect,
  alt: string,
  opts?: { preferredColumns?: number; preferredRows?: number },
): ImageOverlayLayout {
  const maxImgCols = Math.max(1, rect.width - 2)
  const maxImgRows = Math.max(1, rect.height - 3)
  const wantCols = opts?.preferredColumns
  const wantRows = opts?.preferredRows
  const imgCols = clampInt(wantCols ?? maxImgCols, 1, maxImgCols)
  const imgRows = clampInt(wantRows ?? maxImgRows, 1, maxImgRows)

  const panelW = Math.max(1, Math.min(rect.width, imgCols + 2))
  const panelH = Math.max(1, Math.min(rect.height, imgRows + 3))
  const panel = centerBox(rect, panelW, panelH)

  const hasSides = panel.width >= 3
  const hasTop = panel.height >= 2
  const bottomChrome = panel.height >= 4 ? 2 : panel.height >= 3 ? 1 : 0
  const rawCell = {
    row: panel.row + (hasTop ? 1 : 0),
    col: panel.col + (hasSides ? 1 : 0),
    columns: Math.max(1, panel.width - (hasSides ? 2 : 0)),
    rows: Math.max(1, panel.height - (hasTop ? 1 : 0) - bottomChrome),
  }
  const imageCell = clampCellToRect(rawCell, rect)
  const innerW = Math.max(0, panel.width - 2)
  const title = innerW > 0 ? truncate(alt, innerW) : truncate(alt, Math.max(1, panel.width))
  const footer = innerW > 0 ? truncate(IMAGE_FOOTER, innerW) : IMAGE_FOOTER
  return { panel, imageCell, title, footer }
}

export function renderImageOverlayChrome(
  target: RenderTarget,
  layout: ImageOverlayLayout,
  theme: Theme,
  glyphs: Glyphs,
): void {
  const { panel } = layout
  if (panel.width <= 0 || panel.height <= 0) return
  clearRect(target, panel, theme.base)
  paintTopRule(target, panel, layout.title, theme, glyphs)
  paintBottomRule(target, panel, theme, glyphs)

  const innerH = Math.max(0, panel.height - 2)
  const footerRow = innerH >= 1 ? innerH - 1 : -1
  for (let i = 0; i < innerH; i++) {
    const row = panel.row + 1 + i
    paintSideRules(target, row, panel, theme, glyphs)
    if (i === footerRow) {
      paintInner(target, row, panel, [{ text: layout.footer, style: theme.dim }], theme.base)
    }
  }
}
