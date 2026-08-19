import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { detectCapabilities } from '../src/term/capabilities.ts'
import {
  KITTY_CHUNK,
  TerminalIntegration,
  encodeKittyPng,
} from '../src/term/ghostty.ts'
import type { TerminalCapabilities } from '../src/term/capabilities.ts'

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

function fakeOut() {
  let data = ''
  const stream = {
    write(chunk: string | Uint8Array) {
      data += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      return true
    },
  }
  return {
    stream: stream as unknown as NodeJS.WriteStream,
    get output() {
      return data
    },
  }
}

function kittyChunks(seq: string): RegExpMatchArray[] {
  return [...seq.matchAll(/\u001b_G([^;]*);([A-Za-z0-9+/=]*)\u001b\\/g)]
}

describe('capabilities', () => {
  it('treats Ghostty env as the primary signal and honors DECK_CAPS / NO_COLOR', () => {
    const g = detectCapabilities({
      TERM_PROGRAM: 'ghostty',
      TERM_PROGRAM_VERSION: '1.3.1',
      TERM: 'xterm-ghostty',
    })
    assert.equal(g.isGhostty, true)
    assert.equal(g.termProgram, 'ghostty')
    assert.equal(g.termProgramVersion, '1.3.1')
    assert.equal(g.kittyGraphics, true)
    assert.equal(g.progress, true)
    assert.equal(g.notifications, true)
    assert.equal(g.syncOutput, true)
    assert.equal(g.hyperlinks, true)
    assert.equal(g.clipboard, true)
    assert.equal(g.unicodeCore, true)
    assert.equal(g.trueColor, true)

    const off = detectCapabilities({
      TERM_PROGRAM: 'ghostty',
      DECK_CAPS: '+progress,-kittyGraphics,-notifications',
    })
    assert.equal(off.progress, true)
    assert.equal(off.kittyGraphics, false)
    assert.equal(off.notifications, false)

    const noColor = detectCapabilities({
      TERM_PROGRAM: 'ghostty',
      NO_COLOR: '1',
    })
    assert.equal(noColor.trueColor, false)

    const dumb = detectCapabilities({ TERM: 'dumb' })
    assert.equal(dumb.isGhostty, false)
    assert.equal(dumb.kittyGraphics, false)
    assert.equal(dumb.progress, false)
  })
})

describe('ghostty integration', () => {
  it('strips ESC/BEL/ST/C0 so a malicious string cannot break out of notify or title', () => {
    const out = fakeOut()
    const ti = new TerminalIntegration(out.stream, caps())
    const evil = 'evil\u001b]0;pwned\u0007'
    ti.notify(evil, evil)
    ti.title(evil)
    assert.ok(!out.output.includes('\u001b]0;pwned'), out.output)
    assert.ok(!out.output.includes('\u0007'), out.output)
    assert.ok(!out.output.includes(evil), out.output)
    // Title ';' is replaced so it cannot split the OSC 777 fields.
    assert.ok(out.output.includes('\u001b]777;notify;evil]0 pwned;evil]0;pwned\u001b\\'))
    assert.ok(out.output.includes('\u001b]0;evil]0;pwned\u001b\\'))
  })

  it('unsupported capabilities degrade to no-op rather than emitting sequences', () => {
    const out = fakeOut()
    const ti = new TerminalIntegration(
      out.stream,
      caps({
        progress: false,
        notifications: false,
        clipboard: false,
        kittyGraphics: false,
        hyperlinks: false,
        isGhostty: false,
      }),
    )
    ti.progress(1, 40)
    ti.notify('t', 'b')
    ti.copy('secret')
    assert.equal(ti.image(new Uint8Array([1, 2, 3])), undefined)
    assert.equal(ti.fileLink('/tmp/x.ts', 3, 'x.ts'), 'x.ts')
    assert.equal(out.output, '')
  })

  it('emits the exact OSC 9;4 / 52 / 133 sequences when supported', () => {
    const out = fakeOut()
    const ti = new TerminalIntegration(out.stream, caps())
    ti.progress(1, 40)
    ti.copy('hi')
    ti.markPromptStart()
    ti.markOutputStart()
    ti.markCommandEnd(0)
    assert.ok(out.output.includes('\u001b]9;4;1;40\u001b\\'))
    assert.ok(out.output.includes(`\u001b]52;c;${Buffer.from('hi').toString('base64')}\u001b\\`))
    assert.ok(out.output.includes('\u001b]133;A\u001b\\'))
    assert.ok(out.output.includes('\u001b]133;C\u001b\\'))
    assert.ok(out.output.includes('\u001b]133;D;0\u001b\\'))
  })

  it('chunks Kitty graphics at 4096 base64 bytes with m flags and first-chunk-only controls', () => {
    const exact = new Uint8Array(3072)
    const exactSeq = encodeKittyPng(exact)
    const exactChunks = kittyChunks(exactSeq)
    assert.equal(exactChunks.length, 1)
    assert.equal(exactChunks[0]?.[2]?.length, KITTY_CHUNK)
    assert.ok(exactChunks[0]?.[1]?.includes('a=T'))
    assert.ok(exactChunks[0]?.[1]?.includes('f=100'))
    assert.ok(exactChunks[0]?.[1]?.includes('m=0'))

    const two = new Uint8Array(6144)
    const twoSeq = encodeKittyPng(two, { columns: 8, rows: 4 })
    const twoChunks = kittyChunks(twoSeq)
    assert.equal(twoChunks.length, 2)
    assert.equal(twoChunks[0]?.[2]?.length, KITTY_CHUNK)
    assert.equal(twoChunks[1]?.[2]?.length, KITTY_CHUNK)
    assert.equal(twoChunks[0]?.[1], 'a=T,f=100,m=1,c=8,r=4')
    assert.equal(twoChunks[1]?.[1], 'm=0')
    assert.ok(!twoChunks[1]?.[1]?.includes('a=T'))

    const odd = new Uint8Array(3073)
    const oddSeq = encodeKittyPng(odd)
    const oddChunks = kittyChunks(oddSeq)
    assert.equal(oddChunks.length, 2)
    assert.equal(oddChunks[0]?.[2]?.length, KITTY_CHUNK)
    assert.ok((oddChunks[1]?.[2]?.length ?? 0) > 0)
    assert.ok((oddChunks[1]?.[2]?.length ?? 0) < KITTY_CHUNK)
    assert.ok(oddChunks[0]?.[1]?.includes('m=1'))
    assert.equal(oddChunks[1]?.[1], 'm=0')
  })
})
