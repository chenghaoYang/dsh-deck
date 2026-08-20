import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DeckApp } from '../src/ui/app.ts'
import { DeckStore } from '../src/model/store.ts'
import type { Key } from '../src/term/input.ts'
import type { AskUserQuestionItem } from '../src/protocol/contract.ts'
import {
  createCommandPalette,
  createQuestionOverlay,
  reducePickerOverlay,
  type PickerOverlayState,
} from '../src/ui/overlay.ts'

interface AppInternals {
  client: {
    call(method: string, payload: unknown): Promise<unknown>
    respondError(rpcId: string, error: unknown): Promise<unknown>
  }
  store: DeckStore
  overlay?: unknown
  draft: string
  cursor: number
  openPicker(): Promise<void>
  maybeOpenCommandPalette(): Promise<void>
  archiveSession(id: string): Promise<void>
  send(mode: 'queue' | 'steer'): Promise<void>
  onOverlayKey(overlay: unknown, key: Key): void
}

function internals(app: DeckApp): AppInternals {
  return app as unknown as AppInternals
}

function modelCatalog(): unknown {
  return {
    current: {
      provider: 'nvidia',
      model: 'thinkingmachines/inkling',
      reasoningEffort: 'low',
    },
    groups: [{
      id: 'nvidia',
      name: 'NVIDIA NIM',
      models: [{
        id: 'thinkingmachines/inkling',
        name: 'Inkling (NVIDIA)',
        reasoning: {
          efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }],
          defaultEffort: 'medium',
        },
      }],
    }],
  }
}

describe('DeckApp model picker', () => {
  it('syncs the host current model and effort before opening the picker', async () => {
    const app = new DeckApp({ baseUrl: 'http://127.0.0.1:3080', cwd: process.cwd() })
    const view = internals(app)
    view.store.applySessionList([{
      sessionId: 'session-1',
      updatedAt: 1,
      running: false,
      blank: false,
    }])
    view.store.focus('session-1')
    view.client.call = async (method) => {
      assert.equal(method, 'session.models')
      return { ok: true, value: modelCatalog() }
    }

    await view.openPicker()

    assert.deepEqual(view.store.get('session-1')?.modes.model, {
      provider: 'nvidia',
      model: 'thinkingmachines/inkling',
      effort: 'low',
    })

    const overlay = view.overlay
    assert.equal(typeof overlay, 'object')
    if (typeof overlay !== 'object' || overlay === null) return
    assert.equal((overlay as { kind?: unknown }).kind, 'picker')
    const state = (overlay as { state?: unknown }).state as PickerOverlayState | undefined
    assert.ok(state !== undefined)
    const current = state.models.find((model) => model.current === true)
    assert.equal(current?.currentEffort, 'low')

    const effortStage = reducePickerOverlay(state, { kind: 'enter' })
    assert.equal(effortStage.kind, 'continue')
    if (effortStage.kind !== 'continue') return
    assert.equal(effortStage.state.effortCursor, 0)
    const picked = reducePickerOverlay(effortStage.state, { kind: 'enter' })
    assert.deepEqual(picked, {
      kind: 'picked',
      selection: {
        provider: 'nvidia',
        model: 'thinkingmachines/inkling',
        reasoningEffort: 'low',
      },
    })
  })
})

describe('DeckApp question cancellation', () => {
  it('sends cancelled and waits for question/resolved to clear the pending card', async () => {
    const app = new DeckApp({ baseUrl: 'http://127.0.0.1:3080', cwd: process.cwd() })
    const view = internals(app)
    const questions: AskUserQuestionItem[] = [{
      id: 'q1',
      question: 'Continue?',
      options: [{ label: 'yes' }, { label: 'no' }],
    }]
    view.store.applySessionList([{
      sessionId: 'session-question',
      updatedAt: 1,
      running: true,
      blank: false,
    }])
    view.store.applyMux({
      type: 'question/requested',
      sessionId: 'session-question',
      questions,
    }, 'question-rpc')

    let sent: { rpcId: string; error: unknown } | undefined
    view.client.respondError = async (rpcId, error) => {
      sent = { rpcId, error }
      return { accepted: true }
    }
    const overlay = {
      kind: 'question',
      sessionId: 'session-question',
      rpcId: 'question-rpc',
      state: createQuestionOverlay(questions),
    }
    view.overlay = overlay
    view.onOverlayKey(overlay, { kind: 'ctrl', char: 'c' })
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    assert.deepEqual(sent, {
      rpcId: 'question-rpc',
      error: {
        code: 'cancelled',
        message: 'the user cancelled ask_user_question',
        details: {},
      },
    })
    assert.equal(view.overlay, undefined)
    assert.equal(view.store.get('session-question')?.pendingQuestion?.rpcId, 'question-rpc')

    view.store.applyMux({
      type: 'question/resolved',
      sessionId: 'session-question',
      questionRpcId: 'question-rpc',
      outcome: 'cancelled',
    }, 'question-resolved')
    assert.equal(view.store.get('session-question')?.pendingQuestion, undefined)
  })
})

describe('DeckApp slash commands', () => {
  function focusedApp(): { app: DeckApp; view: AppInternals } {
    const app = new DeckApp({ baseUrl: 'http://127.0.0.1:3080', cwd: process.cwd() })
    const view = internals(app)
    view.store.applySessionList([{
      sessionId: 'session-command',
      updatedAt: 1,
      running: false,
      blank: false,
    }])
    view.store.focus('session-command')
    return { app, view }
  }

  it('merges Deck actions with the live host catalog and /model opens the picker', async () => {
    const { view } = focusedApp()
    const calls: string[] = []
    view.client.call = async (method) => {
      calls.push(method)
      if (method === 'commands/list') {
        return { ok: true, value: [{ name: 'plan', description: 'Toggle plan mode' }] }
      }
      if (method === 'session.models') return { ok: true, value: modelCatalog() }
      throw new Error(`unexpected ${method}`)
    }
    view.draft = '/mo'
    view.cursor = 3

    await view.maybeOpenCommandPalette()
    const overlay = view.overlay as { kind?: string; state?: ReturnType<typeof createCommandPalette> }
    assert.equal(overlay.kind, 'commands')
    assert.ok(overlay.state?.commands.some((command) => command.name === 'model'))
    assert.ok(overlay.state?.commands.some((command) => command.name === 'plan'))
    view.onOverlayKey(overlay, { kind: 'enter' })
    await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(calls, ['commands/list', 'session.models'])
    assert.equal((view.overlay as { kind?: string } | undefined)?.kind, 'picker')
  })

  it('routes a completed command with arguments through commands/execute, never session.prompt', async () => {
    const { view } = focusedApp()
    const calls: { method: string; payload: unknown }[] = []
    view.client.call = async (method, payload) => {
      calls.push({ method, payload })
      return {
        ok: true,
        value: method === 'commands/execute'
          ? { commandId: 'plan', result: { kind: 'success', text: 'Plan mode off.' } }
          : { accepted: true },
      }
    }
    view.draft = '/plan off'
    view.cursor = 9

    await view.send('queue')

    assert.deepEqual(calls, [{
      method: 'commands/execute',
      payload: { args: { agentId: 'session-command', line: '/plan off', images: [] } },
    }])
    assert.equal(view.draft, '')
  })
})

describe('DeckApp session management', () => {
  it('archives the focused session, keeps its log, and focuses the next session', async () => {
    const app = new DeckApp({ baseUrl: 'http://127.0.0.1:3080', cwd: process.cwd() })
    const view = internals(app)
    view.store.applySessionList([
      { sessionId: 'archive-me', updatedAt: 2, running: false, blank: false },
      { sessionId: 'keep-me', updatedAt: 1, running: false, blank: false },
    ])
    view.store.focus('archive-me')
    const calls: { method: string; payload: unknown }[] = []
    view.client.call = async (method, payload) => {
      calls.push({ method, payload })
      if (method === 'workspace.archiveSession') {
        return { ok: true, value: { archivedSessionIds: ['archive-me'] } }
      }
      if (method === 'session.history') return { ok: true, value: { events: [], hasMore: false } }
      if (method === 'session.models') return { ok: true, value: modelCatalog() }
      throw new Error(`unexpected ${method}`)
    }

    await view.archiveSession('archive-me')

    assert.equal(view.store.focusedId, 'keep-me')
    assert.deepEqual(view.store.sessions.map((session) => session.id), ['keep-me'])
    assert.deepEqual(calls[0], {
      method: 'workspace.archiveSession',
      payload: { sessionId: 'archive-me' },
    })
  })
})
