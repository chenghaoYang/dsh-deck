import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'
import { InputReader, type Key } from '../src/term/input.ts'

const ESC = '\u001b'

function sgrMouse(pb: number, col: number, row: number, release = false): string {
  return `${ESC}[<${pb};${col};${row}${release ? 'm' : 'M'}`
}

function collect(input: Readable): { reader: InputReader; keys: Key[] } {
  const reader = new InputReader(input as unknown as NodeJS.ReadStream)
  const keys: Key[] = []
  reader.onKey((k) => keys.push(k))
  reader.start()
  return { reader, keys }
}

function mouse(
  action: 'down' | 'up' | 'drag',
  button: 'left' | 'middle' | 'right',
  row: number,
  col: number,
  mods: { shift?: boolean; alt?: boolean; ctrl?: boolean } = {},
): Key {
  return {
    kind: 'mouse',
    action,
    button,
    row,
    col,
    shift: mods.shift === true,
    alt: mods.alt === true,
    ctrl: mods.ctrl === true,
  }
}

function wheel(
  direction: 'up' | 'down',
  row: number,
  col: number,
  mods: { shift?: boolean; alt?: boolean; ctrl?: boolean } = {},
): Key {
  return {
    kind: 'wheel',
    direction,
    row,
    col,
    shift: mods.shift === true,
    alt: mods.alt === true,
    ctrl: mods.ctrl === true,
  }
}

describe('input mouse', () => {
  it('parses left click down/up', async () => {
    const input = new Readable({ read() {} })
    const { reader, keys } = collect(input)
    input.push(sgrMouse(0, 12, 5) + sgrMouse(0, 12, 5, true))
    await new Promise((r) => setImmediate(r))
    reader.stop()
    assert.deepEqual(keys, [mouse('down', 'left', 5, 12), mouse('up', 'left', 5, 12)])
  })

  it('parses a right click', async () => {
    const input = new Readable({ read() {} })
    const { reader, keys } = collect(input)
    input.push(sgrMouse(2, 3, 8) + sgrMouse(2, 3, 8, true))
    await new Promise((r) => setImmediate(r))
    reader.stop()
    assert.deepEqual(keys, [mouse('down', 'right', 8, 3), mouse('up', 'right', 8, 3)])
  })

  it('parses a drag sequence (down, drag, up)', async () => {
    const input = new Readable({ read() {} })
    const { reader, keys } = collect(input)
    input.push(sgrMouse(0, 10, 5) + sgrMouse(32, 11, 5) + sgrMouse(32, 12, 6) + sgrMouse(0, 12, 6, true))
    await new Promise((r) => setImmediate(r))
    reader.stop()
    assert.deepEqual(keys, [
      mouse('down', 'left', 5, 10),
      mouse('drag', 'left', 5, 11),
      mouse('drag', 'left', 6, 12),
      mouse('up', 'left', 6, 12),
    ])
  })

  it('parses wheel up/down regardless of M/m', async () => {
    const input = new Readable({ read() {} })
    const { reader, keys } = collect(input)
    input.push(sgrMouse(64, 4, 2) + sgrMouse(65, 4, 2) + sgrMouse(64, 4, 3, true) + sgrMouse(65, 4, 3, true))
    await new Promise((r) => setImmediate(r))
    reader.stop()
    assert.deepEqual(keys, [
      wheel('up', 2, 4),
      wheel('down', 2, 4),
      wheel('up', 3, 4),
      wheel('down', 3, 4),
    ])
  })

  it('decodes shift/ctrl/alt modifiers on click and wheel', async () => {
    const input = new Readable({ read() {} })
    const { reader, keys } = collect(input)
    input.push(
      sgrMouse(4, 1, 1) +
        sgrMouse(8, 1, 1) +
        sgrMouse(16, 1, 1) +
        sgrMouse(4 + 8 + 16, 2, 3) +
        sgrMouse(64 + 4, 9, 7) +
        sgrMouse(65 + 16, 9, 7),
    )
    await new Promise((r) => setImmediate(r))
    reader.stop()
    assert.deepEqual(keys, [
      mouse('down', 'left', 1, 1, { shift: true }),
      mouse('down', 'left', 1, 1, { alt: true }),
      mouse('down', 'left', 1, 1, { ctrl: true }),
      mouse('down', 'left', 3, 2, { shift: true, alt: true, ctrl: true }),
      wheel('up', 7, 9, { shift: true }),
      wheel('down', 7, 9, { ctrl: true }),
    ])
  })

  it('parses a report split across two chunks mid-parameters', async () => {
    const input = new Readable({ read() {} })
    const { reader, keys } = collect(input)
    input.push(`${ESC}[<0;1`)
    await new Promise((r) => setImmediate(r))
    assert.equal(keys.length, 0)
    input.push('2;5M')
    await new Promise((r) => setImmediate(r))
    reader.stop()
    assert.deepEqual(keys, [mouse('down', 'left', 5, 12)])
  })

  it('malformed CSI < garbage does not corrupt subsequent keys', async () => {
    const input = new Readable({ read() {} })
    const { reader, keys } = collect(input)
    // Letters are CSI finals (`f` would terminate `<f`), so garbage stays in
    // the parameter byte range 0x30–0x3f and still ends with M/m or another final.
    input.push(`${ESC}[<;;;M`)
    input.push(`${ESC}[<0;1M`)
    input.push(`${ESC}[<====M`)
    input.push(`${ESC}[<35;8;4M`)
    input.push(`${ESC}[A`)
    input.push('q')
    await new Promise((r) => setImmediate(r))
    reader.stop()
    assert.deepEqual(
      keys.map((k) => (k.kind === 'unknown' ? 'unknown' : k)),
      ['unknown', 'unknown', 'unknown', { kind: 'up' }, { kind: 'char', char: 'q' }],
    )
  })

  it('interleaves mouse with normal keys and bracketed paste', async () => {
    const input = new Readable({ read() {} })
    const { reader, keys } = collect(input)
    input.push('a')
    input.push(sgrMouse(0, 1, 1))
    input.push('b')
    input.push(`${ESC}[200~hello\nworld${ESC}[201~`)
    input.push(sgrMouse(0, 1, 1, true))
    input.push(`${ESC}[C`)
    await new Promise((r) => setImmediate(r))
    reader.stop()
    assert.deepEqual(keys, [
      { kind: 'char', char: 'a' },
      mouse('down', 'left', 1, 1),
      { kind: 'char', char: 'b' },
      { kind: 'paste', text: 'hello\nworld' },
      mouse('up', 'left', 1, 1),
      { kind: 'right' },
    ])
  })

  /**
   * start() resumes the stream, so stop() has to release it. A pipe reaches EOF
   * and lets the process go regardless; a real terminal never does, so skipping
   * this left the app restoring the terminal on quit and then hanging with the
   * user's shell wedged. Assert the release explicitly.
   */
  it('stop releases the stream so a live tty cannot hold the process open', () => {
    const input = new Readable({ read() {} })
    let paused = 0
    let unreffed = 0
    const original = input.pause.bind(input)
    input.pause = () => { paused += 1; return original() }
    ;(input as unknown as { unref: () => void }).unref = () => { unreffed += 1 }

    const reader = new InputReader(input as unknown as NodeJS.ReadStream)
    reader.start()
    reader.stop()

    assert.equal(paused, 1, 'stop() must pause the stream it resumed')
    assert.equal(unreffed, 1, 'stop() must unref the handle so the loop can drain')
    assert.equal(input.listenerCount('data'), 0, 'stop() must drop its data listener')
  })

  it('stop is idempotent and safe on a stream without pause/unref', () => {
    const input = new Readable({ read() {} })
    const reader = new InputReader(input as unknown as NodeJS.ReadStream)
    reader.start()
    reader.stop()
    assert.doesNotThrow(() => reader.stop())
  })
})

describe('macOS keyboard input', () => {
  it('normalizes Return, Keypad Enter, and enhanced Ghostty Return sequences', async () => {
    const input = new Readable({ read() {} })
    const { reader, keys } = collect(input)
    input.push('\r')                    // ordinary macOS Return
    input.push('\n')                    // terminals configured for LF
    input.push(`${ESC}OM`)              // application-keypad Enter
    input.push(`${ESC}[13u`)            // Kitty CSI-u Return
    input.push(`${ESC}[13;1u`)          // Kitty CSI-u Return + explicit modifier field
    await new Promise((r) => setImmediate(r))
    reader.stop()
    assert.deepEqual(keys, Array.from({ length: 5 }, () => ({ kind: 'enter' as const })))
  })

  it('preserves Option+Return as the steer binding under CSI-u', async () => {
    const input = new Readable({ read() {} })
    const { reader, keys } = collect(input)
    input.push(`${ESC}[13;3u`)
    await new Promise((r) => setImmediate(r))
    reader.stop()
    assert.deepEqual(keys, [{
      kind: 'modified-enter', shift: false, alt: true, ctrl: false, super: false,
    }])
  })

  it('preserves Shift, Ctrl, and Command modifiers on enhanced Return', async () => {
    const input = new Readable({ read() {} })
    const { reader, keys } = collect(input)
    input.push(`${ESC}[13;2u${ESC}[13;5u${ESC}[13;9u`)
    await new Promise((r) => setImmediate(r))
    reader.stop()
    assert.deepEqual(keys, [
      { kind: 'modified-enter', shift: true, alt: false, ctrl: false, super: false },
      { kind: 'modified-enter', shift: false, alt: false, ctrl: true, super: false },
      { kind: 'modified-enter', shift: false, alt: false, ctrl: false, super: true },
    ])
  })

  it('supports xterm modifyOtherKeys Return without losing Option', async () => {
    const input = new Readable({ read() {} })
    const { reader, keys } = collect(input)
    input.push(`${ESC}[27;1;13~${ESC}[27;3;13~`)
    await new Promise((r) => setImmediate(r))
    reader.stop()
    assert.deepEqual(keys, [
      { kind: 'enter' },
      { kind: 'modified-enter', shift: false, alt: true, ctrl: false, super: false },
    ])
  })

  it('normalizes enhanced Backspace while preserving ordinary Mac Delete', async () => {
    const input = new Readable({ read() {} })
    const { reader, keys } = collect(input)
    input.push('\u007f')
    input.push(`${ESC}\u007f`)          // Option+Backspace in legacy mode
    input.push(`${ESC}[127u`)
    input.push(`${ESC}[8u`)
    input.push(`${ESC}[127;3u`)          // Option+Backspace under CSI-u
    input.push(`${ESC}[27;3;127~`)       // Option+Backspace under modifyOtherKeys
    await new Promise((r) => setImmediate(r))
    reader.stop()
    assert.deepEqual(keys, [
      { kind: 'backspace' },
      { kind: 'word-backspace' },
      { kind: 'backspace' },
      { kind: 'backspace' },
      { kind: 'word-backspace' },
      { kind: 'word-backspace' },
    ])
  })

  it('does not misinterpret xterm F3 as Return', async () => {
    const input = new Readable({ read() {} })
    const { reader, keys } = collect(input)
    input.push(`${ESC}[13~`)
    await new Promise((r) => setImmediate(r))
    reader.stop()
    assert.deepEqual(keys, [{ kind: 'unknown', raw: `${ESC}[13~` }])
  })
})
