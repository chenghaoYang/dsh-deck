import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DeckStore, type StoreChange } from '../src/model/store.ts'
import type {
  HistoryEntry,
  HostFrame,
  Message,
  MuxFrame,
  SessionEvent,
  SessionSummary,
} from '../src/protocol/contract.ts'

function flush(): Promise<void> {
  return new Promise((resolve) => {
    queueMicrotask(resolve)
  })
}

function ev(seq: number, type: string, data: unknown, extra?: Partial<SessionEvent>): SessionEvent {
  const event: SessionEvent = { type, seq, time: 1_000 + seq, data }
  return extra === undefined ? event : { ...event, ...extra }
}

function user(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function assistant(text: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'p', model: 'm' },
  }
}

function summary(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: id,
    updatedAt: extra.updatedAt ?? 100,
    running: extra.running ?? false,
    blank: extra.blank ?? false,
    ...extra.cwd !== undefined ? { cwd: extra.cwd } : {},
    ...extra.origin !== undefined ? { origin: extra.origin } : {},
    ...extra.parentSessionId !== undefined ? { parentSessionId: extra.parentSessionId } : {},
  }
}

function collect(store: DeckStore): { events: StoreChange[]; stop: () => void } {
  const events: StoreChange[] = []
  const stop = store.subscribe((event) => {
    events.push(event)
  })
  return { events, stop }
}

describe('DeckStore notifications', () => {
  it('coalesces a token storm onto one microtask notification', async () => {
    const store = new DeckStore()
    store.applySessionList([summary('s1')])
    store.focus('s1')
    await flush()
    const { events, stop } = collect(store)

    for (let i = 0; i < 40; i++) {
      const frame: MuxFrame = {
        type: 'session/event',
        sessionId: 's1',
        event: ev(i, 'assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', index: 0, text: `t${i}` },
        }),
      }
      store.applyMux(frame, 'rpc')
    }

    assert.equal(events.length, 0, 'notifications must not flush synchronously')
    await flush()
    const transcripts = events.filter((event) => event.kind === 'transcript')
    assert.equal(transcripts.length, 1)
    assert.deepEqual(transcripts[0], { kind: 'transcript', sessionId: 's1' })
    assert.ok(events.length < 10, `expected a coalesced batch, got ${events.length}`)
    stop()
  })

  it('unsubscribe stops further notifications', async () => {
    const store = new DeckStore()
    const { events, stop } = collect(store)
    store.applySessionList([summary('s1')])
    stop()
    store.applySessionList([summary('s2')])
    await flush()
    assert.equal(events.length, 0)
  })
})

describe('unread and focus', () => {
  it('increments unread only for non-focused sessions and resets on focus', async () => {
    const store = new DeckStore()
    store.applySessionList([summary('alpha'), summary('beta')])
    store.focus('alpha')
    await flush()

    store.applyMux({
      type: 'session/event',
      sessionId: 'alpha',
      event: ev(0, 'user/message', user('focused'), { surfaceOp: 'append' }),
    }, 'r1')
    store.applyMux({
      type: 'session/event',
      sessionId: 'beta',
      event: ev(0, 'user/message', user('background'), { surfaceOp: 'append' }),
    }, 'r2')
    store.applyMux({
      type: 'session/event',
      sessionId: 'beta',
      event: ev(1, 'assistant/message', {
        turn: 1, step: 1, message: assistant('ok'),
      }, { surfaceOp: 'append' }),
    }, 'r3')
    await flush()

    assert.equal(store.get('alpha')?.unread, 0)
    assert.equal(store.get('beta')?.unread, 2)

    store.focus('beta')
    await flush()
    assert.equal(store.get('beta')?.unread, 0)
    assert.equal(store.focusedId, 'beta')
  })
})

describe('blank sessions and sort order', () => {
  it('hides blank sessions from the visible list but keeps them addressable', async () => {
    const store = new DeckStore()
    store.applyHost({
      type: 'host/session-added',
      sessionId: 'blank-1',
      blank: true,
      cwd: '/tmp',
    }, 'rpc')
    store.applyHost({
      type: 'host/session-added',
      sessionId: 'live-1',
      blank: false,
    }, 'rpc')
    await flush()

    assert.equal(store.sessions.some((session) => session.id === 'blank-1'), false)
    assert.equal(store.get('blank-1')?.blank, true)
    assert.equal(store.get('blank-1')?.cwd, '/tmp')
    assert.equal(store.sessions.some((session) => session.id === 'live-1'), true)
  })

  it('sorts running first, then updatedAt descending', async () => {
    const store = new DeckStore()
    store.applySessionList([
      summary('old-idle', { running: false, updatedAt: 10 }),
      summary('new-idle', { running: false, updatedAt: 50 }),
      summary('old-run', { running: true, updatedAt: 1 }),
      summary('new-run', { running: true, updatedAt: 40 }),
      summary('ghost', { running: false, updatedAt: 99, blank: true }),
    ])
    await flush()
    assert.deepEqual(store.sessions.map((session) => session.id), [
      'new-run',
      'old-run',
      'new-idle',
      'old-idle',
    ])
  })
})

describe('session titles via projection', () => {
  it('applies higher-seq-wins per (sessionId, key) and accepts any key containing title', async () => {
    const store = new DeckStore()
    store.applySessionList([summary('s')])

    const frame = (key: string, value: unknown, seq: number): MuxFrame => ({
      type: 'session/projection',
      sessionId: 's',
      key,
      value,
      seq,
    })

    store.applyMux(frame('title', 'Old', 1), 'r')
    store.applyMux(frame('title', 'New', 5), 'r')
    store.applyMux(frame('title', 'Stale', 3), 'r')
    store.applyMux(frame('todos', 'not-a-title', 20), 'r')
    await flush()
    assert.equal(store.get('s')?.title, 'New')

    store.applyMux(frame('sessionTitle', 'From other key', 10), 'r')
    await flush()
    assert.equal(store.get('s')?.title, 'From other key')
    store.applyMux(frame('display-title', 'From hyphen key', 12), 'r')
    await flush()
    assert.equal(store.get('s')?.title, 'From hyphen key')

    store.applyMux(frame('title', 12345, 13), 'r')
    await flush()
    assert.equal(store.get('s')?.title, 'From hyphen key')
  })
})

describe('mux events and history overlap', () => {
  it('folds session/event into the transcript', async () => {
    const store = new DeckStore()
    store.applyMux({
      type: 'session/event',
      sessionId: 's',
      event: ev(0, 'turn/start', { turn: 1 }),
    }, 'r')
    store.applyMux({
      type: 'session/event',
      sessionId: 's',
      event: ev(1, 'user/message', user('hi'), { surfaceOp: 'append' }),
    }, 'r')
    await flush()
    const session = store.get('s')
    assert.equal(session?.transcript.phase, 'streaming')
    assert.equal(session?.blank, false)
    assert.equal(session?.running, true)
    assert.equal(session?.transcript.items[0]?.kind, 'user')
  })

  it('history page then overlapping live frames does not duplicate', async () => {
    const events: SessionEvent[] = [
      ev(0, 'turn/start', { turn: 1 }),
      ev(1, 'user/message', user('q'), { surfaceOp: 'append' }),
      ev(2, 'assistant/chunk', {
        turn: 1, step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'hel' },
      }),
      ev(3, 'assistant/message', {
        turn: 1, step: 1, message: assistant('hello'),
      }, { surfaceOp: 'append' }),
    ]
    const store = new DeckStore()
    store.applyHistoryPage('s', events.map((event): HistoryEntry => ({ event })), false)
    store.applyMux({ type: 'session/event', sessionId: 's', event: events[2]! }, 'r')
    store.applyMux({ type: 'session/event', sessionId: 's', event: events[3]! }, 'r')
    await flush()
    const items = store.get('s')?.transcript.items ?? []
    assert.equal(items.filter((item) => item.kind === 'user').length, 1)
    assert.equal(items.filter((item) => item.kind === 'assistant').length, 1)
    const assistantItem = items.find((item) => item.kind === 'assistant')
    assert.ok(assistantItem?.kind === 'assistant')
    assert.equal(assistantItem.text, 'hello')
    assert.equal(store.get('s')?.historyLoaded, true)
    assert.equal(store.get('s')?.hasMoreHistory, false)
  })

  it('prepends an older history page below the live tail', async () => {
    const store = new DeckStore()
    store.applyHistoryPage('s', [
      { event: ev(10, 'user/message', user('tail'), { surfaceOp: 'append' }) },
    ], true)
    store.applyHistoryPage('s', [
      { event: ev(0, 'user/message', user('old'), { surfaceOp: 'append' }) },
      { event: ev(1, 'assistant/message', { turn: 1, step: 1, message: assistant('old-a') }, { surfaceOp: 'append' }) },
    ], false)
    await flush()
    const texts = (store.get('s')?.transcript.items ?? []).map((item) => {
      if (item.kind === 'user' || item.kind === 'assistant') return item.text
      return item.kind
    })
    assert.deepEqual(texts, ['old', 'old-a', 'tail'])
    assert.equal(store.get('s')?.hasMoreHistory, false)
  })
})

describe('approvals, host frames, reset', () => {
  it('records pending approval and clears it on resolve', async () => {
    const store = new DeckStore()
    store.applyMux({
      type: 'session/event',
      sessionId: 's',
      event: ev(0, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' }),
    }, 'r')
    store.applyMux({
      type: 'approval/requested',
      sessionId: 's',
      approvalId: 'ap1',
      toolName: 'bash',
      callId: 'c1',
      reason: 'dangerous',
    }, 'rpc-approve')
    await flush()
    const pending = store.get('s')?.pendingApproval
    assert.equal(pending?.rpcId, 'rpc-approve')
    assert.equal(pending?.approvalId, 'ap1')
    assert.equal(pending?.callId, 'c1')
    const tool = store.get('s')?.transcript.items.find((item) => item.kind === 'tool')
    assert.ok(tool?.kind === 'tool')
    assert.equal(tool.call.status, 'awaiting-approval')

    store.applyMux({
      type: 'approval/resolved',
      sessionId: 's',
      approvalId: 'ap1',
      outcome: 'allowed-once',
    }, 'rpc-done')
    await flush()
    assert.equal(store.get('s')?.pendingApproval, undefined)
    const after = store.get('s')?.transcript.items.find((item) => item.kind === 'tool')
    assert.ok(after?.kind === 'tool')
    assert.equal(after.call.status, 'running')
  })

  it('applies host status, errors, and removal', async () => {
    const store = new DeckStore()
    const added: HostFrame = { type: 'host/session-added', sessionId: 's', blank: false }
    store.applyHost(added, 'r')
    store.applyHost({ type: 'host/session-status', sessionId: 's', running: true }, 'r')
    store.applyHost({ type: 'host/agent-error', sessionId: 's', message: 'llm down' }, 'r')
    await flush()
    assert.equal(store.get('s')?.running, true)
    assert.equal(store.get('s')?.lastError, 'llm down')

    store.applyHost({ type: 'host/session-removed', sessionId: 's' }, 'r')
    await flush()
    assert.equal(store.get('s'), undefined)
    assert.equal(store.sessions.length, 0)
  })

  it('resetLiveState drops live transcript and approvals but keeps identity', async () => {
    const store = new DeckStore()
    store.applySessionList([summary('s', { cwd: '/work' })])
    store.applyMux({
      type: 'session/projection', sessionId: 's', key: 'title', value: 'Kept', seq: 2,
    }, 'r')
    store.applyMux({
      type: 'session/event',
      sessionId: 's',
      event: ev(0, 'user/message', user('live'), { surfaceOp: 'append' }),
    }, 'r')
    store.applyMux({
      type: 'approval/requested',
      sessionId: 's',
      approvalId: 'ap',
      toolName: 'bash',
    }, 'rpc')
    await flush()
    assert.ok((store.get('s')?.transcript.items.length ?? 0) > 0)
    assert.ok(store.get('s')?.pendingApproval)

    store.resetLiveState()
    await flush()
    const session = store.get('s')
    assert.equal(session?.title, 'Kept')
    assert.equal(session?.cwd, '/work')
    assert.equal(session?.transcript.items.length, 0)
    assert.equal(session?.transcript.lastSeq, -1)
    assert.equal(session?.pendingApproval, undefined)
    assert.equal(session?.running, false)
    assert.equal(session?.historyLoaded, false)
    assert.equal(session?.queue.length, 0)
  })

  it('applySessionList merges without wiping an existing transcript', async () => {
    const store = new DeckStore()
    store.applyMux({
      type: 'session/event',
      sessionId: 's',
      event: ev(0, 'user/message', user('kept'), { surfaceOp: 'append' }),
    }, 'r')
    store.applySessionList([summary('s', { running: true, updatedAt: 9, cwd: '/x' })])
    await flush()
    assert.equal(store.get('s')?.transcript.items[0]?.kind, 'user')
    assert.equal(store.get('s')?.running, true)
    assert.equal(store.get('s')?.cwd, '/x')
  })
})

describe('ask-user questions', () => {
  const questions = [
    { id: 'q1', question: 'Ship it?', options: [{ label: 'yes' }, { label: 'no' }] },
  ]

  it('sets pendingQuestion from the envelope rpcId, bumps unread, and clears on matching resolve', async () => {
    const store = new DeckStore()
    store.applySessionList([summary('alpha'), summary('beta')])
    store.focus('alpha')
    await flush()
    const { events, stop } = collect(store)

    store.applyMux({
      type: 'question/requested',
      sessionId: 'beta',
      questions,
    }, 'rpc-q1')
    store.applyMux({
      type: 'question/requested',
      sessionId: 'alpha',
      questions,
    }, 'rpc-q-focused')
    await flush()

    const pending = store.get('beta')?.pendingQuestion
    assert.equal(pending?.rpcId, 'rpc-q1')
    assert.equal(pending?.questions[0]?.id, 'q1')
    assert.equal(typeof pending?.at, 'number')
    assert.equal(store.get('beta')?.unread, 1)
    assert.equal(store.get('alpha')?.unread, 0)
    assert.equal(store.get('alpha')?.pendingQuestion?.rpcId, 'rpc-q-focused')
    assert.ok(events.some((event) => event.kind === 'question' && event.sessionId === 'beta'))

    store.applyMux({
      type: 'question/resolved',
      sessionId: 'beta',
      questionRpcId: 'someone-else',
      outcome: 'cancelled',
    }, 'nope')
    await flush()
    assert.equal(store.get('beta')?.pendingQuestion?.rpcId, 'rpc-q1')

    store.applyMux({
      type: 'question/resolved',
      sessionId: 'beta',
      questionRpcId: 'rpc-q1',
      outcome: 'answered',
    }, 'rpc-done')
    await flush()
    assert.equal(store.get('beta')?.pendingQuestion, undefined)
    assert.ok(events.some((event) => event.kind === 'question' && event.sessionId === 'beta'))
    stop()
  })

  it('preserves pendingQuestion across applySessionList and clears it on resetLiveState', async () => {
    const store = new DeckStore()
    store.applySessionList([summary('s', { cwd: '/work' })])
    store.applyMux({
      type: 'question/requested',
      sessionId: 's',
      questions,
    }, 'rpc-keep')
    await flush()
    assert.ok(store.get('s')?.pendingQuestion)

    store.applySessionList([summary('s', { running: true, updatedAt: 50, cwd: '/work' })])
    await flush()
    assert.equal(store.get('s')?.pendingQuestion?.rpcId, 'rpc-keep')
    assert.equal(store.get('s')?.pendingQuestion?.questions[0]?.question, 'Ship it?')

    store.resetLiveState()
    await flush()
    assert.equal(store.get('s')?.pendingQuestion, undefined)
    assert.equal(store.get('s')?.cwd, '/work')
  })
})

describe('session telemetry', () => {
  it('applies higher-seq-wins per key and ignores malformed values', async () => {
    const store = new DeckStore()
    store.applySessionList([summary('s')])
    const { events, stop } = collect(store)

    const frame = (key: string, value: unknown, seq: number): MuxFrame => ({
      type: 'session/projection',
      sessionId: 's',
      key,
      value,
      seq,
    })

    store.applyMux(frame('contextPressure', { contextWindow: 128_000 }, 1), 'r')
    store.applyMux(frame('contextBreakdown', {
      systemTokens: 1592, toolsTokens: 6409, messageTokens: 1945,
    }, 2), 'r')
    store.applyMux(frame('sessionStats', {
      turns: 1, steps: 2, llmMs: 10, toolMs: 4, ttftMs: 3, ttftSteps: 1, decodeMs: 6, decodeTokens: 20,
    }, 3), 'r')
    await flush()

    assert.equal(store.get('s')?.telemetry.contextWindow, 128_000)
    assert.deepEqual(store.get('s')?.telemetry.breakdown, {
      systemTokens: 1592, toolsTokens: 6409, messageTokens: 1945,
    })
    assert.equal(store.get('s')?.telemetry.stats?.turns, 1)
    assert.ok(events.some((event) => event.kind === 'status' && event.sessionId === 's'))

    store.applyMux(frame('contextPressure', { contextWindow: 64_000 }, 0), 'r')
    store.applyMux(frame('contextPressure', { contextWindow: 'nope' }, 8), 'r')
    store.applyMux(frame('contextBreakdown', { systemTokens: 1, toolsTokens: 2 }, 9), 'r')
    store.applyMux(frame('sessionStats', { turns: 99 }, 10), 'r')
    store.applyMux(frame('contextBreakdown', 'not-an-object', 11), 'r')
    await flush()
    assert.equal(store.get('s')?.telemetry.contextWindow, 128_000)
    assert.equal(store.get('s')?.telemetry.breakdown?.toolsTokens, 6409)
    assert.equal(store.get('s')?.telemetry.stats?.turns, 1)

    store.applyMux(frame('contextPressure', { contextWindow: 64_000 }, 12), 'r')
    store.applyMux(frame('sessionStats', {
      turns: 2, steps: 3, llmMs: 11, toolMs: 5, ttftMs: 3, ttftSteps: 2, decodeMs: 7, decodeTokens: 30,
    }, 13), 'r')
    await flush()
    assert.equal(store.get('s')?.telemetry.contextWindow, 64_000)
    assert.equal(store.get('s')?.telemetry.stats?.turns, 2)
    assert.equal(store.get('s')?.telemetry.stats?.steps, 3)
    stop()
  })
})
