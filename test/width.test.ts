import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  graphemeWidth,
  stringWidth,
  stripAnsi,
  truncate,
  wrap,
} from '../src/term/width.ts'

describe('width', () => {
  it('中文 is 4 columns', () => {
    assert.equal(stringWidth('中文'), 4)
    assert.equal(graphemeWidth('中'), 2)
    assert.equal(graphemeWidth('文'), 2)
  })

  it('combining acute a\u0301 is 1', () => {
    assert.equal(stringWidth('a\u0301'), 1)
    assert.equal(graphemeWidth('a\u0301'), 1)
  })

  it('ZWJ family emoji is 2', () => {
    assert.equal(stringWidth('👨‍👩‍👧‍👦'), 2)
    assert.equal(graphemeWidth('👨‍👩‍👧‍👦'), 2)
  })

  it('regional indicator pair 🇯🇵 is 2', () => {
    assert.equal(stringWidth('🇯🇵'), 2)
    assert.equal(graphemeWidth('🇯🇵'), 2)
  })

  it('ZWSP is 0', () => {
    assert.equal(stringWidth('\u200b'), 0)
    assert.equal(graphemeWidth('\u200b'), 0)
  })

  it('Nerd Font PUA glyphs are 1 (Maple Mono NF CN)', () => {
    assert.equal(graphemeWidth('\uE000'), 1)
    assert.equal(graphemeWidth('\uE0A0'), 1)
    assert.equal(graphemeWidth('\uF8FF'), 1)
    assert.equal(graphemeWidth('\u{F0000}'), 1)
    assert.equal(graphemeWidth('\u{F8FFD}'), 1)
    assert.equal(stringWidth('\uE0A0\uE0A1\uE0B0'), 3)
  })

  it('Latin, fullwidth, and hangul', () => {
    assert.equal(stringWidth('abc'), 3)
    assert.equal(stringWidth('Ａ'), 2)
    assert.equal(stringWidth('한'), 2)
  })

  it('truncate mixed CJK/Latin never splits a wide character', () => {
    assert.equal(truncate('hello中文', 100), 'hello中文')
    const cut = truncate('hello中文', 8, '…')
    assert.equal(stringWidth(cut), 8)
    assert.ok(cut.endsWith('…'))
    assert.ok(!cut.includes('\uFFFD'))
    // budget 7 after ellipsis; "hello" is 5, 中 is 2 which would be 7, then …
    assert.equal(truncate('hello中文', 8, '…'), 'hello中…')

    const half = truncate('中文', 3, '…')
    assert.equal(half, '中…')
    assert.equal(stringWidth(half), 3)
    assert.notEqual(half[0], '\uFFFD')

    const tight = truncate('中文', 2, '…')
    // 中 is 2 and would leave no room for …, so we emit only the ellipsis
    // rather than splitting the wide character.
    assert.equal(tight, '…')
    assert.equal(stringWidth(tight), 1)
    assert.ok(stringWidth(tight) <= 2)

    assert.equal(truncate('ABC中', 4, '…'), 'ABC…')
  })

  it('wrap mixed CJK/Latin at word boundaries and never splits wide chars', () => {
    assert.deepEqual(wrap('hello 中文 world', 8), ['hello', '中文', 'world'])
    const cjk = wrap('中文测试', 4)
    assert.deepEqual(cjk, ['中文', '测试'])
    for (const line of cjk) assert.ok(stringWidth(line) <= 4)

    const mixed = wrap('foo中文bar', 5)
    for (const line of mixed) {
      assert.ok(stringWidth(line) <= 5)
      assert.ok(!line.includes('\uFFFD'))
    }
    assert.ok(wrap('中文', 1).every((line) => stringWidth(line) <= 1 && line !== '中'))
    assert.deepEqual(wrap('hello\nworld', 20), ['hello', 'world'])
  })

  it('stripAnsi removes CSI and OSC', () => {
    assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red')
    assert.equal(stripAnsi('\u001b]8;;http://x\u001b\\link\u001b]8;;\u001b\\'), 'link')
    assert.equal(stripAnsi('\u001b]0;title\u0007x'), 'x')
    assert.equal(stringWidth(stripAnsi('\u001b[1m中\u001b[0m')), 2)
  })
})
