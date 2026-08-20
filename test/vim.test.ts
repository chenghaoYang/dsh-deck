import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Key } from '../src/term/input.ts'
import { reduceVimComposer, type VimComposerState } from '../src/ui/vim.ts'

function init(
  draft: string,
  cursor: number,
  mode: VimComposerState['mode'] = 'insert',
  yank?: string,
): VimComposerState {
  const state: VimComposerState = { draft, cursor, mode }
  if (yank !== undefined && yank.length > 0) state.yank = yank
  return state
}

function continueState(state: VimComposerState, key: Key): VimComposerState {
  const result = reduceVimComposer(state, key)
  assert.equal(result.kind, 'continue')
  if (result.kind !== 'continue') throw new Error('expected continue')
  return result.state
}

function char(c: string): Key {
  return { kind: 'char', char: c }
}

describe('vim composer insert', () => {
  it('inserts a char and escape enters normal without moving the cursor', () => {
    let state = init('', 0, 'insert')
    state = continueState(state, char('h'))
    state = continueState(state, char('i'))
    assert.equal(state.draft, 'hi')
    assert.equal(state.cursor, 2)
    assert.equal(state.mode, 'insert')

    state = continueState(state, { kind: 'escape' })
    assert.equal(state.mode, 'normal')
    assert.equal(state.cursor, 2)
    assert.equal(state.draft, 'hi')
  })

  it('enter in insert sends; enter in normal continues without sending', () => {
    const inserted = reduceVimComposer(init('go', 2, 'insert'), { kind: 'enter' })
    assert.equal(inserted.kind, 'send')
    if (inserted.kind !== 'send') throw new Error('expected send')
    assert.equal(inserted.state.draft, 'go')
    assert.equal(inserted.state.mode, 'insert')

    const normal = reduceVimComposer(init('go', 2, 'normal'), { kind: 'enter' })
    assert.equal(normal.kind, 'continue')
    if (normal.kind !== 'continue') throw new Error('expected continue')
    assert.equal(normal.state.draft, 'go')
    assert.equal(normal.state.mode, 'normal')
  })

  it('pastes in insert: strips CR, maps tabs to space, drops other C0', () => {
    const state = continueState(
      init('ac', 1, 'insert'),
      { kind: 'paste', text: 'b\r\t\u0001x\ny' },
    )
    assert.equal(state.draft, 'ab x\nyc')
    assert.equal(state.cursor, 6)
    assert.equal(state.mode, 'insert')
  })

  it('omits yank until a delete (exactOptionalPropertyTypes)', () => {
    const start = init('ab', 0, 'insert')
    assert.equal(Object.hasOwn(start, 'yank'), false)

    const typed = continueState(start, char('z'))
    assert.equal(typed.draft, 'zab')
    assert.equal(Object.hasOwn(typed, 'yank'), false)

    const normal = continueState(init('ab', 0, 'normal'), char('l'))
    assert.equal(Object.hasOwn(normal, 'yank'), false)
    assert.equal(normal.cursor, 1)
  })
})

describe('vim composer normal motions', () => {
  it('i/a/I/A enter insert at the documented cursor', () => {
    const base = init('xy', 0, 'normal')

    const i = continueState(base, char('i'))
    assert.equal(i.mode, 'insert')
    assert.equal(i.cursor, 0)

    const a = continueState(base, char('a'))
    assert.equal(a.mode, 'insert')
    assert.equal(a.cursor, 1)
    assert.equal(a.draft, 'xy')

    const I = continueState(init('xy', 1, 'normal'), char('I'))
    assert.equal(I.mode, 'insert')
    assert.equal(I.cursor, 0)

    const A = continueState(init('xy', 0, 'normal'), char('A'))
    assert.equal(A.mode, 'insert')
    assert.equal(A.cursor, 2)
  })

  it('h/l/0/$/w/b move by grapheme, line, and word', () => {
    const draft = 'one two\nthree'
    let state = init(draft, 4, 'normal')

    state = continueState(state, char('h'))
    assert.equal(state.cursor, 3)
    state = continueState(state, char('l'))
    assert.equal(state.cursor, 4)

    state = continueState(state, char('0'))
    assert.equal(state.cursor, 0)
    state = continueState(state, char('$'))
    assert.equal(state.cursor, 7)

    state = continueState(init(draft, 0, 'normal'), char('w'))
    assert.equal(state.cursor, 4)
    state = continueState(state, char('w'))
    assert.equal(state.cursor, 8)

    state = continueState(state, char('b'))
    assert.equal(state.cursor, 4)
    state = continueState(state, char('b'))
    assert.equal(state.cursor, 0)

    const indented = continueState(init('  hi', 3, 'normal'), char('^'))
    assert.equal(indented.cursor, 2)
  })

  it('j/k keep the code-point column across newlines', () => {
    const draft = 'abc\nde\nfghi'
    let state = init(draft, 1, 'normal')

    state = continueState(state, char('j'))
    assert.equal(state.cursor, 5)
    state = continueState(state, char('j'))
    assert.equal(state.cursor, 8)

    state = continueState(state, char('k'))
    assert.equal(state.cursor, 5)
    state = continueState(state, char('k'))
    assert.equal(state.cursor, 1)

    const short = continueState(init('abcd\ne', 3, 'normal'), char('j'))
    assert.equal(short.cursor, 6)

    const stuck = continueState(init('ab', 1, 'normal'), char('j'))
    assert.equal(stuck.cursor, 1)
    const top = continueState(init('ab', 1, 'normal'), char('k'))
    assert.equal(top.cursor, 1)
  })

  it('one h/l moves one 你', () => {
    const draft = '你我a'
    let state = init(draft, 0, 'normal')
    state = continueState(state, char('l'))
    assert.equal(state.cursor, 1)
    assert.equal([...state.draft].slice(0, state.cursor).join(''), '你')

    state = continueState(state, char('l'))
    assert.equal(state.cursor, 2)
    state = continueState(state, char('h'))
    assert.equal(state.cursor, 1)
    state = continueState(state, char('h'))
    assert.equal(state.cursor, 0)

    const insertMove = continueState(init(draft, 1, 'insert'), { kind: 'left' })
    assert.equal(insertMove.cursor, 0)
    const right = continueState(insertMove, { kind: 'right' })
    assert.equal(right.cursor, 1)
  })
})

describe('vim composer yank and delete', () => {
  it('x yanks the grapheme under the cursor and p pastes after', () => {
    let state = continueState(init('abc', 1, 'normal'), char('x'))
    assert.equal(state.draft, 'ac')
    assert.equal(state.cursor, 1)
    assert.equal(state.yank, 'b')
    assert.equal(Object.hasOwn(state, 'yank'), true)

    state = continueState(state, char('p'))
    assert.equal(state.draft, 'acb')
    assert.equal(state.yank, 'b')
    assert.equal(state.mode, 'normal')
  })

  it('D deletes the rest of the line and does not eat the newline', () => {
    let state = continueState(init('hello\nworld', 1, 'normal'), char('D'))
    assert.equal(state.draft, 'h\nworld')
    assert.equal(state.cursor, 1)
    assert.equal(state.yank, 'ello')

    state = continueState(init('ab\ncd', 0, 'normal'), char('D'))
    assert.equal(state.draft, '\ncd')
    assert.equal(state.yank, 'ab')
  })
})

describe('vim composer park and passthrough', () => {
  it('escape in normal parks scrollback', () => {
    const result = reduceVimComposer(init('hi', 1, 'normal'), { kind: 'escape' })
    assert.equal(result.kind, 'park')
    if (result.kind !== 'park') throw new Error('expected park')
    assert.equal(result.state.mode, 'normal')
    assert.equal(result.state.draft, 'hi')
    assert.equal(result.state.cursor, 1)
  })

  it('ctrl+c / ctrl+d are unhandled so the app can quit', () => {
    for (const mode of ['insert', 'normal'] as const) {
      const c = reduceVimComposer(init('x', 1, mode), { kind: 'ctrl', char: 'c' })
      const d = reduceVimComposer(init('x', 1, mode), { kind: 'ctrl', char: 'd' })
      assert.equal(c.kind, 'unhandled')
      assert.equal(d.kind, 'unhandled')
    }
  })
})
