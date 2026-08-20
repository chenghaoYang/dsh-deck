import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DeckApp } from '../src/ui/app.ts'
import { DeckStore } from '../src/model/store.ts'

interface AppInternals {
  client: { call(method: string, payload: unknown): Promise<unknown> }
  store: DeckStore
  draft: string
  cursor: number
  stopped: boolean
  insert(text: string): void
  focus(id: string): void
  send(mode: 'queue' | 'steer'): Promise<void>
}

function internals(app: DeckApp): AppInternals {
  return app as unknown as AppInternals
}

function appView(): AppInternals {
  const app = new DeckApp({ baseUrl: 'http://127.0.0.1:1', cwd: process.cwd(), printOnExit: false })
  const view = internals(app)
  view.stopped = true
  view.store.applySessionList([{
    sessionId: 'session-send',
    updatedAt: 1,
    running: false,
    blank: false,
  }])
  view.store.focus('session-send')
  return view
}

const failure = {
  ok: false as const,
  error: { code: 'internal', message: 'host unavailable', details: {} },
}

describe('DeckApp prompt failure recovery', () => {
  it('restores the original draft and caret when the prompt RPC fails', async () => {
    const view = appView()
    view.draft = 'retry this prompt'
    view.cursor = 5
    let resolveRpc!: (result: unknown) => void
    view.client.call = async (method) => {
      assert.equal(method, 'session.prompt')
      return new Promise((resolve) => { resolveRpc = resolve })
    }

    const sending = view.send('queue')
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    assert.equal(view.draft, '')
    assert.equal(view.cursor, 0)

    resolveRpc(failure)
    await sending
    assert.equal(view.draft, 'retry this prompt')
    assert.equal(view.cursor, 5)
  })

  it('does not overwrite a newer draft typed while the prompt is in flight', async () => {
    const view = appView()
    view.draft = 'old prompt'
    view.cursor = [...view.draft].length
    let resolveRpc!: (result: unknown) => void
    view.client.call = async () => new Promise((resolve) => { resolveRpc = resolve })

    const sending = view.send('queue')
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    view.insert('new prompt')
    resolveRpc(failure)
    await sending

    assert.equal(view.draft, 'new prompt')
    assert.equal(view.cursor, [...'new prompt'].length)
  })

  it('restores a failed prompt only to its source session after focus changes', async () => {
    const view = appView()
    view.store.applySessionList([
      { sessionId: 'session-send', updatedAt: 2, running: false, blank: false },
      { sessionId: 'session-b', updatedAt: 1, running: false, blank: false },
    ])
    view.draft = 'prompt for A'
    view.cursor = [...view.draft].length
    let resolvePrompt!: (result: unknown) => void
    view.client.call = async (method) => {
      if (method === 'session.prompt') return new Promise((resolve) => { resolvePrompt = resolve })
      if (method === 'session.history') return { ok: true, value: { events: [], hasMore: false } }
      if (method === 'session.models') return { ok: true, value: { groups: [] } }
      throw new Error(`unexpected ${method}`)
    }

    const sending = view.send('queue')
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    view.focus('session-b')
    view.insert('prompt for B')
    resolvePrompt(failure)
    await sending
    assert.equal(view.draft, 'prompt for B')

    view.focus('session-send')
    assert.equal(view.draft, 'prompt for A')
    view.focus('session-b')
    assert.equal(view.draft, 'prompt for B')
  })
})
