import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CSI,
  OSC,
  RESET,
  ST,
  altScreen,
  beginSync,
  cursorTo,
  endSync,
  fg256,
  hideCursor,
  hyperlink,
  restoreTerminal,
  rgb,
  sanitizeOscPayload,
  setTitle,
  sgr,
  showCursor,
} from '../src/term/ansi.ts'

describe('ansi builders', () => {
  it('emits the documented CSI/OSC atoms', () => {
    assert.equal(CSI, '\u001b[')
    assert.equal(OSC, '\u001b]')
    assert.equal(ST, '\u001b\\')
    assert.equal(RESET, '\u001b[0m')
    assert.equal(sgr(1, 31), '\u001b[1;31m')
    assert.equal(fg256(4), '\u001b[38;5;4m')
    assert.equal(rgb(1, 2, 3), '\u001b[38;2;1;2;3m')
    assert.equal(cursorTo(2, 5), '\u001b[2;5H')
    assert.equal(hideCursor(), '\u001b[?25l')
    assert.equal(showCursor(), '\u001b[?25h')
    assert.equal(altScreen(true), '\u001b[?1049h')
    assert.equal(altScreen(false), '\u001b[?1049l')
    assert.equal(beginSync(), '\u001b[?2026h')
    assert.equal(endSync(), '\u001b[?2026l')
  })

  it('hyperlink and title sanitize interpolated text', () => {
    const evil = 'evil\u001b]0;pwned\u0007'
    assert.equal(sanitizeOscPayload(evil), 'evil]0;pwned')
    const link = hyperlink('https://example.com', evil)
    assert.equal(link, `\u001b]8;;https://example.com\u001b\\evil]0;pwned\u001b]8;;\u001b\\`)
    assert.ok(!link.includes('\u0007'))
    assert.ok(!link.includes('\u001b]0;pwned'))
    assert.equal(setTitle(evil), `\u001b]0;evil]0;pwned\u001b\\`)
  })

  it('restoreTerminal contains cursor, alt-off, SGR reset, and OSC 9;4 clear', () => {
    const r = restoreTerminal()
    assert.ok(r.includes('\u001b[?25h'))
    assert.ok(r.includes('\u001b[?1049l'))
    assert.ok(r.includes('\u001b[0m'))
    assert.ok(r.includes('\u001b]9;4;0;0\u001b\\'))
    assert.ok(r.includes('\u001b[?2026l'))
    assert.ok(r.includes('\u001b[?2004l'))
  })
})
