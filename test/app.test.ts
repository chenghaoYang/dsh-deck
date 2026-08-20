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
  type DeckCommandAction,
  type InfoOverlayState,
  type PickerOverlayState,
} from '../src/ui/overlay.ts'
import { createSwitcher, reduceSwitcher } from '../src/ui/switcher.ts'

interface AppInternals {
  client: {
    call(method: string, payload: unknown): Promise<unknown>
    respond(rpcId: string, value: unknown): Promise<unknown>
    respondError(rpcId: string, error: unknown): Promise<unknown>
  }
  store: DeckStore
  overlay?: unknown
  draft: string
  cursor: number
  openPicker(): Promise<void>
  maybeOpenCommandPalette(): Promise<void>
  maybeOpenQuestion(): void
  archiveSession(id: string): Promise<void>
  createSession(): Promise<void>
  answerApproval(outcome: 'allowed-once' | 'rejected'): Promise<void>
  pendingApprovalTarget(): unknown
  focus(id: string): void
  loadHistory(id: string): Promise<void>
  loadOlderHistory(id: string): Promise<void>
  cancel(): Promise<void>
  runDeckCommand(action: DeckCommandAction, input?: string): void
  send(mode: 'queue' | 'steer'): Promise<void>
  openSkills(): Promise<void>
  openAgents(): Promise<void>
  openWorkspaces(): Promise<void>
  openLatestImage(): Promise<void>
  openQueue(): void
  updateQueuedMessage(input: string, kind: 'remove' | 'steer'): Promise<void>
  onReady(host: unknown): Promise<void>
  sidebarSessions(): readonly { id: string }[]
  onOverlayKey(overlay: unknown, key: Key): void
  onKey(key: Key): void
  vimMode: boolean
  composerVim: 'insert' | 'normal'
  scrollbackFocus: boolean
  scrollOffset: number
  mouseEnabled: boolean
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

describe('DeckApp project startup', () => {
  it('focuses the newest primary session for the requested cwd', async () => {
    const app = new DeckApp({ baseUrl: 'http://127.0.0.1:3080', cwd: '/work/current' })
    const view = internals(app)
    view.client.call = async (method) => {
      if (method === 'workspace.list') return { ok: true, value: { items: [], archivedSessionIds: [] } }
      if (method === 'agentPreset.list') return { ok: true, value: { presets: [] } }
      if (method === 'session.list') {
        return {
          ok: true,
          value: {
            items: [
              { sessionId: 'other-project', cwd: '/work/other', updatedAt: 99, running: false, blank: false },
              { sessionId: 'current-old', cwd: '/work/current', updatedAt: 2, running: false, blank: false },
              { sessionId: 'current-new', cwd: '/work/current/', updatedAt: 3, running: false, blank: false },
              { sessionId: 'current-child', cwd: '/work/current', origin: 'subagent', updatedAt: 4, running: true, blank: false },
            ],
          },
        }
      }
      if (method === 'session.history') return { ok: true, value: { events: [], hasMore: false } }
      if (method === 'session.models') return { ok: true, value: modelCatalog() }
      throw new Error(`unexpected ${method}`)
    }

    await view.onReady({})
    assert.equal(view.store.focusedId, 'current-new')
  })

  it('creates a session in the requested cwd instead of opening another project', async () => {
    const app = new DeckApp({ baseUrl: 'http://127.0.0.1:3080', cwd: '/work/current' })
    const view = internals(app)
    const calls: { method: string; payload: unknown }[] = []
    view.client.call = async (method, payload) => {
      calls.push({ method, payload })
      if (method === 'workspace.list') return { ok: true, value: { items: [], archivedSessionIds: [] } }
      if (method === 'agentPreset.list') return { ok: true, value: { presets: [] } }
      if (method === 'session.list') {
        return {
          ok: true,
          value: { items: [{ sessionId: 'other-project', cwd: '/work/other', updatedAt: 99, running: false, blank: false }] },
        }
      }
      if (method === 'session.create') return { ok: true, value: { sessionId: 'new-current' } }
      if (method === 'session.history') return { ok: true, value: { events: [], hasMore: false } }
      if (method === 'session.models') return { ok: true, value: modelCatalog() }
      throw new Error(`unexpected ${method}`)
    }

    await view.onReady({})
    assert.equal(view.store.focusedId, 'new-current')
    assert.equal(view.store.get('new-current')?.cwd, '/work/current')
    assert.ok(calls.some((call) => (
      call.method === 'session.create'
      && JSON.stringify(call.payload) === JSON.stringify({ cwd: '/work/current' })
    )))
  })
})

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

describe('DeckApp interaction priority', () => {
  it('keeps approval ahead of question and opens the question after approval resolves', () => {
    const app = new DeckApp({ baseUrl: 'http://127.0.0.1:3080', cwd: process.cwd() })
    const view = internals(app)
    view.store.applySessionList([{
      sessionId: 'session-priority', updatedAt: 1, running: true, blank: false,
    }])
    view.store.focus('session-priority')
    view.store.applyMux({
      type: 'approval/requested',
      sessionId: 'session-priority',
      approvalId: 'approval-1',
      toolName: 'bash',
    }, 'approval-rpc')
    view.store.applyMux({
      type: 'question/requested',
      sessionId: 'session-priority',
      questions: [{ id: 'q1', question: 'Continue?', options: [{ label: 'yes' }] }],
    }, 'question-rpc')

    view.maybeOpenQuestion()
    assert.equal(view.overlay, undefined)

    view.store.applyMux({
      type: 'approval/resolved',
      sessionId: 'session-priority',
      approvalId: 'approval-1',
      outcome: 'allowed-once',
    }, 'approval-resolved')
    view.maybeOpenQuestion()
    assert.equal((view.overlay as { kind?: string } | undefined)?.kind, 'question')
  })

  it('does not let an awaited model picker overwrite a newer approval', async () => {
    const app = new DeckApp({ baseUrl: 'http://127.0.0.1:3080', cwd: process.cwd() })
    const view = internals(app)
    view.store.applySessionList([{
      sessionId: 'session-priority', updatedAt: 1, running: false, blank: false,
    }])
    view.store.focus('session-priority')
    let resolveModels!: (value: unknown) => void
    view.client.call = async () => new Promise((resolve) => { resolveModels = resolve })

    const opening = view.openPicker()
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    view.store.applyMux({
      type: 'approval/requested', sessionId: 'session-priority', approvalId: 'approval-1', toolName: 'bash',
    }, 'approval-rpc')
    resolveModels({ ok: true, value: modelCatalog() })
    await opening

    assert.equal(view.overlay, undefined)
  })

  it('opens a blocking question from an archived background session', () => {
    const app = new DeckApp({ baseUrl: 'http://127.0.0.1:3080', cwd: process.cwd() })
    const view = internals(app)
    view.store.applySessionList([
      { sessionId: 'archived-question', updatedAt: 2, running: true, blank: false },
      { sessionId: 'focused-session', updatedAt: 1, running: false, blank: false },
    ])
    view.store.focus('focused-session')
    view.store.applyArchivedBaseline(['archived-question'])
    view.store.applyMux({
      type: 'question/requested',
      sessionId: 'archived-question',
      questions: [{ id: 'q1', question: 'Continue?', options: [{ label: 'yes' }] }],
    }, 'archived-question-rpc')

    view.maybeOpenQuestion()
    assert.deepEqual(view.overlay !== undefined && typeof view.overlay === 'object'
      ? {
        kind: (view.overlay as { kind?: string }).kind,
        sessionId: (view.overlay as { sessionId?: string }).sessionId,
      }
      : undefined, {
      kind: 'question',
      sessionId: 'archived-question',
    })
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
      if (method === 'skill.list') return { ok: true, value: { skills: [] } }
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

    assert.deepEqual(calls, ['commands/list', 'skill.list', 'session.models'])
    assert.equal((view.overlay as { kind?: string } | undefined)?.kind, 'picker')
  })

  it('keeps user-only skills in the primary palette and skips skills for subagents', async () => {
    const { view } = focusedApp()
    const calls: string[] = []
    view.client.call = async (method) => {
      calls.push(method)
      if (method === 'commands/list') return { ok: true, value: [] }
      if (method === 'skill.list') {
        return {
          ok: true,
          value: {
            skills: [
              { name: 'private-doc', description: 'Private docs', modelInvocable: false },
              { name: 'review', description: 'Review code', modelInvocable: true },
            ],
          },
        }
      }
      throw new Error(`unexpected ${method}`)
    }
    view.draft = '/pri'
    view.cursor = 4
    await view.maybeOpenCommandPalette()

    const primary = view.overlay as { kind?: string; state?: ReturnType<typeof createCommandPalette> }
    assert.equal(primary.kind, 'commands')
    const privateSkill = primary.state?.commands.find((command) => command.name === 'private-doc')
    assert.equal(privateSkill?.description, 'user-only · Private docs')
    assert.deepEqual(calls, ['commands/list', 'skill.list'])

    const app = new DeckApp({ baseUrl: 'http://127.0.0.1:3080', cwd: process.cwd() })
    const child = internals(app)
    child.store.applySessionList([{
      sessionId: 'child-skill',
      parentSessionId: 'parent-skill',
      origin: 'subagent',
      updatedAt: 1,
      running: false,
      blank: false,
    }])
    child.store.focus('child-skill')
    const childCalls: string[] = []
    child.client.call = async (method) => {
      childCalls.push(method)
      if (method === 'commands/list') return { ok: true, value: [] }
      throw new Error(`unexpected ${method}`)
    }
    child.draft = '/'
    child.cursor = 1
    await child.maybeOpenCommandPalette()
    assert.deepEqual(childCalls, ['commands/list'])
    const childOverlay = child.overlay as { state?: ReturnType<typeof createCommandPalette> }
    assert.equal(childOverlay.state?.commands.some((command) => command.skill === true), false)
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
  it('keeps the sidebar scoped to the focused project while Ctrl+K stays global', () => {
    const app = new DeckApp({ baseUrl: 'http://127.0.0.1:3080', cwd: '/work/current' })
    const view = internals(app)
    view.store.applySessionList([
      { sessionId: 'current-a', cwd: '/work/current', updatedAt: 4, running: false, blank: false },
      { sessionId: 'current-b', cwd: '/work/current/', updatedAt: 3, running: false, blank: false },
      { sessionId: 'other', cwd: '/work/other', updatedAt: 2, running: false, blank: false },
      { sessionId: 'child', parentSessionId: 'current-a', origin: 'subagent', updatedAt: 1, running: false, blank: false },
    ])
    view.store.focus('current-a')

    assert.deepEqual(view.sidebarSessions().map((session) => session.id), ['current-a', 'current-b', 'child'])
    assert.equal(view.store.sessions.some((session) => session.id === 'other'), true)
  })

  it('focuses a newly-created conversation before the Host list frame arrives', async () => {
    const app = new DeckApp({ baseUrl: 'http://127.0.0.1:3080', cwd: '/work/current' })
    const view = internals(app)
    view.store.applySessionList([{
      sessionId: 'old', cwd: '/work/current', updatedAt: 1, running: false, blank: false,
    }])
    view.store.focus('old')
    view.client.call = async (method) => {
      if (method === 'session.create') return { ok: true, value: { sessionId: 'new-now' } }
      if (method === 'session.history') return { ok: true, value: { events: [], hasMore: false } }
      if (method === 'session.models') return { ok: true, value: modelCatalog() }
      throw new Error(`unexpected ${method}`)
    }

    await view.createSession()
    assert.equal(view.store.focusedId, 'new-now')
    assert.equal(view.store.get('new-now')?.cwd, '/work/current')
    assert.deepEqual(view.sidebarSessions().map((session) => session.id), ['new-now', 'old'])
  })

  it('keeps a separate draft and cursor for every session', () => {
    const app = new DeckApp({ baseUrl: 'http://127.0.0.1:3080', cwd: process.cwd() })
    const view = internals(app)
    view.store.applySessionList([
      { sessionId: 'session-a', updatedAt: 2, running: false, blank: false },
      { sessionId: 'session-b', updatedAt: 1, running: false, blank: false },
    ])
    view.client.call = async (method) => {
      if (method === 'session.history') return { ok: true, value: { events: [], hasMore: false } }
      if (method === 'session.models') return { ok: true, value: modelCatalog() }
      throw new Error(`unexpected ${method}`)
    }
    view.store.focus('session-a')
    view.draft = 'prompt for A'
    view.cursor = 7

    view.focus('session-b')
    assert.equal(view.draft, '')
    assert.equal(view.cursor, 0)
    view.draft = 'prompt for B'
    view.cursor = 12

    view.focus('session-a')
    assert.equal(view.draft, 'prompt for A')
    assert.equal(view.cursor, 7)
    view.focus('session-b')
    assert.equal(view.draft, 'prompt for B')
    assert.equal(view.cursor, 12)
  })

  it('loads an older history page using the earliest rendered seq', async () => {
    const app = new DeckApp({ baseUrl: 'http://127.0.0.1:3080', cwd: process.cwd() })
    const view = internals(app)
    view.store.applySessionList([{
      sessionId: 'history-session', updatedAt: 1, running: false, blank: false,
    }])
    view.store.applyHistoryPage('history-session', [{
      event: { type: 'user/message', seq: 10, time: 10, data: { role: 'user', content: [{ type: 'text', text: 'newer' }] } },
    }], true)
    view.client.call = async (method, payload) => {
      assert.equal(method, 'session.history')
      assert.deepEqual(payload, { sessionId: 'history-session', beforeSeq: 10, maxMessages: 80 })
      return {
        ok: true,
        value: {
          events: [{
            event: { type: 'user/message', seq: 5, time: 5, data: { role: 'user', content: [{ type: 'text', text: 'older' }] } },
          }],
          hasMore: false,
        },
      }
    }

    await view.loadOlderHistory('history-session')
    const texts = view.store.get('history-session')?.transcript.items
      .filter((item) => item.kind === 'user')
      .map((item) => item.text)
    assert.deepEqual(texts, ['older', 'newer'])
  })

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

  it('Return on the archive confirmation reaches workspace.archiveSession', async () => {
    const app = new DeckApp({ baseUrl: 'http://127.0.0.1:3080', cwd: process.cwd() })
    const view = internals(app)
    view.store.applySessionList([
      { sessionId: 'archive-me', updatedAt: 2, running: false, blank: false },
      { sessionId: 'keep-me', updatedAt: 1, running: false, blank: false },
    ])
    view.store.focus('archive-me')
    const calls: string[] = []
    view.client.call = async (method) => {
      calls.push(method)
      if (method === 'workspace.archiveSession') {
        return { ok: true, value: { archivedSessionIds: ['archive-me'] } }
      }
      if (method === 'session.history') return { ok: true, value: { events: [], hasMore: false } }
      if (method === 'session.models') return { ok: true, value: modelCatalog() }
      throw new Error(`unexpected ${method}`)
    }

    const start = createSwitcher([
      { id: 'archive-me', title: 'Archive me', running: false, unread: 0, blocked: false, updatedAt: 2 },
      { id: 'keep-me', title: 'Keep me', running: false, unread: 0, blocked: false, updatedAt: 1 },
    ], 'archive-me')
    const confirmation = reduceSwitcher(start, { kind: 'backspace' })
    assert.equal(confirmation.kind, 'continue')
    if (confirmation.kind !== 'continue') return
    const overlay = { kind: 'switcher' as const, state: confirmation.state }
    view.overlay = overlay

    view.onOverlayKey(overlay, { kind: 'enter' })
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(calls[0], 'workspace.archiveSession')
    assert.notEqual((view.overlay as { state?: { stage?: string } } | undefined)?.state?.stage, 'confirm-archive')
  })
})

describe('DeckApp common dsh controls', () => {
  function focusedRunningApp(): AppInternals {
    const app = new DeckApp({ baseUrl: 'http://127.0.0.1:3080', cwd: '/work/demo' })
    const view = internals(app)
    view.store.applySessionList([{
      sessionId: 'session-control',
      cwd: '/work/demo',
      updatedAt: 1,
      running: true,
      blank: false,
    }])
    view.store.focus('session-control')
    return view
  }

  it('/cancel calls session.cancel for the running session', async () => {
    const view = focusedRunningApp()
    const calls: { method: string; payload: unknown }[] = []
    view.client.call = async (method, payload) => {
      calls.push({ method, payload })
      return { ok: true, value: { accepted: true } }
    }
    view.runDeckCommand('cancel')
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(calls, [{ method: 'session.cancel', payload: { sessionId: 'session-control' } }])
  })

  it('/status opens a local information panel with project and running state', () => {
    const view = focusedRunningApp()
    view.runDeckCommand('status')
    const overlay = view.overlay as { kind?: string; state?: InfoOverlayState }
    assert.equal(overlay.kind, 'info')
    assert.ok(overlay.state?.lines.some((line) => line === 'Project: demo'))
    assert.ok(overlay.state?.lines.some((line) => line.includes('State: running')))
  })

  it('/skills uses skill.list and shows the scoped catalog', async () => {
    const view = focusedRunningApp()
    view.client.call = async (method, payload) => {
      assert.equal(method, 'skill.list')
      assert.deepEqual(payload, { sessionId: 'session-control' })
      return {
        ok: true,
        value: {
          skills: [
            { name: 'review', description: 'Review code', modelInvocable: true },
            { name: 'private-doc', description: 'Private docs', modelInvocable: false },
          ],
        },
      }
    }
    view.runDeckCommand('skills')
    await new Promise((resolve) => setImmediate(resolve))
    const overlay = view.overlay as { kind?: string; state?: InfoOverlayState }
    assert.equal(overlay.kind, 'info')
    assert.ok(overlay.state?.lines.some((line) => line.includes('/review — Review code')))
    assert.ok(overlay.state?.lines.some((line) => line.includes('/private-doc (user-only) — Private docs')))
  })

  it('/queue shows pending messages and /dequeue uses session.updateQueue', async () => {
    const view = focusedRunningApp()
    view.store.applyMux({
      type: 'session/queue',
      sessionId: 'session-control',
      items: [{
        id: 'message-1234',
        placement: 'queued',
        message: { role: 'user', content: [{ type: 'text', text: 'run the focused tests' }] },
      }, {
        id: 'context-1234',
        placement: 'context',
        message: { role: 'user', content: [{ type: 'text', text: 'internal permission context' }] },
      }],
    }, 'queue-rpc')

    view.runDeckCommand('queue')
    let overlay = view.overlay as { kind?: string; state?: { items?: { preview?: string; placement?: string }[] } }
    assert.equal(overlay.kind, 'queue')
    assert.ok(overlay.state?.items?.some((item) => item.preview?.includes('run the focused tests')))
    assert.equal(overlay.state?.items?.some((item) => item.preview?.includes('internal permission context')), false)
    view.overlay = undefined

    const calls: { method: string; payload: unknown }[] = []
    view.client.call = async (method, payload) => {
      calls.push({ method, payload })
      return { ok: true, value: { accepted: true } }
    }
    view.runDeckCommand('remove-queued', 'context')
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(calls, [])
    view.runDeckCommand('remove-queued', 'message')
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(calls, [{
      method: 'session.updateQueue',
      payload: { sessionId: 'session-control', itemId: 'message-1234', action: { kind: 'remove' } },
    }])
  })

  it('/doctor opens an info overlay with capability findings', () => {
    const view = focusedRunningApp()
    view.runDeckCommand('doctor')
    const overlay = view.overlay as { kind?: string; state?: InfoOverlayState }
    assert.equal(overlay.kind, 'info')
    assert.equal(overlay.state?.lines[0], 'deck doctor')
    assert.ok(overlay.state?.lines.some((line) => line.includes('node')))
    assert.ok(overlay.state?.lines.some((line) => line.includes('host')))
  })

  it('/doctor fix and f apply in-process repairs without mutating vim', () => {
    const view = focusedRunningApp()
    view.mouseEnabled = false
    view.vimMode = false
    view.runDeckCommand('doctor', 'fix')
    const overlay = view.overlay as { kind?: string; state?: InfoOverlayState }
    assert.equal(overlay.kind, 'info')
    assert.equal(overlay.state?.lines[0], 'deck doctor fix')
    assert.ok(overlay.state?.lines.some((line) => /fix\s+mouse/.test(line)))
    assert.equal(view.mouseEnabled, true)
    assert.equal(view.vimMode, false)
    view.overlay = undefined
    view.runDeckCommand('doctor')
    assert.ok(view.overlay !== undefined)
    view.onOverlayKey(view.overlay, { kind: 'char', char: 'f' })
    const again = view.overlay as { kind?: string; state?: InfoOverlayState }
    assert.equal(again.state?.lines[0], 'deck doctor fix')
  })

  it('/vim-mode parks printable keys in the transcript until i', () => {
    const view = focusedRunningApp()
    view.draft = ''
    view.cursor = 0
    view.vimMode = false
    view.scrollbackFocus = false
    view.runDeckCommand('vim')
    assert.equal(view.vimMode, true)
    view.onKey({ kind: 'escape' })
    assert.equal(view.composerVim, 'normal')
    assert.equal(view.scrollbackFocus, false)
    view.onKey({ kind: 'escape' })
    assert.equal(view.scrollbackFocus, true)
    view.onKey({ kind: 'char', char: 'j' })
    assert.equal(view.draft, '')
    view.onKey({ kind: 'char', char: 'i' })
    assert.equal(view.scrollbackFocus, false)
    view.onKey({ kind: 'char', char: 'a' })
    assert.equal(view.draft, 'a')
  })

  it('/dashboard opens the crew overlay; ctrl+\\ toggles it', () => {
    const view = focusedRunningApp()
    view.client.call = async () => ({ ok: true, value: { events: [], hasMore: false } })
    view.runDeckCommand('dashboard')
    const overlay = view.overlay as { kind?: string }
    assert.equal(overlay.kind, 'dashboard')
    view.onKey({ kind: 'ctrl', char: '|' })
    assert.equal(view.overlay, undefined)
    view.onKey({ kind: 'ctrl', char: '|' })
    assert.equal((view.overlay as { kind?: string } | undefined)?.kind, 'dashboard')
  })

  it('dashboard enter with a draft queues a prompt on the selected session', async () => {
    const view = focusedRunningApp()
    const calls: { method: string; payload: unknown }[] = []
    view.client.call = async (method, payload) => {
      calls.push({ method, payload })
      if (method === 'session.history') return { ok: true, value: { events: [], hasMore: false } }
      if (method === 'session.prompt') return { ok: true, value: { accepted: true } }
      return { ok: true, value: { accepted: true } }
    }
    view.runDeckCommand('dashboard')
    const overlay = view.overlay
    assert.ok(overlay !== undefined)
    view.onOverlayKey(overlay, { kind: 'char', char: 'h' })
    view.onOverlayKey(view.overlay, { kind: 'char', char: 'i' })
    view.onOverlayKey(view.overlay, { kind: 'enter' })
    await new Promise((resolve) => setImmediate(resolve))
    const prompt = calls.find((call) => call.method === 'session.prompt')
    assert.ok(prompt !== undefined)
    const payload = prompt.payload as { sessionId?: string; content?: { text?: string }[] }
    assert.equal(payload.sessionId, 'session-control')
    assert.equal(payload.content?.[0]?.text, 'hi')
  })

  it('dashboard Ctrl+R renames the selected session', async () => {
    const view = focusedRunningApp()
    const calls: { method: string; payload: unknown }[] = []
    view.client.call = async (method, payload) => {
      calls.push({ method, payload })
      if (method === 'session.history') return { ok: true, value: { events: [], hasMore: false } }
      if (method === 'session.rename') return { ok: true, value: { title: 'new title', seq: 1 } }
      return { ok: true, value: { accepted: true } }
    }
    view.runDeckCommand('dashboard')
    const overlay = view.overlay
    assert.ok(overlay !== undefined)
    view.onOverlayKey(overlay, { kind: 'ctrl', char: 'r' })
    view.onOverlayKey(view.overlay, { kind: 'ctrl', char: 'u' })
    for (const ch of 'new title') view.onOverlayKey(view.overlay, { kind: 'char', char: ch })
    view.onOverlayKey(view.overlay, { kind: 'enter' })
    await new Promise((resolve) => setImmediate(resolve))
    const rename = calls.find((call) => call.method === 'session.rename')
    assert.deepEqual(rename?.payload, { sessionId: 'session-control', title: 'new title' })
    assert.equal((view.overlay as { kind?: string } | undefined)?.kind, 'dashboard')
  })

  it('dashboard Ctrl+X cancels the running selected session', async () => {
    const view = focusedRunningApp()
    const calls: { method: string; payload: unknown }[] = []
    view.client.call = async (method, payload) => {
      calls.push({ method, payload })
      if (method === 'session.history') return { ok: true, value: { events: [], hasMore: false } }
      return { ok: true, value: { accepted: true } }
    }
    view.runDeckCommand('dashboard')
    const overlay = view.overlay
    assert.ok(overlay !== undefined)
    view.onOverlayKey(overlay, { kind: 'ctrl', char: 'x' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(calls.some((call) => call.method === 'session.cancel'))
    assert.equal((view.overlay as { kind?: string } | undefined)?.kind, 'dashboard')
  })

  it('answers an approval for an archived background session', async () => {
    const app = new DeckApp({ baseUrl: 'http://127.0.0.1:3080', cwd: process.cwd() })
    const view = internals(app)
    view.store.applySessionList([
      { sessionId: 'archived-background', updatedAt: 2, running: true, blank: false },
      { sessionId: 'focused-session', updatedAt: 1, running: false, blank: false },
    ])
    view.store.focus('focused-session')
    view.store.applyArchivedBaseline(['archived-background'])
    view.store.applyMux({
      type: 'approval/requested',
      sessionId: 'archived-background',
      approvalId: 'approval-archived',
      toolName: 'bash',
    }, 'approval-rpc')

    let response: { rpcId: string; value: unknown } | undefined
    view.client.respond = async (rpcId, value) => {
      response = { rpcId, value }
      return { accepted: true }
    }
    assert.equal((view.pendingApprovalTarget() as { id?: string } | undefined)?.id, 'archived-background')
    await view.answerApproval('allowed-once')
    assert.deepEqual(response, {
      rpcId: 'approval-rpc',
      value: {
        sessionId: 'archived-background',
        approvalId: 'approval-archived',
        outcome: 'allowed-once',
      },
    })
  })

  it('does not let a stale skills panel overwrite a session change', async () => {
    const app = new DeckApp({ baseUrl: 'http://127.0.0.1:3080', cwd: process.cwd() })
    const view = internals(app)
    view.store.applySessionList([
      { sessionId: 'skills-source', updatedAt: 2, running: false, blank: false },
      { sessionId: 'skills-next', updatedAt: 1, running: false, blank: false },
    ])
    view.store.focus('skills-source')
    let resolveSkills!: (value: unknown) => void
    view.client.call = async (method) => {
      assert.equal(method, 'skill.list')
      return new Promise((resolve) => { resolveSkills = resolve })
    }
    const opening = view.openSkills()
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    view.store.focus('skills-next')
    resolveSkills({ ok: true, value: { skills: [] } })
    await opening
    assert.equal(view.overlay, undefined)
  })

  it('does not let a stale subagent panel overwrite a newer approval', async () => {
    const app = new DeckApp({ baseUrl: 'http://127.0.0.1:3080', cwd: process.cwd() })
    const view = internals(app)
    view.store.applySessionList([{
      sessionId: 'agents-source', updatedAt: 1, running: false, blank: false,
    }])
    view.store.focus('agents-source')
    let resolveAgents!: (value: unknown) => void
    view.client.call = async (method) => {
      assert.equal(method, 'subagent.list')
      return new Promise((resolve) => { resolveAgents = resolve })
    }
    const opening = view.openAgents()
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    view.store.applyMux({
      type: 'approval/requested',
      sessionId: 'agents-source',
      approvalId: 'approval-agents',
      toolName: 'bash',
    }, 'approval-agents-rpc')
    resolveAgents({ ok: true, value: { entries: [], parentAvailable: true } })
    await opening
    assert.equal(view.overlay, undefined)
  })

  it('does not let a stale image panel overwrite a newer approval', async () => {
    const app = new DeckApp({
      baseUrl: 'http://127.0.0.1:3080',
      cwd: process.cwd(),
      env: { ...process.env, TERM_PROGRAM: 'ghostty' },
    })
    const view = internals(app)
    view.store.applySessionList([{
      sessionId: 'image-source', updatedAt: 1, running: false, blank: false,
    }])
    view.store.focus('image-source')
    view.store.applyHistoryPage('image-source', [{
      event: {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: {
          content: [{ type: 'image', attachment: { id: 'image-1', mediaType: 'image/png' } }],
        },
      },
    }], false)
    let resolveAttachment!: (value: unknown) => void
    view.client.call = async (method) => {
      assert.equal(method, 'session.attachment')
      return new Promise((resolve) => { resolveAttachment = resolve })
    }
    const opening = view.openLatestImage()
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    view.store.applyMux({
      type: 'approval/requested',
      sessionId: 'image-source',
      approvalId: 'approval-image',
      toolName: 'bash',
    }, 'approval-image-rpc')
    resolveAttachment({ ok: true, value: { attachment: {}, data: 'aGVsbG8=' } })
    await opening
    assert.equal(view.overlay, undefined)
  })

  it('does not let a stale workspace panel overwrite a session change', async () => {
    const app = new DeckApp({ baseUrl: 'http://127.0.0.1:3080', cwd: process.cwd() })
    const view = internals(app)
    view.store.applySessionList([
      { sessionId: 'workspace-source', updatedAt: 2, running: false, blank: false },
      { sessionId: 'workspace-next', updatedAt: 1, running: false, blank: false },
    ])
    view.store.focus('workspace-source')
    let resolveWorkspaces!: (value: unknown) => void
    view.client.call = async (method) => {
      assert.equal(method, 'workspace.list')
      return new Promise((resolve) => { resolveWorkspaces = resolve })
    }
    const opening = view.openWorkspaces()
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    view.store.focus('workspace-next')
    resolveWorkspaces({ ok: true, value: { items: [], archivedSessionIds: [] } })
    await opening
    assert.equal(view.overlay, undefined)
  })
})

describe('DeckApp subagent routing', () => {
  it('uses subagent history, prompt, and interrupt for a continuable child', async () => {
    const app = new DeckApp({ baseUrl: 'http://127.0.0.1:3080', cwd: '/work/demo' })
    const view = internals(app)
    view.store.applySessionList([{
      sessionId: 'child-1',
      parentSessionId: 'parent-1',
      origin: 'subagent',
      cwd: '/work/demo',
      updatedAt: 1,
      running: true,
      blank: false,
    }])
    view.store.focus('child-1')
    const calls: { method: string; payload: unknown }[] = []
    view.client.call = async (method, payload) => {
      calls.push({ method, payload })
      if (method === 'subagent.list') {
        return {
          ok: true,
          value: {
            parentAvailable: true,
            entries: [{
              kind: 'child', id: 'child-1', mode: 'continuable', activity: 'running', hasChildren: false, label: 'worker',
            }],
          },
        }
      }
      if (method === 'subagent.history') return { ok: true, value: { events: [], hasMore: false } }
      if (method === 'subagent.prompt') return { ok: true, value: { messageId: 'message-1' } }
      if (method === 'subagent.interrupt') return { ok: true, value: { accepted: true } }
      throw new Error(`unexpected ${method}`)
    }

    await view.loadHistory('child-1')
    view.draft = 'continue the investigation'
    view.cursor = [...view.draft].length
    await view.send('queue')
    await view.cancel()

    assert.ok(calls.some((call) => call.method === 'subagent.history'))
    assert.ok(calls.some((call) => call.method === 'subagent.prompt'))
    assert.ok(calls.some((call) => call.method === 'subagent.interrupt'))
    assert.ok(!calls.some((call) => call.method === 'session.history' || call.method === 'session.prompt' || call.method === 'session.cancel'))
  })
})
