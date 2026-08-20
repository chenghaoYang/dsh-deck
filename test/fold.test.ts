import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyEvent,
  applyHistory,
  emptyTranscript,
  type TranscriptItem,
  type TranscriptState,
} from '../src/model/fold.ts'
import type {
  ContentBlock,
  HistoryEntry,
  Message,
  SessionEvent,
  StreamChunk,
  TokenUsage,
} from '../src/protocol/contract.ts'

function fixture(startSeq = 0): {
  ev: (type: string, data: unknown, extra?: Partial<SessionEvent>) => SessionEvent
  seq: () => number
} {
  let seq = startSeq
  const time0 = 1_700_000_000_000
  return {
    seq: () => seq,
    ev(type, data, extra) {
      const event: SessionEvent = {
        type,
        seq,
        time: time0 + seq * 10,
        data,
      }
      seq += 1
      if (extra === undefined) return event
      return { ...event, ...extra, type: extra.type ?? type, seq: extra.seq ?? event.seq }
    },
  }
}

function userMessage(text: string): Message {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function assistantMessage(blocks: ContentBlock[]): Message {
  return {
    role: 'assistant',
    content: blocks,
    source: { kind: 'model', provider: 'deepseek', model: 'test' },
  }
}

function toolResultMessage(callId: string, text: string, isError = false): Message {
  return {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId: callId,
      content: [{ type: 'text', text }],
      isError,
    }],
    source: { kind: 'tool', callId },
  }
}

function foldAll(events: readonly SessionEvent[]): TranscriptState {
  return events.reduce((state, event) => applyEvent(state, event), emptyTranscript())
}

function historyOf(events: readonly SessionEvent[]): HistoryEntry[] {
  return events.map((event) => ({ event }))
}

function kinds(state: TranscriptState): string[] {
  return state.items.map((item) => item.kind)
}

function ofKind<K extends TranscriptItem['kind']>(
  state: TranscriptState,
  kind: K,
): Extract<TranscriptItem, { kind: K }>[] {
  return state.items.filter((item): item is Extract<TranscriptItem, { kind: K }> => item.kind === kind)
}

describe('emptyTranscript', () => {
  it('starts idle with lastSeq -1 so seq 0 applies', () => {
    const state = emptyTranscript()
    assert.deepEqual(state.items, [])
    assert.equal(state.lastSeq, -1)
    assert.equal(state.phase, 'idle')
    assert.deepEqual(state.usage, {})
    assert.equal(state.turnStartedAt, undefined)
  })
})

describe('plugin-sourced user messages', () => {
  it('hides runtime-context and skills injections; keeps human input and sourceless imports', () => {
    const { ev } = fixture()
    let state = emptyTranscript()
    state = applyEvent(state, ev('user/message', userMessage('real prompt'), { surfaceOp: 'append' }))
    state = applyEvent(state, ev('user/message', {
      role: 'user',
      content: [{ type: 'text', text: '<system-reminder>skills catalog dump…</system-reminder>' }],
      source: { kind: 'plugin', plugin: 'skill' },
    }, { surfaceOp: 'append' }))
    state = applyEvent(state, ev('user/message', {
      role: 'user',
      content: [{ type: 'text', text: 'runtime context snapshot' }],
      source: { kind: 'plugin', plugin: 'context' },
    }, { surfaceOp: 'append' }))
    // Imported/legacy logs may carry no source at all; keep those.
    state = applyEvent(state, ev('user/message', {
      role: 'user',
      content: [{ type: 'text', text: 'legacy import' }],
    }, { surfaceOp: 'append' }))

    const users = state.items.filter((item) => item.kind === 'user')
    assert.deepEqual(users.map((item) => item.text), ['real prompt', 'legacy import'])
  })
})

describe('idempotent replay', () => {
  it('applying a tail page then overlapping live frames does not duplicate content', () => {
    const { ev } = fixture()
    const events = [
      ev('turn/start', { turn: 1 }),
      ev('user/message', userMessage('hello'), { surfaceOp: 'append' }),
      ev('assistant/chunk', {
        turn: 1, step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'Hi' } satisfies StreamChunk,
      }),
      ev('assistant/chunk', {
        turn: 1, step: 1,
        chunk: { type: 'text-delta', index: 0, text: ' there' } satisfies StreamChunk,
      }),
      ev('assistant/message', {
        turn: 1, step: 1,
        message: assistantMessage([{ type: 'text', text: 'Hi there' }]),
        usage: { inputTokens: 4, outputTokens: 2 },
      }, { surfaceOp: 'append' }),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]

    const fromHistory = applyHistory(emptyTranscript(), historyOf(events))
    const overlapped = events.slice(2)
    const replayed = applyHistory(fromHistory, historyOf(overlapped))

    assert.equal(replayed, fromHistory)
    assert.equal(ofKind(replayed, 'user').length, 1)
    assert.equal(ofKind(replayed, 'assistant').length, 1)
    assert.equal(ofKind(replayed, 'assistant')[0]?.text, 'Hi there')
    assert.equal(ofKind(replayed, 'turn-end').length, 1)
  })

  it('ignores any event whose seq <= lastSeq', () => {
    const { ev } = fixture()
    let state = applyEvent(emptyTranscript(), ev('user/message', userMessage('one'), { surfaceOp: 'append' }))
    const stale: SessionEvent = {
      type: 'user/message',
      seq: 0,
      time: 1,
      data: userMessage('stale'),
      surfaceOp: 'append',
    }
    const next = applyEvent(state, stale)
    assert.equal(next, state)
    assert.equal(ofKind(state, 'user')[0]?.text, 'one')
  })
})

describe('assistant/message replaces streaming text', () => {
  it('committed message replaces a half-streamed assistant item exactly once', () => {
    const { ev } = fixture()
    let state = emptyTranscript()
    state = applyEvent(state, ev('turn/start', { turn: 1 }))
    state = applyEvent(state, ev('assistant/chunk', {
      turn: 1, step: 1,
      chunk: { type: 'block-start', index: 0, blockType: 'text' },
    }))
    state = applyEvent(state, ev('assistant/chunk', {
      turn: 1, step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'The answer is for' },
    }))
    state = applyEvent(state, ev('assistant/chunk', {
      turn: 1, step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'ty' },
    }))
    assert.equal(ofKind(state, 'assistant')[0]?.text, 'The answer is forty')
    assert.equal(ofKind(state, 'assistant')[0]?.streaming, true)

    state = applyEvent(state, ev('assistant/message', {
      turn: 1, step: 1,
      message: assistantMessage([{ type: 'text', text: 'The answer is 42.' }]),
    }, { surfaceOp: 'append' }))

    const assistants = ofKind(state, 'assistant')
    assert.equal(assistants.length, 1)
    assert.equal(assistants[0]?.text, 'The answer is 42.')
    assert.equal(assistants[0]?.streaming, false)
    assert.equal(state.items.filter((item) => item.kind === 'assistant' && item.text.includes('forty')).length, 0)
  })

  it('empty-content assistant/message folds usage without injecting a blank turn', () => {
    const { ev } = fixture()
    let state = applyEvent(emptyTranscript(), ev('turn/start', { turn: 1 }))
    state = applyEvent(state, ev('assistant/message', {
      turn: 1, step: 1,
      message: assistantMessage([]),
      usage: { inputTokens: 9, outputTokens: 0 },
    }, { surfaceOp: 'append' }))
    assert.equal(ofKind(state, 'assistant').length, 0)
    assert.equal(state.usage.inputTokens, 9)
  })
})

describe('multiple content blocks keyed by chunk index', () => {
  it('reasoning then text then tool-call land as separate items in emission order', () => {
    const { ev } = fixture()
    const events = [
      ev('turn/start', { turn: 1 }),
      ev('assistant/chunk', {
        turn: 1, step: 1,
        chunk: { type: 'block-start', index: 0, blockType: 'reasoning' },
      }),
      ev('assistant/chunk', {
        turn: 1, step: 1,
        chunk: { type: 'reasoning-delta', index: 0, text: 'think' },
      }),
      ev('assistant/chunk', {
        turn: 1, step: 1,
        chunk: { type: 'block-start', index: 1, blockType: 'text' },
      }),
      ev('assistant/chunk', {
        turn: 1, step: 1,
        chunk: { type: 'text-delta', index: 1, text: 'ok' },
      }),
      ev('assistant/chunk', {
        turn: 1, step: 1,
        chunk: { type: 'block-start', index: 2, blockType: 'tool-call' },
      }),
      ev('assistant/chunk', {
        turn: 1, step: 1,
        chunk: { type: 'tool-call-delta', index: 2, id: 'c1', name: 'bash', argumentsDelta: '{"c"' },
      }),
      ev('assistant/chunk', {
        turn: 1, step: 1,
        chunk: { type: 'tool-call-delta', index: 2, id: 'c1', argumentsDelta: ':"ls"}' },
      }),
    ]
    const state = foldAll(events)
    assert.deepEqual(kinds(state), ['reasoning', 'assistant', 'tool'])
    assert.equal(ofKind(state, 'reasoning')[0]?.text, 'think')
    assert.equal(ofKind(state, 'assistant')[0]?.text, 'ok')
    assert.equal(ofKind(state, 'tool')[0]?.call.callId, 'c1')
    assert.equal(ofKind(state, 'tool')[0]?.call.argumentsRaw, '{"c":"ls"}')
  })

  it('first-seen index order is preserved when block-start arrives out of numeric order', () => {
    const { ev } = fixture()
    const state = foldAll([
      ev('turn/start', { turn: 1 }),
      ev('assistant/chunk', {
        turn: 1, step: 1,
        chunk: { type: 'text-delta', index: 2, text: 'second' },
      }),
      ev('assistant/chunk', {
        turn: 1, step: 1,
        chunk: { type: 'reasoning-delta', index: 0, text: 'first' },
      }),
    ])
    assert.deepEqual(kinds(state), ['assistant', 'reasoning'])
    assert.equal(ofKind(state, 'assistant')[0]?.text, 'second')
    assert.equal(ofKind(state, 'reasoning')[0]?.text, 'first')
  })

  it('ignores deltas after block-end for that index (assembler first-close-wins)', () => {
    const { ev } = fixture()
    let state = foldAll([
      ev('turn/start', { turn: 1 }),
      ev('assistant/chunk', {
        turn: 1, step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'hello' },
      }),
      ev('assistant/chunk', {
        turn: 1, step: 1,
        chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
      }),
    ])
    state = applyEvent(state, ev('assistant/chunk', {
      turn: 1, step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'STRAGGLER' },
    }))
    assert.equal(ofKind(state, 'assistant')[0]?.text, 'hello')
    assert.match(ofKind(state, 'assistant')[0]?.text ?? '', /^(?!.*STRAGGLER)/)
  })
})

describe('interleaved tool calls', () => {
  it('two tool calls in one step resolve out-of-order results to the right callId', () => {
    const { ev } = fixture()
    let state = foldAll([
      ev('turn/start', { turn: 1 }),
      ev('assistant/chunk', {
        turn: 1, step: 1,
        chunk: { type: 'tool-call-delta', index: 0, id: 'call-a', name: 'read', argumentsDelta: '{"path":"a"}' },
      }),
      ev('assistant/chunk', {
        turn: 1, step: 1,
        chunk: { type: 'tool-call-delta', index: 1, id: 'call-b', name: 'read', argumentsDelta: '{"path":"b"}' },
      }),
      ev('assistant/message', {
        turn: 1, step: 1,
        message: assistantMessage([
          { type: 'tool-call', id: 'call-a', name: 'read', arguments: '{"path":"a"}' },
          { type: 'tool-call', id: 'call-b', name: 'read', arguments: '{"path":"b"}' },
        ]),
      }, { surfaceOp: 'append' }),
      ev('tool/call', { turn: 1, step: 1, callId: 'call-a', name: 'read', arguments: '{"path":"a"}' }),
      ev('tool/call', { turn: 1, step: 1, callId: 'call-b', name: 'read', arguments: '{"path":"b"}' }),
    ])

    // Result for B arrives first.
    state = applyEvent(state, ev('tool/result', {
      turn: 1, step: 1,
      message: toolResultMessage('call-b', 'contents-b'),
    }, { surfaceOp: 'append' }))
    state = applyEvent(state, ev('tool/result', {
      turn: 1, step: 1,
      message: toolResultMessage('call-a', 'contents-a'),
    }, { surfaceOp: 'append' }))

    const tools = ofKind(state, 'tool')
    assert.equal(tools.length, 2)
    const a = tools.find((item) => item.call.callId === 'call-a')
    const b = tools.find((item) => item.call.callId === 'call-b')
    assert.equal(a?.call.resultText, 'contents-a')
    assert.equal(a?.call.status, 'ok')
    assert.equal(b?.call.resultText, 'contents-b')
    assert.equal(b?.call.status, 'ok')
    assert.equal(a?.call.name, 'read')
    assert.equal(b?.call.name, 'read')
  })
})

describe('tool-call arguments are a raw JSON string', () => {
  it('accumulates argumentsDelta and parses lazily without throwing on partial JSON', () => {
    const { ev } = fixture()
    let state = applyEvent(emptyTranscript(), ev('turn/start', { turn: 1 }))
    state = applyEvent(state, ev('assistant/chunk', {
      turn: 1, step: 1,
      chunk: { type: 'tool-call-delta', index: 0, id: 't1', name: 'bash', argumentsDelta: '{"command":' },
    }))
    const mid = ofKind(state, 'tool')[0]
    assert.equal(mid?.call.argumentsRaw, '{"command":')
    assert.equal(mid?.call.args, undefined)

    state = applyEvent(state, ev('assistant/chunk', {
      turn: 1, step: 1,
      chunk: { type: 'tool-call-delta', index: 0, id: 't1', argumentsDelta: '"ls -la"}' },
    }))
    const done = ofKind(state, 'tool')[0]
    assert.equal(done?.call.argumentsRaw, '{"command":"ls -la"}')
    assert.deepEqual(done?.call.args, { command: 'ls -la' })
  })

  it('never throws when arguments are not an object', () => {
    const { ev } = fixture()
    const state = applyEvent(emptyTranscript(), ev('tool/call', {
      turn: 1, step: 1, callId: 'x', name: 'n', arguments: '[1,2,3]',
    }))
    assert.equal(ofKind(state, 'tool')[0]?.call.argumentsRaw, '[1,2,3]')
    assert.equal(ofKind(state, 'tool')[0]?.call.args, undefined)
  })
})

describe('unknown and future event types', () => {
  it('ignores unknown types silently when ignorable is true or absent', () => {
    const { ev } = fixture()
    const before = applyEvent(emptyTranscript(), ev('turn/start', { turn: 1 }))
    const ignored = applyEvent(before, ev('future/event', { payload: 1 }, { ignorable: true }))
    const unmarked = applyEvent(ignored, ev('brand-new/type', { x: 1 }))
    assert.equal(ofKind(unmarked, 'notice').length, 0)
    assert.equal(unmarked.lastSeq, 2)
    assert.equal(unmarked.items.length, before.items.length)
  })

  it('appends a notice only when ignorable === false', () => {
    const { ev } = fixture()
    const state = applyEvent(
      emptyTranscript(),
      ev('future/required', { n: 1 }, { ignorable: false }),
    )
    const notices = ofKind(state, 'notice')
    assert.equal(notices.length, 1)
    assert.match(notices[0]?.text ?? '', /future\/required/)
  })

  it('does not notice known log-only types such as todo/write or request/header', () => {
    const { ev } = fixture()
    const state = foldAll([
      ev('todo/write', { todos: [] }),
      ev('request/header', { header: {}, reason: 'initial' }),
      ev('session/end-seed', {}),
      ev('compaction/start', { compactionId: 'c1', turn: 1 }),
    ])
    assert.equal(ofKind(state, 'notice').length, 0)
    assert.equal(state.lastSeq, 3)
  })

  it('never throws on a malformed payload', () => {
    const { ev } = fixture()
    assert.doesNotThrow(() => {
      applyEvent(emptyTranscript(), ev('assistant/chunk', null))
      applyEvent(emptyTranscript(), ev('assistant/message', { turn: 'nope' }))
      applyEvent(emptyTranscript(), ev('tool/result', { message: 'bad' }))
    })
  })
})

describe('token usage', () => {
  it('folds additively across steps from assistant/message only', () => {
    const { ev } = fixture()
    const usage1: TokenUsage = { inputTokens: 10, outputTokens: 5, reasoningTokens: 3 }
    const usage2: TokenUsage = { inputTokens: 20, outputTokens: 8, cacheReadTokens: 4 }
    let state = foldAll([
      ev('turn/start', { turn: 1 }),
      ev('assistant/chunk', {
        turn: 1, step: 1,
        chunk: { type: 'usage', usage: usage1 },
      }),
      ev('assistant/message', {
        turn: 1, step: 1,
        message: assistantMessage([{ type: 'text', text: 'a' }]),
        usage: usage1,
      }, { surfaceOp: 'append' }),
      ev('assistant/message', {
        turn: 1, step: 2,
        message: assistantMessage([{ type: 'text', text: 'b' }]),
        usage: usage2,
      }, { surfaceOp: 'append' }),
    ])
    assert.equal(state.usage.inputTokens, 30)
    assert.equal(state.usage.outputTokens, 13)
    assert.equal(state.usage.reasoningTokens, 3)
    assert.equal(state.usage.cacheReadTokens, 4)
  })
})

describe('surfaceOp and compaction replacements', () => {
  it('skips replacement user/message and assistant/message so originals stay', () => {
    const { ev } = fixture()
    const state = foldAll([
      ev('user/message', userMessage('original prompt'), { surfaceOp: 'append' }),
      ev('assistant/message', {
        turn: 1, step: 1,
        message: assistantMessage([{ type: 'text', text: 'original reply' }]),
      }, { surfaceOp: 'append' }),
      ev('user/message', userMessage('COMPACTION SUMMARY'), {
        surfaceOp: { op: 'replace', start: 0, end: 1 },
        sourceEventSeqs: [0, 1],
      }),
      ev('assistant/message', {
        turn: 1, step: 1,
        message: assistantMessage([{ type: 'text', text: 'model-only rewrite' }]),
      }, { surfaceOp: { op: 'replace', start: 1, end: 1 }, sourceEventSeqs: [1] }),
    ])
    assert.equal(ofKind(state, 'user').length, 1)
    assert.equal(ofKind(state, 'user')[0]?.text, 'original prompt')
    assert.equal(ofKind(state, 'assistant').length, 1)
    assert.equal(ofKind(state, 'assistant')[0]?.text, 'original reply')
  })
})

describe('phase', () => {
  it('turn/start → streaming, reasoning with no text → thinking, tool → tool, turn/end → idle', () => {
    const { ev } = fixture()
    let state = applyEvent(emptyTranscript(), ev('turn/start', { turn: 2 }))
    assert.equal(state.phase, 'streaming')
    assert.equal(state.currentTurn, 2)
    assert.equal(typeof state.turnStartedAt, 'number')

    state = applyEvent(state, ev('assistant/chunk', {
      turn: 2, step: 1,
      chunk: { type: 'reasoning-delta', index: 0, text: 'hmm' },
    }))
    assert.equal(state.phase, 'thinking')

    state = applyEvent(state, ev('assistant/chunk', {
      turn: 2, step: 1,
      chunk: { type: 'text-delta', index: 1, text: 'go' },
    }))
    assert.equal(state.phase, 'streaming')

    state = applyEvent(state, ev('assistant/chunk', {
      turn: 2, step: 1,
      chunk: { type: 'tool-call-delta', index: 2, id: 'c', name: 'bash', argumentsDelta: '{}' },
    }))
    assert.equal(state.phase, 'tool')

    state = applyEvent(state, ev('turn/end', { turn: 2, reason: { kind: 'completed' } }))
    assert.equal(state.phase, 'idle')
    assert.equal(state.turnStartedAt, undefined)
    assert.equal(ofKind(state, 'turn-end')[0]?.reason, 'completed')
    assert.equal(ofKind(state, 'tool')[0]?.call.status, 'cancelled')
  })

  it('opens the turn from the first in-flight chunk when turn/start is off-page', () => {
    const { ev } = fixture()
    const state = applyEvent(emptyTranscript(), ev('assistant/chunk', {
      turn: 4, step: 2,
      chunk: { type: 'reasoning-delta', index: 0, text: '…' },
    }))
    assert.equal(state.phase, 'thinking')
    assert.equal(state.currentTurn, 4)
    assert.equal(typeof state.turnStartedAt, 'number')
  })

  it('maps turn/end error.kind to a display string and appends an error item', () => {
    const { ev } = fixture()
    const state = foldAll([
      ev('turn/start', { turn: 1 }),
      ev('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'X' } } }),
    ])
    assert.equal(ofKind(state, 'turn-end')[0]?.reason, 'error: boom')
    assert.equal(ofKind(state, 'error')[0]?.text, 'error: boom')
    assert.equal(state.phase, 'idle')
  })
})

describe('purity', () => {
  it('does not mutate the input state', () => {
    const { ev } = fixture()
    const start = emptyTranscript()
    const after = applyEvent(start, ev('user/message', userMessage('x'), { surfaceOp: 'append' }))
    assert.equal(start.items.length, 0)
    assert.equal(start.lastSeq, -1)
    assert.notEqual(after.items, start.items)
  })
})

describe('retry visibility', () => {
  const retryData = {
    retryId: 'rty-1',
    turn: 1,
    step: 1,
    provider: 'deepseek',
    mode: 'normal' as const,
    policyKey: '["normal",2,["RATE_LIMIT"],500]',
    retry: 1,
    maxRetries: 2,
    delayMs: 500,
    failure: { message: 'busy', code: 'RATE_LIMIT', status: 429 },
  }

  it('sets and increments retrying without dropping streamed blocks, then clears', () => {
    const { ev } = fixture()
    let state = foldAll([
      ev('turn/start', { turn: 1 }),
      ev('assistant/chunk', {
        turn: 1, step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'partial' } satisfies StreamChunk,
      }),
    ])
    assert.equal(ofKind(state, 'assistant')[0]?.text, 'partial')
    assert.equal(state.retrying, undefined)

    state = applyEvent(state, ev('llm/retry', retryData))
    assert.equal(state.retrying?.count, 1)
    assert.equal(state.retrying?.reason, 'RATE_LIMIT')
    assert.equal(typeof state.retrying?.at, 'number')
    assert.equal(ofKind(state, 'assistant')[0]?.text, 'partial')

    state = applyEvent(state, ev('llm/retry-started', {
      retryId: 'rty-1', turn: 1, step: 1, retry: 1,
    }))
    assert.equal(state.retrying?.count, 2)
    assert.equal(state.retrying?.reason, 'RATE_LIMIT')

    const replayed = applyEvent(state, {
      type: 'llm/retry',
      seq: state.lastSeq,
      time: 1,
      data: retryData,
    })
    assert.equal(replayed, state)

    state = applyEvent(state, ev('assistant/chunk', {
      turn: 1, step: 1,
      chunk: { type: 'text-delta', index: 0, text: ' more' } satisfies StreamChunk,
    }))
    assert.equal(state.retrying, undefined)
    assert.equal(ofKind(state, 'assistant')[0]?.text, 'partial more')
  })

  it('clears retrying on assistant/message, step/end, and turn/end', () => {
    const { ev } = fixture()
    let state = foldAll([
      ev('turn/start', { turn: 1 }),
      ev('llm/retry', retryData),
    ])
    assert.equal(state.retrying?.count, 1)

    state = applyEvent(state, ev('assistant/message', {
      turn: 1, step: 1,
      message: assistantMessage([{ type: 'text', text: 'ok' }]),
    }, { surfaceOp: 'append' }))
    assert.equal(state.retrying, undefined)

    state = applyEvent(state, ev('llm/retry', { ...retryData, retry: 2 }))
    state = applyEvent(state, ev('step/end', { turn: 1, step: 1 }))
    assert.equal(state.retrying, undefined)

    state = applyEvent(state, ev('llm/retry', { ...retryData, retry: 3 }))
    state = applyEvent(state, ev('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'gave up', code: 'RATE_LIMIT' } } }))
    assert.equal(state.retrying, undefined)
    assert.equal(state.phase, 'idle')
  })
})

describe('images in committed messages', () => {
  it('extracts durable attachment image blocks from user and assistant messages', () => {
    const { ev } = fixture()
    const userWithImage: Message = {
      role: 'user',
      content: [
        {
          type: 'image',
          attachment: {
            attachmentId: 'att-1',
            mediaType: 'image/png',
            bytes: 84,
            width: 1,
            height: 1,
          },
        },
        { type: 'text', text: 'what is this?' },
      ],
      source: { kind: 'user' },
    }
    const state = foldAll([
      ev('turn/start', { turn: 1 }),
      ev('user/message', userWithImage, { surfaceOp: 'append' }),
      ev('assistant/message', {
        turn: 1,
        step: 1,
        message: assistantMessage([
          { type: 'text', text: 'a pixel' },
          {
            type: 'image',
            attachment: {
              attachmentId: 'att-2',
              mediaType: 'image/jpeg',
              bytes: 12,
              width: 2,
              height: 2,
            },
          },
        ]),
      }, { surfaceOp: 'append' }),
    ])

    const users = ofKind(state, 'user')
    assert.equal(users.length, 1)
    assert.equal(users[0]?.text, 'what is this?')

    const images = ofKind(state, 'image')
    assert.equal(images.length, 2)
    assert.equal(images[0]?.attachmentId, 'att-1')
    assert.equal(images[0]?.mediaType, 'image/png')
    assert.equal(images[0]?.alt, 'image (png)')
    assert.equal(images[0]?.turn, 1)
    assert.equal(images[0]?.step, 0)
    assert.equal(images[1]?.attachmentId, 'att-2')
    assert.equal(images[1]?.mediaType, 'image/jpeg')
    assert.equal(images[1]?.alt, 'image (jpeg)')
    assert.equal(images[1]?.turn, 1)
    assert.equal(images[1]?.step, 1)
  })
})

describe('turn-end elapsed and per-turn usage', () => {
  it('records elapsedMs from turn/start time and usage for that turn only', () => {
    const { ev } = fixture()
    const usage1: TokenUsage = { inputTokens: 10, outputTokens: 4 }
    const usage2: TokenUsage = { inputTokens: 7, outputTokens: 3, reasoningTokens: 2 }

    let state = foldAll([
      ev('turn/start', { turn: 1 }),
      ev('assistant/message', {
        turn: 1, step: 1,
        message: assistantMessage([{ type: 'text', text: 'a' }]),
        usage: usage1,
      }, { surfaceOp: 'append' }),
    ])
    const startTime = state.turnStartedAt
    assert.equal(typeof startTime, 'number')

    const end1 = ev('turn/end', { turn: 1, reason: { kind: 'stop' } })
    state = applyEvent(state, end1)
    const first = ofKind(state, 'turn-end')[0]
    assert.equal(first?.reason, 'stop')
    assert.equal(first?.elapsedMs, end1.time - (startTime ?? 0))
    assert.deepEqual(first?.usage, usage1)
    assert.equal(state.usage.inputTokens, 10)
    assert.equal(state.turnStartedAt, undefined)

    state = applyEvent(state, ev('turn/start', { turn: 2 }))
    state = applyEvent(state, ev('assistant/message', {
      turn: 2, step: 1,
      message: assistantMessage([{ type: 'text', text: 'b' }]),
      usage: usage2,
    }, { surfaceOp: 'append' }))
    const start2 = state.turnStartedAt
    const end2 = ev('turn/end', { turn: 2, reason: { kind: 'stop' } })
    state = applyEvent(state, end2)
    const ends = ofKind(state, 'turn-end')
    assert.equal(ends.length, 2)
    assert.equal(ends[1]?.elapsedMs, end2.time - (start2 ?? 0))
    assert.deepEqual(ends[1]?.usage, usage2)
    assert.equal(ends[0]?.usage?.inputTokens, 10)
    assert.equal(state.usage.inputTokens, 17)
    assert.equal(state.usage.outputTokens, 7)
    assert.equal(state.usage.reasoningTokens, 2)
  })
})
