import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DeckApp } from '../src/ui/app.ts'
import type { Key } from '../src/term/input.ts'
import { computeLayout } from '../src/ui/layout.ts'

interface FakeScreen {
  columns: number
  rows: number
  begin(): void
  end(): void
  put(...args: unknown[]): void
  fill(...args: unknown[]): void
  showCursorAt(row: number, col: number): void
  hideCursor(): void
  close(): void
}

interface AppInternals {
  draft: string
  cursor: number
  overlay?: unknown
  stopped: boolean
  screen: FakeScreen
  term: {
    progress(...args: unknown[]): void
    title(...args: unknown[]): void
    dispose(): void
  }
  insert(text: string): void
  onKey(key: Key): void
  render(): void
  quit(): Promise<void>
}

function internals(app: DeckApp): AppInternals {
  return app as unknown as AppInternals
}

function appView(): AppInternals {
  const app = new DeckApp({ baseUrl: 'http://127.0.0.1:1', cwd: process.cwd(), printOnExit: false })
  const view = internals(app)
  // Keep these pure editor tests from scheduling frame timers or writing ANSI
  // title/progress sequences through the real process streams.
  view.stopped = true
  return view
}

describe('DeckApp grapheme editing', () => {
  it('moves left/right and backspaces a combining cluster as one character', () => {
    const view = appView()
    const sample = 'a\u0301'
    view.insert(sample)
    const end = [...sample].length
    assert.equal(view.cursor, end)

    view.onKey({ kind: 'left' })
    assert.equal(view.cursor, 0)
    view.onKey({ kind: 'right' })
    assert.equal(view.cursor, end)
    view.onKey({ kind: 'backspace' })
    assert.equal(view.draft, '')
    assert.equal(view.cursor, 0)
  })

  it('never splits a ZWJ family emoji while moving or deleting a word', () => {
    const view = appView()
    const family = '👨‍👩‍👧‍👦'
    view.insert(`x${family}y`)
    const familyEnd = 1 + [...family].length

    view.onKey({ kind: 'left' })
    assert.equal(view.cursor, familyEnd)
    view.onKey({ kind: 'left' })
    assert.equal(view.cursor, 1)
    view.onKey({ kind: 'right' })
    assert.equal(view.cursor, familyEnd)
    view.onKey({ kind: 'backspace' })
    assert.equal(view.draft, 'xy')

    view.draft = `go ${family} now`
    view.cursor = [...view.draft].length
    view.onKey({ kind: 'ctrl', char: 'w' })
    assert.equal(view.draft, `go ${family} `)
    view.onKey({ kind: 'ctrl', char: 'w' })
    assert.equal(view.draft, 'go ')
  })
})

describe('DeckApp caret visibility', () => {
  it('shows the composer caret only without an overlay and restores it after closing one', async () => {
    const view = appView()
    const shown: { row: number; col: number }[] = []
    let hidden = 0
    let closed = 0
    view.screen = {
      columns: 80,
      rows: 24,
      begin() {},
      end() {},
      put() {},
      fill() {},
      showCursorAt(row, col) { shown.push({ row, col }) },
      hideCursor() { hidden += 1 },
      close() { closed += 1 },
    }
    view.term = {
      progress() {},
      title() {},
      dispose() {},
    }
    view.draft = 'hello'
    view.cursor = 2
    view.render()

    const layout = computeLayout(80, 24, { composerHeight: 1 })
    assert.deepEqual(shown[0], { row: layout.composer.row, col: layout.composer.col + 2 })
    assert.equal(hidden, 0)

    view.overlay = { kind: 'image', alt: 'test', data: new Uint8Array(), transmitted: true }
    view.render()
    assert.equal(hidden, 1)

    view.overlay = undefined
    view.render()
    assert.deepEqual(shown[1], { row: layout.composer.row, col: layout.composer.col + 2 })

    view.stopped = false
    await view.quit()
    assert.equal(closed, 1)
  })
})
