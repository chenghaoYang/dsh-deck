/**
 * Headless frame renderer.
 *
 * A TUI is hard to iterate on when the only way to see it is to run it, and
 * impossible to diff in review. This paints one frame into a character grid and
 * writes it to stdout, so the layout can be inspected, pasted into a README, or
 * asserted against.
 *
 *   node --experimental-strip-types src/dev/preview.ts
 *   node --experimental-strip-types src/dev/preview.ts --width 100 --height 30 --plain
 *   node --experimental-strip-types src/dev/preview.ts --attach http://127.0.0.1:3080
 */

import { parseArgs } from 'node:util'
import { DeckClient } from '../protocol/client.ts'
import type { HistoryEntry, HostDescription, SessionSummary } from '../protocol/contract.ts'
import { emptyTranscript, type TranscriptItem, type TranscriptState } from '../model/fold.ts'
import { DeckStore, type SessionState } from '../model/store.ts'
import { detectCapabilities } from '../term/capabilities.ts'
import { stringWidth } from '../term/width.ts'
import { RESET } from '../term/ansi.ts'
import { createGlyphs, createTheme, type Glyphs, type Theme } from '../ui/theme.ts'
import { computeLayout } from '../ui/layout.ts'
import type { RenderTarget } from '../ui/render.ts'
import { layoutTranscript, renderTranscript } from '../ui/transcript.ts'
import { renderSidebar } from '../ui/sidebar.ts'
import { renderComposer } from '../ui/composer.ts'
import { renderFooter, renderHeader } from '../ui/statusbar.ts'

interface GridCell { char: string; style: string }

/** A RenderTarget that accumulates into a grid instead of writing escapes. */
class GridTarget implements RenderTarget {
  private readonly cells: GridCell[][]
  private readonly columns: number
  private readonly rows: number

  constructor(columns: number, rows: number) {
    this.columns = columns
    this.rows = rows
    this.cells = Array.from({ length: rows }, () =>
      Array.from({ length: columns }, () => ({ char: ' ', style: '' })))
  }

  put(row: number, col: number, text: string, style = ''): void {
    if (row < 1 || row > this.rows) return
    const line = this.cells[row - 1]
    if (line === undefined) return
    let cursor = col
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
    for (const { segment } of segmenter.segment(text)) {
      const width = stringWidth(segment)
      if (cursor > this.columns) break
      if (cursor >= 1) {
        const cell = line[cursor - 1]
        if (cell !== undefined) { cell.char = segment; cell.style = style }
        if (width === 2) {
          const next = line[cursor]
          // Continuation cell: blanked so the wide glyph is not double-drawn.
          if (next !== undefined) { next.char = ''; next.style = style }
        }
      }
      cursor += width === 0 ? 1 : width
    }
  }

  fill(row: number, col: number, width: number, height: number, char = ' ', style = ''): void {
    for (let r = row; r < row + height; r += 1) {
      this.put(r, col, char.repeat(Math.max(0, width)), style)
    }
  }

  toString(plain: boolean): string {
    const out: string[] = []
    for (const line of this.cells) {
      let text = ''
      let current = ''
      for (const cell of line) {
        if (cell.char === '') continue
        if (!plain && cell.style !== current) {
          text += cell.style === '' ? RESET : cell.style
          current = cell.style
        }
        text += cell.char
      }
      if (!plain && current !== '') text += RESET
      out.push(text.replace(/\s+$/, plain ? '' : ''))
    }
    return out.join('\n')
  }
}

function transcriptOf(items: TranscriptItem[]): TranscriptState {
  return { ...emptyTranscript(), items, lastSeq: items.length }
}

function syntheticSessions(): SessionState[] {
  const base: Pick<SessionState, 'historyLoaded' | 'hasMoreHistory' | 'queue' | 'unread' | 'blank'> = {
    historyLoaded: true,
    hasMoreHistory: false,
    queue: [],
    unread: 0,
    blank: false,
  }

  const focused: SessionState = {
    ...base,
    id: 'session-1',
    title: 'refactor the auth module',
    cwd: '/Users/you/code/api',
    running: true,
    updatedAt: Date.now(),
    transcript: transcriptOf([
      { kind: 'user', seq: 1, time: Date.now(), text: 'Refactor the auth module to use JWT instead of session lookups, and update the tests.' },
      { kind: 'reasoning', seq: 2, turn: 1, step: 1, streaming: false, text: 'The user wants JWT.\nI should read the current auth code first.\nThen find every call site.\nThen update the tests.' },
      { kind: 'assistant', seq: 3, turn: 1, step: 1, streaming: false, text: "I'll start by reading the current auth code, then replace the session lookup with token verification." },
      {
        kind: 'tool',
        seq: 4,
        turn: 1,
        step: 1,
        call: {
          callId: 'c1',
          name: 'bash',
          argumentsRaw: '{"command":"ls -la src/auth"}',
          args: { command: 'ls -la src/auth' },
          status: 'ok',
          resultText: 'session.ts\ntoken.ts\nmiddleware.ts\nindex.ts',
        },
      },
      {
        kind: 'tool',
        seq: 5,
        turn: 1,
        step: 2,
        call: {
          callId: 'c2',
          name: 'str_replace_editor',
          argumentsRaw: '{"command":"str_replace","path":"src/auth/session.ts"}',
          args: { command: 'str_replace', path: 'src/auth/session.ts' },
          status: 'awaiting-approval',
        },
      },
      { kind: 'assistant', seq: 6, turn: 1, step: 2, streaming: true, text: 'Waiting on that edit before I continue with the middleware' },
    ]),
  }

  const blocked: SessionState = {
    ...base,
    id: 'session-2',
    title: '迁移数据库到 Postgres',
    cwd: '/Users/you/code/db',
    running: false,
    updatedAt: Date.now() - 60_000,
    unread: 1,
    pendingApproval: { rpcId: 'r1', approvalId: 'a1', toolName: 'bash', at: Date.now(), reason: 'writes outside the workspace' },
    transcript: transcriptOf([
      { kind: 'user', seq: 1, time: Date.now(), text: '把数据库迁移到 Postgres，并保留现有数据。' },
    ]),
  }

  const idle: SessionState = {
    ...base,
    id: 'session-3',
    title: 'write the release notes',
    cwd: '/Users/you/code/api',
    running: false,
    updatedAt: Date.now() - 600_000,
    transcript: transcriptOf([]),
  }

  const failed: SessionState = {
    ...base,
    id: 'session-4',
    title: 'benchmark the parser',
    cwd: '/Users/you/code/parser',
    running: false,
    updatedAt: Date.now() - 900_000,
    lastError: 'rate limited',
    transcript: transcriptOf([]),
  }

  return [focused, blocked, idle, failed]
}

/**
 * Real mode goes through DeckStore rather than folding by hand, so the preview
 * shows what the app shows — including titles, which the store derives from
 * `session/title` events during history replay.
 */
async function realSessions(baseUrl: string): Promise<{ sessions: SessionState[]; host: HostDescription | undefined }> {
  const client = new DeckClient({ baseUrl })
  const described = await client.call('host.describe', {})
  const listed = await client.call('session.list', {})
  if (!listed.ok) throw new Error(`session.list: ${listed.error.message}`)
  const store = new DeckStore()
  const items = listed.value.items as SessionSummary[]
  store.applySessionList(items)
  for (const summary of items.slice(0, 8)) {
    const history = await client.call('session.history', { sessionId: summary.sessionId, maxMessages: 40 })
    const entries: readonly HistoryEntry[] = history.ok ? history.value.events : []
    store.applyHistoryPage(summary.sessionId, entries, history.ok ? history.value.hasMore : false)
    const projections = history.ok ? history.value.projections : undefined
    if (projections !== undefined) {
      for (const [key, value] of Object.entries(projections.values)) {
        store.applyMux(
          { type: 'session/projection', sessionId: summary.sessionId, key, value, seq: projections.asOfSeq },
          crypto.randomUUID(),
        )
      }
    }
  }
  return { sessions: [...store.sessions], host: described.ok ? described.value : undefined }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      width: { type: 'string', default: '120' },
      height: { type: 'string', default: '34' },
      plain: { type: 'boolean', default: false },
      attach: { type: 'string' },
      draft: { type: 'string', default: 'also update the integration tests' },
    },
  })
  const columns = Number(values.width)
  const rows = Number(values.height)
  const plain = values.plain === true

  const caps = detectCapabilities({ ...process.env, ...plain ? { NO_COLOR: '1' } : {} })
  const theme: Theme = createTheme(caps, plain ? { NO_COLOR: '1' } : process.env)
  const glyphs: Glyphs = createGlyphs(process.env)

  let sessions: SessionState[]
  let host: HostDescription | undefined
  if (values.attach !== undefined) {
    const real = await realSessions(values.attach)
    sessions = real.sessions
    host = real.host
  } else {
    sessions = syntheticSessions()
    host = {
      version: '0.0.1',
      cwd: '/Users/you/code/api',
      provider: 'nvidia',
      model: 'openai/gpt-oss-120b',
      attachedSessions: sessions.length,
      home: '/Users/you',
      canOpenPath: true,
    }
  }

  const focused = sessions[0]
  const layout = computeLayout(columns, rows, { composerHeight: 1 })
  const target = new GridTarget(columns, rows)

  renderHeader(target, {
    rect: layout.header,
    host,
    connection: 'ready',
    sessionTitle: focused?.title,
    theme,
    glyphs,
  })
  if (layout.sidebar !== undefined) {
    renderSidebar(target, {
      rect: layout.sidebar,
      sessions,
      focusedId: focused?.id,
      theme,
      glyphs,
      spinnerFrame: 3,
    })
    for (let row = layout.sidebar.row; row < layout.sidebar.row + layout.sidebar.height; row += 1) {
      target.put(row, layout.sidebar.width + 1, glyphs.vline, theme.border)
    }
  }
  const lines = focused === undefined ? [] : layoutTranscript(focused.transcript.items, {
    width: layout.transcript.width,
    theme,
    glyphs,
    spinnerFrame: 3,
    expandTools: false,
  })
  renderTranscript(target, { rect: layout.transcript, lines, scrollOffset: 0, theme })
  target.fill(layout.composer.row - 1, 1, columns, 1, glyphs.hline, theme.border)
  renderComposer(target, {
    rect: layout.composer,
    draft: values.draft ?? '',
    cursor: (values.draft ?? '').length,
    mode: 'queue',
    busy: focused?.running ?? false,
    theme,
    glyphs,
  })
  renderFooter(target, {
    rect: layout.footer,
    hints: sessions.some((s) => s.pendingApproval !== undefined)
      ? [{ key: 'a', label: 'allow' }, { key: 'r', label: 'reject' }]
      : [
        { key: 'tab', label: 'switch' },
        { key: '^n', label: 'new' },
        { key: '^c', label: 'cancel' },
        { key: '^g', label: 'help' },
      ],
    message: undefined,
    theme,
  })

  process.stdout.write(`${target.toString(plain)}\n`)
}

await main()
