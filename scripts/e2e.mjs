#!/usr/bin/env node
/**
 * Isolated live e2e against a throwaway `dsh web` host and the bundled fake-llm.
 * Never touches ~/.dsh. Never binds or kills port 3080.
 *
 *   node --experimental-strip-types scripts/e2e.mjs
 */
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DeckClient } from '../src/protocol/client.ts'
import {
  ASK_OPTION_CONTINUE,
  ASK_QUESTION_ID,
  startFakeLlm,
} from '../src/dev/fake-llm.ts'

const USER_HOST_PORT = 3080
const HOST_PORT_FLOOR = 3090
const LLM_PORT_FLOOR = 4320
const BUDGET_MS = 88_000
const HOST_READY_MS = 55_000
const STEP_MS = 20_000
const FORBIDDEN_HOME = resolve(process.env.HOME ?? '', '.dsh')

const steps = []
let failed = 0

function record(name, ok, detail = '') {
  steps.push({ name, ok, detail })
  const mark = ok ? 'PASS' : 'FAIL'
  if (!ok) failed += 1
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function fail(name, detail) {
  record(name, false, detail)
  throw new Error(`${name}: ${detail}`)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null
}

async function freePort(floor) {
  for (let port = floor; port < floor + 30; port += 1) {
    if (port === USER_HOST_PORT) continue
    const available = await new Promise((resolveAvailable) => {
      const server = createServer()
      server.unref()
      server.once('error', () => resolveAvailable(false))
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolveAvailable(true))
      })
    })
    if (available) return port
  }
  throw new Error(`no free port in ${floor}..${floor + 29}`)
}

function listenersOn(port) {
  return new Promise((resolvePids) => {
    const child = spawn('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('close', () => {
      const pids = out.split(/\s+/).map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0)
      resolvePids(pids)
    })
    child.on('error', () => resolvePids([]))
  })
}

async function killPort(port, pidsWeStarted) {
  if (port === USER_HOST_PORT) return
  const pids = await listenersOn(port)
  for (const pid of pids) {
    if (!pidsWeStarted.has(pid)) continue
    try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  }
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

class MuxTap {
  constructor(baseUrl) {
    this.envelopes = []
    this.#waiters = []
    this.#ws = new WebSocket(new URL('/api/events.mux', `${baseUrl}/`).href.replace(/^http/, 'ws'))
    this.#opened = new Promise((resolveOpen, rejectOpen) => {
      this.#ws.addEventListener('open', () => resolveOpen(), { once: true })
      this.#ws.addEventListener('error', () => rejectOpen(new Error('mux socket error')), { once: true })
    })
    this.#ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return
      let parsed
      try { parsed = JSON.parse(event.data) } catch { return }
      if (!isRecord(parsed) || !isRecord(parsed.payload)) return
      this.envelopes.push(parsed)
      this.#waiters = this.#waiters.filter((waiter) => {
        if (!waiter.match(parsed)) return true
        waiter.resolve(parsed)
        return false
      })
    })
  }

  #ws
  #opened
  #waiters

  ready() {
    return this.#opened
  }

  close() {
    if (this.#ws.readyState === WebSocket.OPEN || this.#ws.readyState === WebSocket.CONNECTING) {
      this.#ws.close()
    }
  }

  waitFor(match, timeoutMs, label) {
    const existing = this.envelopes.find(match)
    if (existing !== undefined) return Promise.resolve(existing)
    return new Promise((resolveWait, rejectWait) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((waiter) => waiter.resolve !== resolveWait)
        rejectWait(new Error(`timeout waiting for ${label}`))
      }, timeoutMs)
      this.#waiters.push({
        match,
        resolve: (envelope) => {
          clearTimeout(timer)
          resolveWait(envelope)
        },
      })
    })
  }

  sessionEvents(sessionId) {
    const types = []
    for (const envelope of this.envelopes) {
      const payload = envelope.payload
      if (payload.type === 'session/event' && payload.sessionId === sessionId && isRecord(payload.event)) {
        types.push(payload.event)
      }
    }
    return types
  }
}

function trimApproval(envelope) {
  const payload = envelope.payload
  return {
    type: envelope.type,
    rpcId: envelope.rpcId,
    method: envelope.method,
    payload: {
      type: payload.type,
      sessionId: payload.sessionId,
      approvalId: payload.approvalId,
      toolName: payload.toolName,
      callId: payload.callId,
      reason: payload.reason,
    },
  }
}

function trimQuestion(envelope) {
  const payload = envelope.payload
  return {
    type: envelope.type,
    rpcId: envelope.rpcId,
    method: envelope.method,
    payload: {
      type: payload.type,
      sessionId: payload.sessionId,
      questions: payload.questions,
    },
  }
}

function assertToolsSequence(events) {
  const types = events.map((event) => event.type)
  const indexOf = (type) => types.indexOf(type)
  if (indexOf('turn/start') < 0) throw new Error(`missing turn/start; saw ${types.join(',')}`)
  const chunks = events.filter((event) => event.type === 'assistant/chunk')
  const chunkTypes = chunks.map((event) => isRecord(event.data) && isRecord(event.data.chunk) ? event.data.chunk.type : '')
  if (!chunkTypes.includes('reasoning-delta')) throw new Error(`missing reasoning-delta; chunk types=${chunkTypes.join(',')}`)
  if (!chunkTypes.includes('tool-call-delta')) throw new Error(`missing tool-call-delta; chunk types=${chunkTypes.join(',')}`)
  if (indexOf('tool/call') < 0) throw new Error('missing tool/call')
  if (indexOf('tool/result') < 0) throw new Error('missing tool/result')
  if (indexOf('assistant/message') < 0) throw new Error('missing assistant/message')
  const turnEnd = [...events].reverse().find((event) => event.type === 'turn/end')
  const kind = isRecord(turnEnd?.data) && isRecord(turnEnd.data.reason) ? turnEnd.data.reason.kind : undefined
  if (kind !== 'completed') throw new Error(`turn/end kind=${String(kind)}`)
  if (!(indexOf('turn/start') < indexOf('tool/call') && indexOf('tool/call') < indexOf('tool/result') && indexOf('tool/result') < types.lastIndexOf('turn/end'))) {
    throw new Error(`event order wrong: ${types.join(' → ')}`)
  }
}

async function requireCall(client, method, payload) {
  const result = await client.call(method, payload)
  if (!result.ok) throw new Error(`${method}: ${result.error.code}: ${result.error.message}`)
  return result.value
}

async function promptAndWaitTurn(client, mux, sessionId, text, timeoutMs) {
  const before = mux.envelopes.length
  const prompted = await requireCall(client, 'session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
  })
  if (prompted.accepted !== true) throw new Error(`session.prompt not accepted: ${JSON.stringify(prompted)}`)
  await mux.waitFor((envelope) => {
    const payload = envelope.payload
    if (payload.type !== 'session/event' || payload.sessionId !== sessionId) return false
    const event = payload.event
    return isRecord(event) && event.type === 'turn/end' && mux.envelopes.indexOf(envelope) >= before
  }, timeoutMs, `turn/end after ${JSON.stringify(text)}`)
}

async function startHost(port, cwd, env, logPath) {
  const log = createWriteStream(logPath, { flags: 'a' })
  const child = spawn('dsh', ['web', '--no-open', '--port', String(port)], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const onData = (chunk) => {
    const text = chunk.toString()
    output += text
    log.write(text)
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  const ready = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      rejectReady(new Error(`dsh web not ready in ${HOST_READY_MS}ms; tail:\n${output.slice(-2500)}`))
    }, HOST_READY_MS)
    const check = () => {
      const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/u.exec(output)
      if (match?.[1] !== undefined) {
        clearTimeout(timer)
        resolveReady(match[1])
      }
    }
    child.stdout.on('data', check)
    child.stderr.on('data', check)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      rejectReady(new Error(`dsh web exited early code=${String(code)} signal=${String(signal)}; tail:\n${output.slice(-2500)}`))
    })
    check()
  })
  return { child, ready, logPath }
}

async function main() {
  const startedAt = Date.now()
  const watchdog = setTimeout(() => {
    console.error('FAIL  watchdog — e2e exceeded 88s')
    process.exitCode = 1
  }, BUDGET_MS)
  watchdog.unref()

  const hostPort = await freePort(HOST_PORT_FLOOR)
  const llmPort = await freePort(LLM_PORT_FLOOR)
  const root = mkdtempSync(join(tmpdir(), 'deck-e2e-'))
  const dshHome = join(root, 'dsh-e2e')
  const agentsHome = join(root, 'agents')
  const workspace = join(root, 'workspace')
  mkdirSync(dshHome)
  mkdirSync(agentsHome)
  mkdirSync(workspace)
  const startedPids = new Set()
  const followUps = []
  let llm
  let host
  let mux
  let captured = {
    approvalAllow: undefined,
    approvalResolvedAllow: undefined,
    approvalReject: undefined,
    approvalResolvedReject: undefined,
    question: undefined,
    questionResolved: undefined,
    approvalRoute: 'escalate-args',
    hostHome: undefined,
    contractNotes: [],
  }

  const cleanup = async () => {
    mux?.close()
    if (host?.child.exitCode === null && host.child.pid !== undefined) {
      startedPids.add(host.child.pid)
      try { host.child.kill('SIGTERM') } catch { /* gone */ }
      const closed = new Promise((resolveClose) => host.child.once('close', () => resolveClose()))
      await Promise.race([closed, wait(2000)])
      if (host.child.exitCode === null) {
        try { host.child.kill('SIGKILL') } catch { /* gone */ }
      }
    }
    await llm?.close()
    await killPort(hostPort, startedPids)
    const leftover = await listenersOn(hostPort)
    for (const pid of leftover) {
      if (hostPort === USER_HOST_PORT) break
      try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
    }
    rmSync(root, { recursive: true, force: true })
  }

  try {
    llm = await startFakeLlm({
      port: llmPort,
      onRequest(info) {
        if (info.hasToolResult) followUps.push(info)
      },
    })
    record('start fake-llm', true, llm.url)

    const env = { ...process.env }
    delete env.DSH_CORDIS_CONFIG
    delete env.DSH_PERMISSION_MODE
    env.DSH_HOME = dshHome
    env.DSH_AGENTS_HOME = agentsHome
    env.DEEPSEEK_API_KEY = 'fake'
    env.DEEPSEEK_BASE_URL = llm.url
    host = await startHost(hostPort, workspace, env, join(root, 'dsh.log'))
    if (host.child.pid !== undefined) startedPids.add(host.child.pid)
    const readyUrl = await host.ready
    record('start dsh web --no-open', true, readyUrl)

    const baseUrl = `http://127.0.0.1:${hostPort}`
    const client = new DeckClient({ baseUrl, timeoutMs: 20_000 })
    const describe = await requireCall(client, 'host.describe', {})
    captured.hostHome = describe.home
    if (describe.home === FORBIDDEN_HOME) {
      fail('host.describe', `host.home leaked to ${FORBIDDEN_HOME}`)
    }
    if (typeof describe.home === 'string' && describe.home.length > 0 && !describe.home.startsWith(dshHome) && describe.home !== dshHome) {
      captured.contractNotes.push(`host.describe.home=${describe.home} (isolated DSH_HOME=${dshHome})`)
    }
    record('host.describe', true, `version=${describe.version} home=${describe.home} model=${describe.model}`)

    mux = new MuxTap(baseUrl)
    await mux.ready()

    const toolsSession = await requireCall(client, 'session.create', { cwd: workspace })
    try {
      await promptAndWaitTurn(client, mux, toolsSession.sessionId, 'tools please', STEP_MS)
      assertToolsSequence(mux.sessionEvents(toolsSession.sessionId))
      record('tools sequence', true, 'turn/start → reasoning-delta + tool-call-delta → tool/call → tool/result → assistant/message → turn/end completed')
    } catch (error) {
      const types = mux.sessionEvents(toolsSession.sessionId).map((event) => event.type)
      fail('tools sequence', `${error instanceof Error ? error.message : String(error)}; events=${types.join(',')}`)
    }

    const allowSession = await requireCall(client, 'session.create', { cwd: workspace })
    const allowPrompt = requireCall(client, 'session.prompt', {
      sessionId: allowSession.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'escalate please' }],
    })
    const allowRequested = await mux.waitFor((envelope) => (
      envelope.payload.type === 'approval/requested' && envelope.payload.sessionId === allowSession.sessionId
    ), STEP_MS, 'approval/requested (allow)')
    captured.approvalAllow = trimApproval(allowRequested)
    const allowReceipt = await client.respond(allowRequested.rpcId, {
      sessionId: allowRequested.payload.sessionId,
      approvalId: allowRequested.payload.approvalId,
      outcome: 'allowed-once',
    })
    if (!allowReceipt.accepted) fail('approval allow', `respond not accepted: ${JSON.stringify(allowReceipt)}`)
    const allowResolved = await mux.waitFor((envelope) => (
      envelope.payload.type === 'approval/resolved'
      && envelope.payload.sessionId === allowSession.sessionId
      && envelope.payload.outcome === 'allowed-once'
    ), STEP_MS, 'approval/resolved allowed-once')
    captured.approvalResolvedAllow = {
      type: allowResolved.payload.type,
      sessionId: allowResolved.payload.sessionId,
      approvalId: allowResolved.payload.approvalId,
      outcome: allowResolved.payload.outcome,
    }
    await allowPrompt
    await mux.waitFor((envelope) => {
      const payload = envelope.payload
      if (payload.type !== 'session/event' || payload.sessionId !== allowSession.sessionId) return false
      return isRecord(payload.event) && payload.event.type === 'turn/end'
        && isRecord(payload.event.data) && isRecord(payload.event.data.reason)
        && payload.event.data.reason.kind === 'completed'
    }, STEP_MS, 'turn/end after allow')
    record('approval allow', true, `rpcId=${allowRequested.rpcId} route=${captured.approvalRoute}`)

    const rejectSession = await requireCall(client, 'session.create', { cwd: workspace })
    const rejectPrompt = requireCall(client, 'session.prompt', {
      sessionId: rejectSession.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'escalate please' }],
    })
    const rejectRequested = await mux.waitFor((envelope) => (
      envelope.payload.type === 'approval/requested' && envelope.payload.sessionId === rejectSession.sessionId
    ), STEP_MS, 'approval/requested (reject)')
    captured.approvalReject = trimApproval(rejectRequested)
    const rejectReceipt = await client.respond(rejectRequested.rpcId, {
      sessionId: rejectRequested.payload.sessionId,
      approvalId: rejectRequested.payload.approvalId,
      outcome: 'rejected',
    })
    if (!rejectReceipt.accepted) fail('approval reject', `respond not accepted: ${JSON.stringify(rejectReceipt)}`)
    const rejectResolved = await mux.waitFor((envelope) => (
      envelope.payload.type === 'approval/resolved'
      && envelope.payload.sessionId === rejectSession.sessionId
      && envelope.payload.outcome === 'rejected'
    ), STEP_MS, 'approval/resolved rejected')
    captured.approvalResolvedReject = {
      type: rejectResolved.payload.type,
      sessionId: rejectResolved.payload.sessionId,
      approvalId: rejectResolved.payload.approvalId,
      outcome: rejectResolved.payload.outcome,
    }
    await rejectPrompt
    await mux.waitFor((envelope) => {
      const payload = envelope.payload
      if (payload.type !== 'session/event' || payload.sessionId !== rejectSession.sessionId) return false
      return isRecord(payload.event) && payload.event.type === 'turn/end'
    }, STEP_MS, 'turn/end after reject')
    record('approval reject', true, `rpcId=${rejectRequested.rpcId}`)

    const askSession = await requireCall(client, 'session.create', { cwd: workspace })
    const askPrompt = requireCall(client, 'session.prompt', {
      sessionId: askSession.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'ask please' }],
    })
    const questionRequested = await mux.waitFor((envelope) => (
      envelope.payload.type === 'question/requested' && envelope.payload.sessionId === askSession.sessionId
    ), STEP_MS, 'question/requested')
    captured.question = trimQuestion(questionRequested)
    const questions = Array.isArray(questionRequested.payload.questions) ? questionRequested.payload.questions : []
    const firstQuestion = questions[0]
    const questionId = isRecord(firstQuestion) && typeof firstQuestion.id === 'string' ? firstQuestion.id : ASK_QUESTION_ID
    const selectedLabel = isRecord(firstQuestion) && Array.isArray(firstQuestion.options) && isRecord(firstQuestion.options[0]) && typeof firstQuestion.options[0].label === 'string'
      ? firstQuestion.options[0].label
      : ASK_OPTION_CONTINUE
    const questionValue = {
      sessionId: questionRequested.payload.sessionId,
      answer: { answers: [{ id: questionId, selected: [selectedLabel] }] },
    }
    const extraQuestionKeys = isRecord(questionRequested.payload)
      ? Object.keys(questionRequested.payload).filter((key) => !['type', 'sessionId', 'questions'].includes(key))
      : []
    if (extraQuestionKeys.length > 0) {
      captured.contractNotes.push(`question/requested extra keys: ${extraQuestionKeys.join(', ')}`)
    }
    if (isRecord(firstQuestion) && 'multiSelect' in firstQuestion && firstQuestion.multiSelect !== false && firstQuestion.multiSelect !== undefined) {
      captured.contractNotes.push(`question.multiSelect live value=${JSON.stringify(firstQuestion.multiSelect)}`)
    }
    const questionReceipt = await client.respond(questionRequested.rpcId, questionValue)
    if (!questionReceipt.accepted) fail('question answer', `respond not accepted: ${JSON.stringify(questionReceipt)}`)
    const questionResolved = await mux.waitFor((envelope) => (
      envelope.payload.type === 'question/resolved' && envelope.payload.sessionId === askSession.sessionId
    ), STEP_MS, 'question/resolved')
    captured.questionResolved = {
      type: questionResolved.payload.type,
      sessionId: questionResolved.payload.sessionId,
      questionRpcId: questionResolved.payload.questionRpcId,
      outcome: questionResolved.payload.outcome,
    }
    if (questionResolved.payload.outcome !== 'answered') {
      fail('question resolved', `outcome=${String(questionResolved.payload.outcome)}`)
    }
    if (questionResolved.payload.questionRpcId !== questionRequested.rpcId) {
      captured.contractNotes.push(`question/resolved.questionRpcId=${String(questionResolved.payload.questionRpcId)} vs envelope rpcId=${questionRequested.rpcId}`)
    }
    await askPrompt
    await mux.waitFor((envelope) => {
      const payload = envelope.payload
      if (payload.type !== 'session/event' || payload.sessionId !== askSession.sessionId) return false
      return isRecord(payload.event) && payload.event.type === 'turn/end'
    }, STEP_MS, 'turn/end after question')
    const askFollowUp = followUps.find((info) => info.scenario === 'ask')
    if (askFollowUp === undefined) {
      fail('question follow-up', 'fake-llm did not receive a tool-result follow-up for ask')
    }
    const followUpText = JSON.stringify(askFollowUp.messages)
    if (!followUpText.includes(selectedLabel) && !followUpText.includes(questionId)) {
      captured.contractNotes.push('ask follow-up did not echo the selected label in tool messages; see fake-llm stderr')
    }
    record('question answer', true, `rpcId=${questionRequested.rpcId} selected=${selectedLabel}`)

    const muxGet = await fetch(new URL('/api/events.mux', `${baseUrl}/`))
    if (muxGet.status !== 426) fail('GET /api/events.mux', `expected 426, got ${muxGet.status}`)
    record('GET /api/events.mux → 426', true)

    console.log('\n--- captured frames ---')
    console.log(JSON.stringify({
      approvalRoute: captured.approvalRoute,
      approvalAllow: captured.approvalAllow,
      approvalResolvedAllow: captured.approvalResolvedAllow,
      approvalReject: captured.approvalReject,
      approvalResolvedReject: captured.approvalResolvedReject,
      question: captured.question,
      questionResolved: captured.questionResolved,
      contractNotes: captured.contractNotes,
      hostHome: captured.hostHome,
      isolatedHome: dshHome,
    }, null, 2))
  } catch (error) {
    if (steps.every((step) => step.ok) || !steps.some((step) => !step.ok && step.name === (error instanceof Error ? error.message.split(':')[0] : ''))) {
      record('e2e', false, error instanceof Error ? error.message : String(error))
    }
    process.exitCode = 1
  } finally {
    clearTimeout(watchdog)
    await cleanup()
    const leftoverHost = await listenersOn(hostPort)
    const leftoverLlm = await listenersOn(llmPort)
    if (leftoverHost.length > 0) {
      record('cleanup host port', false, `still listening: ${leftoverHost.join(',')}`)
      process.exitCode = 1
    } else {
      record('cleanup host port', true, String(hostPort))
    }
    if (leftoverLlm.length > 0) {
      record('cleanup llm port', false, `still listening: ${leftoverLlm.join(',')}`)
      process.exitCode = 1
    } else {
      record('cleanup llm port', true, String(llmPort))
    }
    console.log('\n=== e2e summary ===')
    for (const step of steps) {
      console.log(`${step.ok ? 'PASS' : 'FAIL'}  ${step.name}${step.detail ? ` — ${step.detail}` : ''}`)
    }
    console.log(failed === 0 && process.exitCode !== 1 ? 'PASS  all steps' : 'FAIL  one or more steps')
    console.log(`elapsed ${Date.now() - startedAt}ms`)
    if (failed > 0) process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
