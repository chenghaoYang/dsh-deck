import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { afterEach, describe, it } from 'node:test'
import { beginSync, cursorTo, endSync, hideCursor, restoreTerminal, showCursor } from '../src/term/ansi.ts'
import type { TerminalCapabilities } from '../src/term/capabilities.ts'
import { InputReader, type Key } from '../src/term/input.ts'
import { Screen } from '../src/term/screen.ts'

function caps(over: Partial<TerminalCapabilities> = {}): TerminalCapabilities {
  return {
    isGhostty: true,
    trueColor: true,
    hyperlinks: true,
    kittyGraphics: true,
    notifications: true,
    progress: true,
    clipboard: true,
    syncOutput: true,
    unicodeCore: true,
    ...over,
  }
}

function fakeOut(columns = 40, rows = 8) {
  let data = ''
  const stream = {
    columns,
    rows,
    isTTY: false,
    write(chunk: string | Uint8Array) {
      data += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      return true
    },
    on() {
      return stream
    },
    removeListener() {
      return stream
    },
  }
  return {
    stream: stream as unknown as NodeJS.WriteStream,
    get output() {
      return data
    },
    clear() {
      data = ''
    },
  }
}

const openScreens: Screen[] = []
afterEach(() => {
  while (openScreens.length > 0) openScreens.pop()?.close()
})

describe('screen', () => {
  it('a double-width character occupies two cells; continuation is never flushed', () => {
    const out = fakeOut()
    const screen = new Screen(out.stream, caps({ syncOutput: false }))
    openScreens.push(screen)
    screen.open()
    out.clear()
    screen.begin()
    screen.put(1, 1, '中X')
    screen.end()
    assert.ok(out.output.includes('中'))
    assert.ok(out.output.includes('X'))
    assert.ok(out.output.includes(cursorTo(1, 1)))
    // Continuation column is never addressed; X rides the cursor after the wide cell.
    assert.ok(!out.output.includes(cursorTo(1, 2)))
    assert.ok(out.output.includes(`${cursorTo(1, 1)}中X`) || out.output.includes('中X'))
  })

  it('diff emits only the changed cell with the right cursor address', () => {
    const out = fakeOut()
    const screen = new Screen(out.stream, caps({ syncOutput: false }))
    openScreens.push(screen)
    screen.open()
    screen.begin()
    screen.put(1, 1, 'Hello')
    screen.end()
    out.clear()
    screen.begin()
    screen.put(1, 1, 'Hallo')
    screen.end()
    assert.ok(out.output.includes(cursorTo(1, 2)), out.output)
    assert.ok(out.output.includes('a'))
    assert.ok(!out.output.includes('Hello'))
    assert.ok(!out.output.includes('Hallo'))
    assert.ok(out.output.length < 24, `flush too large: ${JSON.stringify(out.output)}`)
  })

  it('flushes are wrapped in DECSET 2026 when syncOutput is set', () => {
    const out = fakeOut()
    const screen = new Screen(out.stream, caps({ syncOutput: true }))
    openScreens.push(screen)
    screen.open()
    out.clear()
    screen.begin()
    screen.put(1, 1, 'ok')
    screen.end()
    assert.ok(out.output.startsWith(beginSync()))
    assert.ok(out.output.endsWith(endSync()))
    assert.ok(out.output.includes('ok'))
  })

  it('close() restore string is complete and close is idempotent', () => {
    const out = fakeOut()
    const screen = new Screen(out.stream, caps())
    openScreens.push(screen)
    screen.open()
    assert.ok(out.output.includes('\u001b[?1002h'))
    assert.ok(out.output.includes('\u001b[?1006h'))
    out.clear()
    screen.close()
    const first = out.output
    assert.ok(first.includes('\u001b[?25h'))
    assert.ok(first.includes('\u001b[?1049l'))
    assert.ok(first.includes('\u001b[0m'))
    assert.ok(first.includes('\u001b]9;4;0;0\u001b\\'))
    assert.ok(first.includes('\u001b[?1002l'))
    assert.ok(first.includes('\u001b[?1006l'))
    for (const part of [
      '\u001b[?25h',
      '\u001b[?1049l',
      '\u001b[0m',
      '\u001b]9;4;0;0\u001b\\',
    ]) {
      assert.ok(restoreTerminal().includes(part))
    }
    screen.close()
    assert.equal(out.output, first)
  })

  it('setMouse writes DECSET/DECRST 1002+1006; close always disables', () => {
    const out = fakeOut()
    const screen = new Screen(out.stream, caps())
    openScreens.push(screen)
    const dump = (): string => out.output
    screen.setMouse(true)
    assert.equal(dump(), '')
    screen.open()
    out.clear()
    screen.setMouse(true)
    assert.equal(dump(), '')
    screen.setMouse(false)
    assert.equal(dump(), '\u001b[?1002l\u001b[?1006l')
    out.clear()
    screen.setMouse(false)
    assert.equal(dump(), '')
    screen.setMouse(true)
    assert.equal(dump(), '\u001b[?1002h\u001b[?1006h')
    out.clear()
    screen.close()
    const restored = dump()
    assert.ok(restored.includes('\u001b[?1002l'))
    assert.ok(restored.includes('\u001b[?1006l'))
    screen.close()
    assert.equal(dump(), restored)
    out.clear()
    screen.setMouse(true)
    assert.equal(dump(), '')
  })

  it('positions the application caret after every frame and toggles visibility', () => {
    const out = fakeOut()
    const screen = new Screen(out.stream, caps())
    openScreens.push(screen)
    screen.open()
    out.clear()

    screen.showCursorAt(3, 5)
    assert.equal(out.output, cursorTo(3, 5) + showCursor())
    out.clear()
    screen.showCursorAt(3, 5)
    assert.equal(out.output, cursorTo(3, 5))

    out.clear()
    screen.hideCursor()
    assert.equal(out.output, hideCursor())
    out.clear()
    screen.showCursorAt(3, 5)
    assert.equal(out.output, cursorTo(3, 5) + showCursor())

    out.clear()
    screen.close()
    assert.ok(out.output.includes(showCursor()))
  })

  it('hooks exit, SIGINT, SIGTERM, SIGHUP, and uncaughtException, and unhooks on close', () => {
    const out = fakeOut()
    const screen = new Screen(out.stream, caps())
    const before = {
      exit: process.listeners('exit').length,
      SIGINT: process.listeners('SIGINT').length,
      SIGTERM: process.listeners('SIGTERM').length,
      SIGHUP: process.listeners('SIGHUP').length,
      uncaughtException: process.listeners('uncaughtException').length,
      uncaughtExceptionMonitor: process.listeners('uncaughtExceptionMonitor').length,
    }
    screen.open()
    assert.equal(process.listeners('exit').length, before.exit + 1)
    assert.equal(process.listeners('SIGINT').length, before.SIGINT + 1)
    assert.equal(process.listeners('SIGTERM').length, before.SIGTERM + 1)
    assert.equal(process.listeners('SIGHUP').length, before.SIGHUP + 1)
    assert.equal(process.listeners('uncaughtException').length, before.uncaughtException + 1)
    assert.equal(
      process.listeners('uncaughtExceptionMonitor').length,
      before.uncaughtExceptionMonitor + 1,
    )
    screen.close()
    assert.equal(process.listeners('exit').length, before.exit)
    assert.equal(process.listeners('SIGINT').length, before.SIGINT)
    assert.equal(process.listeners('SIGTERM').length, before.SIGTERM)
    assert.equal(process.listeners('SIGHUP').length, before.SIGHUP)
    assert.equal(process.listeners('uncaughtException').length, before.uncaughtException)
    assert.equal(
      process.listeners('uncaughtExceptionMonitor').length,
      before.uncaughtExceptionMonitor,
    )
  })

  it('fill clips to bounds and put clips wide chars at the edge', () => {
    const out = fakeOut(4, 3)
    const screen = new Screen(out.stream, caps({ syncOutput: false }))
    openScreens.push(screen)
    screen.open()
    out.clear()
    screen.begin()
    screen.fill(1, 1, 4, 1, '·')
    screen.put(2, 4, '中')
    screen.put(2, 3, '中')
    screen.end()
    assert.ok(out.output.includes('·'))
    assert.ok(out.output.includes('中'))
    assert.ok(!out.output.includes(cursorTo(2, 4)))
  })
})

describe('input', () => {
  function collect(input: Readable): { reader: InputReader; keys: Key[] } {
    const reader = new InputReader(input as unknown as NodeJS.ReadStream)
    const keys: Key[] = []
    reader.onKey((k) => keys.push(k))
    reader.start()
    return { reader, keys }
  }

  it('parses CSI arrows/nav, Ctrl+letter, Alt+letter', async () => {
    const input = new Readable({ read() {} })
    const { reader, keys } = collect(input)
    input.push('\u001b[A\u001b[B\u001b[C\u001b[D')
    input.push('\u001b[H\u001b[F\u001b[5~\u001b[6~\u001b[3~')
    input.push('\u0003')
    input.push('\u0001')
    input.push('\u001bx')
    await new Promise((r) => setImmediate(r))
    reader.stop()
    const kinds = keys.map((k) => ('char' in k ? `${k.kind}:${k.char}` : k.kind))
    assert.deepEqual(kinds, [
      'up',
      'down',
      'right',
      'left',
      'home',
      'end',
      'pageup',
      'pagedown',
      'delete',
      'ctrl:c',
      'ctrl:a',
      'alt:x',
    ])
  })

  it('bracketed paste with newlines is one paste event', async () => {
    const input = new Readable({ read() {} })
    const { reader, keys } = collect(input)
    input.push('\u001b[200~hello\nworld\nline3\u001b[201~')
    await new Promise((r) => setImmediate(r))
    reader.stop()
    assert.equal(keys.length, 1)
    assert.deepEqual(keys[0], { kind: 'paste', text: 'hello\nworld\nline3' })
  })

  it('buffers a multi-byte character split across two chunks', async () => {
    const input = new Readable({ read() {} })
    const { reader, keys } = collect(input)
    // 中 = E4 B8 AD
    input.push(Buffer.from([0xe4, 0xb8]))
    assert.equal(keys.length, 0)
    input.push(Buffer.from([0xad]))
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(keys, [{ kind: 'char', char: '中' }])
    reader.stop()
  })

  it('Ctrl+C is a key event and does not kill the process', async () => {
    const input = new Readable({ read() {} })
    const { reader, keys } = collect(input)
    input.push('\u0003')
    await new Promise((r) => setImmediate(r))
    reader.stop()
    assert.deepEqual(keys, [{ kind: 'ctrl', char: 'c' }])
  })
})
