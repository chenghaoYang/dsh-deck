#!/usr/bin/env node
/**
 * Drives the real deck TUI in a pty against a real `dsh` host and asserts on
 * what actually reached the screen.
 *
 * The existing e2e checks the protocol; this checks the product. Deck paints by
 * cell diff, so its output is a stream of cursor moves rather than lines of
 * text: to assert anything about the UI you have to replay that stream into a
 * grid, which is what VirtualScreen does. Every step therefore ends in a real
 * screenshot, and mode switches are cross-checked against the host's own
 * projections so a green step cannot mean "deck drew something plausible".
 *
 *   node --experimental-strip-types scripts/verify-live.mjs --attach http://127.0.0.1:3131
 *
 * Options:
 *   --attach <url>   host to drive (default http://127.0.0.1:3080)
 *   --out <file>     write the screenshots here (default /tmp/deck-verify.txt)
 *   --cols/--rows    pty size (default 100x30)
 *   --keep           leave the session behind instead of archiving it
 *   --built          drive bin/deck.js (the shipped path) instead of src/
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { graphemeWidth, graphemes, stringWidth } from '../src/term/width.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'src', 'cli.ts')

function parseArgs(argv) {
  const args = { attach: 'http://127.0.0.1:3080', out: '/tmp/deck-verify.txt', cols: 100, rows: 30, keep: false, built: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--attach') { args.attach = argv[++i]; continue }
    if (arg === '--out') { args.out = argv[++i]; continue }
    if (arg === '--cols') { args.cols = Number(argv[++i]); continue }
    if (arg === '--rows') { args.rows = Number(argv[++i]); continue }
    if (arg === '--keep') { args.keep = true; continue }
    if (arg === '--built') { args.built = true; continue }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

// --- host RPC -------------------------------------------------------------

async function rpc(method, payload = {}) {
  const rpcId = crypto.randomUUID()
  const res = await fetch(`${args.attach}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
  const body = await res.json()
  return body.result
}

async function projections(sessionId) {
  const result = await rpc('session.history', { sessionId, maxMessages: 1 })
  if (!result.ok) return {}
  return result.value.projections?.values ?? {}
}

// --- virtual screen -------------------------------------------------------

/**
 * Just enough of a terminal to reconstruct deck's frames: CUP, ED, EL, and
 * printable text. Everything else deck emits (SGR, sync markers, alt screen,
 * mouse mode, OSC) changes no cell, so it is consumed and dropped. Styles are
 * intentionally not modelled — this exists to assert on layout and content.
 */
class VirtualScreen {
  constructor(cols, rows) {
    this.cols = cols
    this.rows = rows
    this.grid = Array.from({ length: rows }, () => Array(cols).fill(' '))
    this.row = 1
    this.col = 1
    this.pending = ''
  }

  write(chunk) {
    let s = this.pending + chunk
    this.pending = ''
    let i = 0
    while (i < s.length) {
      const ch = s[i]
      if (ch === '\u001b') {
        const consumed = this.#escape(s, i)
        if (consumed === -1) { this.pending = s.slice(i); return }
        i += consumed
        continue
      }
      if (ch === '\r') { this.col = 1; i += 1; continue }
      if (ch === '\n') { this.row = Math.min(this.rows, this.row + 1); i += 1; continue }
      if (ch < ' ') { i += 1; continue }
      // Take a whole grapheme, not a code unit: a wide character advances two
      // columns and a combining mark advances none. Modelling that wrong is how
      // a screenshot ends up accusing the app of an overhang it does not have.
      const rest = s.slice(i)
      const [cluster] = graphemes(rest)
      const grapheme = cluster ?? ch
      this.#put(grapheme)
      i += grapheme.length
    }
  }

  /** Returns bytes consumed, or -1 when the sequence is still incomplete. */
  #escape(s, at) {
    const next = s[at + 1]
    if (next === undefined) return -1
    // OSC: terminated by BEL or ST. Affects no cell.
    if (next === ']') {
      const bel = s.indexOf('\u0007', at)
      const st = s.indexOf('\u001b\\', at + 2)
      if (bel === -1 && st === -1) return -1
      const end = bel === -1 ? st + 1 : bel
      return end - at + 1
    }
    if (next === '[') {
      let i = at + 2
      while (i < s.length && !/[@-~]/.test(s[i])) i += 1
      if (i >= s.length) return -1
      const final = s[i]
      const params = s.slice(at + 2, i)
      this.#csi(final, params)
      return i - at + 1
    }
    // Two-byte escapes (e.g. ESC \, ESC =) touch nothing here.
    return 2
  }

  #csi(final, params) {
    const nums = params.replace(/^\?/, '').split(';').map((p) => (p === '' ? undefined : Number(p)))
    if (final === 'H' || final === 'f') {
      this.row = Math.min(this.rows, Math.max(1, nums[0] ?? 1))
      this.col = Math.min(this.cols, Math.max(1, nums[1] ?? 1))
      return
    }
    if (final === 'J') {
      // 2 = whole display, 0/absent = cursor to end.
      const mode = nums[0] ?? 0
      if (mode === 2 || mode === 3) {
        this.grid = Array.from({ length: this.rows }, () => Array(this.cols).fill(' '))
        return
      }
      for (let r = this.row; r <= this.rows; r += 1) {
        const from = r === this.row ? this.col : 1
        for (let c = from; c <= this.cols; c += 1) this.grid[r - 1][c - 1] = ' '
      }
      return
    }
    if (final === 'K') {
      const mode = nums[0] ?? 0
      const from = mode === 1 ? 1 : this.col
      const to = mode === 0 ? this.cols : mode === 1 ? this.col : this.cols
      for (let c = from; c <= to; c += 1) this.grid[this.row - 1][c - 1] = ' '
    }
  }

  #put(grapheme) {
    const width = graphemeWidth(grapheme)
    if (width === 0) return
    if (this.row >= 1 && this.row <= this.rows && this.col >= 1 && this.col <= this.cols) {
      this.grid[this.row - 1][this.col - 1] = grapheme
      // A wide grapheme owns the next cell too; blanking it keeps a row's
      // rendered width equal to its column count.
      if (width === 2 && this.col + 1 <= this.cols) this.grid[this.row - 1][this.col] = ''
    }
    this.col += width
    if (this.col > this.cols) this.col = this.cols
  }

  lines() {
    return this.grid.map((row) => row.join('').replace(/\s+$/, ''))
  }

  /** Painted display width of a row, which is what a terminal actually shows. */
  widthOf(index) {
    return stringWidth(this.lines()[index] ?? '')
  }

  text() {
    return this.lines().join('\n')
  }
}

// --- driver ---------------------------------------------------------------

const KEY = {
  ctrl: (letter) => String.fromCharCode(letter.toUpperCase().charCodeAt(0) - 64),
  enter: '\r',
  escape: '\u001b',
  down: '\u001b[B',
  up: '\u001b[A',
  tab: '\t',
}

const steps = []
let failures = 0

function record(name, ok, detail = '') {
  steps.push({ name, ok, detail })
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Set once deck creates the session this run drives, so it can be cleaned up. */
let verifySession

const shots = []
function shot(label, screen) {
  const bar = '─'.repeat(screen.cols)
  // Pad by display columns, not code points, or every CJK row in the snapshot
  // looks ragged and the snapshot stops being evidence.
  const rows = screen.lines()
    .map((line) => `│${line}${' '.repeat(Math.max(0, screen.cols - stringWidth(line)))}│`)
    .join('\n')
  shots.push(`\n### ${label}\n┌${bar}┐\n${rows}\n└${bar}┘`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const describe = await rpc('host.describe', {})
  if (!describe.ok) throw new Error(`host at ${args.attach} did not answer host.describe`)
  record('host reachable', true, `${args.attach} v${describe.value.version} default=${describe.value.provider}/${describe.value.model}`)

  const screen = new VirtualScreen(args.cols, args.rows)
  // deck needs a real pty (it lays out from the reported window size and reads
  // raw keys), and the driver needs plain pipes. pty-bridge.py is the seam.
  // `--built` drives bin/deck.js, which is what the installed `deck` binary
  // (and therefore a bare `dsh`) actually runs. Verifying only src/ would let
  // a stale lib/ ship.
  const entry = args.built
    ? [join(HERE, '..', 'bin', 'deck.js')]
    : ['--experimental-strip-types', CLI]
  const child = spawn('python3', [
    join(HERE, 'pty-bridge.py'), String(args.cols), String(args.rows),
    process.execPath, ...entry,
    '--attach', args.attach, '--no-print',
  ], {
    env: { ...process.env, TERM: 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let raw = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { raw += chunk; screen.write(chunk) })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { raw += chunk })

  const send = async (keys, settleMs = 700) => {
    child.stdin.write(keys)
    await sleep(settleMs)
  }

  /** Waits until the screen satisfies a predicate, or gives up. */
  const waitFor = async (label, predicate, timeoutMs = 90_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate(screen.text())) return true
      await sleep(400)
    }
    record(`wait ${label}`, false, `timed out after ${timeoutMs}ms`)
    return false
  }

  try {
    // 1. It comes up at all, and the chrome is there.
    const booted = await waitFor('first frame', (t) => t.includes('deck') && t.includes('ready'), 30_000)
    shot('01 · first frame', screen)
    record('boots and connects', booted, booted ? 'header shows "deck ● ready"' : 'never rendered a ready header')
    if (!booted) return

    // Start from a session of our own. Adopting whatever the host last had
    // means inheriting its permission preset, its queue, and its transcript,
    // and then asserting on state we did not set.
    const before = new Set((await rpc('session.list', {})).value?.items.map((s) => s.sessionId) ?? [])
    await send(KEY.ctrl('n'), 2500)
    shot('02 · fresh session', screen)
    const listed = (await rpc('session.list', {})).value?.items ?? []
    const focusedId = listed.map((s) => s.sessionId).find((id) => !before.has(id))
    record('ctrl+n creates a session', focusedId !== undefined, focusedId ?? 'no new session appeared')
    if (focusedId === undefined) return
    verifySession = focusedId

    // 3. Typing goes to the composer, character for character. This is the
    //    regression that mattered most: letters were once commands.
    const typed = 'Reply with exactly this and nothing else: deck-verify-ok'
    await send(typed, 900)
    shot('03 · composer', screen)
    record('typing reaches the composer intact', screen.text().includes(typed), JSON.stringify(typed))

    // 4. A real turn on a real model. The assertion has to be for the answer,
    //    not merely for the token — the echoed prompt contains it too.
    //
    //    A hosted model can also just fail: NVIDIA answered one run with a 500
    //    after 33s. deck rendered that correctly, so reporting it as a flat
    //    timeout would blame the client for the provider's outage. Tell the two
    //    apart, and give the provider another go before calling it a failure.
    const answerLanded = () => {
      const t = screen.text()
      const echo = t.indexOf(typed)
      if (echo === -1) return false
      // The answer is an occurrence after the echoed prompt.
      return t.indexOf('deck-verify-ok', echo + typed.length) !== -1
    }
    const upstreamError = () => /error: [^\n]+/.exec(screen.text())?.[0]

    let answered = false
    let providerError
    for (let attempt = 1; attempt <= 2 && !answered; attempt += 1) {
      if (attempt > 1) {
        record(`retrying the turn after a provider error`, true, providerError ?? '')
        await send(typed, 700)
        providerError = undefined
      }
      await send(KEY.enter, 1200)
      if (attempt === 1) shot('04 · turn queued', screen)
      const deadline = Date.now() + 150_000
      while (Date.now() < deadline) {
        if (answerLanded()) { answered = true; break }
        const err = upstreamError()
        if (err !== undefined) { providerError = err; break }
        await sleep(400)
      }
    }
    shot('05 · assistant replied', screen)
    if (!answered && providerError !== undefined) {
      // Not a deck defect: the transcript proves it surfaced the failure.
      record('the model provider failed; deck surfaced it', true, providerError)
      record('a real inkling turn answers into the transcript', false, `provider error: ${providerError}`)
    } else {
      record('a real inkling turn answers into the transcript', answered)
    }
    // Cross-check the host: the turn really completed, it did not just paint.
    // The answer reaches the screen before turn/end is logged, so poll briefly
    // rather than reading the log the instant the text appears.
    let completed = false
    for (let attempt = 0; attempt < 20 && !completed; attempt += 1) {
      const events = await rpc('session.history', { sessionId: focusedId, maxMessages: 40 })
      completed = events.ok && events.value.events.some((e) => (
        e.event.type === 'turn/end' && e.event.data?.reason?.kind === 'completed'
      ))
      if (!completed) await sleep(500)
    }
    if (answered) record('host logged turn/end completed', completed)

    // 4. The header knows the per-session model, not just the host default.
    record(
      'header shows the session model',
      screen.text().includes('inkling'),
      screen.lines()[0] ?? '',
    )

    // 6. The modes panel.
    const ROWS = ['model', 'agent', 'permission', 'plan', 'compact']
    await send(KEY.ctrl('s'), 2000)
    shot('06 · modes panel', screen)
    const panel = screen.text()
    const hasRows = ROWS.every((row) => panel.includes(row))
    record('modes panel opens with every row', hasRows, hasRows ? ROWS.join('/') : panel.slice(0, 300))
    if (!hasRows) return
    record(
      'panel shows the localized agent preset',
      /标准模式|standard/.test(panel),
      'agent row carries the host\u2019s own preset name',
    )

    /**
     * Navigation has to be absolute, not relative: the option cursor starts on
     * whichever option is current, so counting keypresses from an assumed
     * position is how a driver ends up asserting against the wrong option.
     * Pressing up more times than there are entries clamps to the top, which
     * makes the position known regardless of where it started.
     */
    const toIndex = async (index, ceiling) => {
      for (let i = 0; i < ceiling; i += 1) await send(KEY.up, 120)
      for (let i = 0; i < index; i += 1) await send(KEY.down, 120)
    }

    // 7. Switch the permission preset, and confirm the HOST agrees.
    const permsBefore = (await projections(focusedId)).permissions
    const presets = permsBefore?.options.map((o) => o.value) ?? []
    await toIndex(ROWS.indexOf('permission'), ROWS.length)
    await send(KEY.enter, 1000)
    shot('07 · permission options', screen)
    record(
      'permission options list every preset',
      presets.every((p) => screen.text().includes(p)),
      presets.join(', '),
    )

    const target = presets.find((p) => p !== permsBefore?.currentValue)
    await toIndex(presets.indexOf(target), presets.length)
    await send(KEY.enter, 2500)
    shot('08 · permission switched', screen)
    const after = (await projections(focusedId)).permissions?.currentValue
    record(
      'permission switch reaches the host',
      after === target,
      `${String(permsBefore?.currentValue)} → ${String(after)} (wanted ${target})`,
    )
    record('panel row shows the new value', screen.text().includes(target))
    record('header shows the non-default permission chip', /read-only|full-access/.test(screen.lines()[0] ?? ''), screen.lines()[0] ?? '')

    // 8. Plan mode, again cross-checked. Options are [on, off].
    const planBefore = (await projections(focusedId)).plan?.active
    await toIndex(ROWS.indexOf('plan'), ROWS.length)
    await send(KEY.enter, 1000)
    shot('09 · plan options', screen)
    await toIndex(planBefore === true ? 1 : 0, 2)
    await send(KEY.enter, 3000)
    shot('10 · plan switched', screen)
    const planAfter = (await projections(focusedId)).plan
    record(
      'plan switch reaches the host',
      planAfter !== undefined && planAfter.active !== planBefore,
      `active ${String(planBefore)} → ${JSON.stringify(planAfter)}`,
    )

    // 9. Every panel row must be the same DISPLAY width, or the cell diff
    //    leaves stale text behind. This is the CJK overhang regression, and it
    //    has to be measured in columns: the offending row held four wide
    //    characters, so counting code points hides exactly this defect.
    const panelRows = screen.lines()
      .map((line, i) => ({ line, width: screen.widthOf(i) }))
      .filter(({ line }) => /[│╭╰].*[│╮╯]\s*$/.test(line))
    const widths = new Set(panelRows.map((r) => r.width))
    record(
      'panel rows are all one display width',
      panelRows.length > 0 && widths.size === 1,
      `${panelRows.length} rows, column widths ${[...widths].join(',')}`,
    )
    if (widths.size > 1) {
      for (const { line, width } of panelRows) console.log(`      ${String(width).padStart(3)}  ${line}`)
    }

    // 10. Escape closes the panel and the transcript is still intact.
    await send(KEY.escape, 900)
    await send(KEY.escape, 900)
    shot('11 · panel closed', screen)
    record('escape closes the panel', !screen.text().includes('compact older history'))
    record('transcript survived the panel', screen.text().includes('deck-verify-ok'))
    // Mode changes inject notes into the inbox; they must not masquerade as
    // prompts the user typed and has not sent.
    record(
      'injected context is not shown as a queued user prompt',
      !/▸ \(queued\) The (approval policy|user switched)/.test(screen.text()),
      screen.text().match(/[▸·] \((queued|context)\)[^\n]*/g)?.join(' | ') ?? 'no inbox lines',
    )

    // 10b. The model + reasoning-effort mode, through its own shortcut. The
    //      picker filters by typed text, then drills into the model's efforts.
    await send(KEY.ctrl('p'), 1800)
    shot('11b · model picker', screen)
    record('model picker opens', /inkling|model/i.test(screen.text()))
    await send('inkling', 900)
    shot('11c · picker filtered', screen)
    record('picker filters to inkling', screen.text().includes('inkling'))
    await send(KEY.enter, 900)
    shot('11d · reasoning efforts', screen)
    const effortsShown = ['low', 'medium', 'high'].every((e) => screen.text().includes(e))
    record('inkling advertises its reasoning efforts', effortsShown, 'low / medium / high')
    // Land on "high": clamp to the top, then step down to it.
    await toIndex(2, 3)
    await send(KEY.enter, 2500)
    shot('11e · model applied', screen)
    const picked = await rpc('session.models', { sessionId: focusedId })
    const current = picked.ok ? picked.value.current : undefined
    record(
      'reasoning effort reaches the host',
      current?.model === 'thinkingmachines/inkling' && current?.reasoningEffort === 'high',
      JSON.stringify(current),
    )
    record('header shows the chosen effort', /high/.test(screen.lines()[0] ?? ''), screen.lines()[0] ?? '')

    // 11. The session switcher still works after all that.
    await send(KEY.ctrl('k'), 1000)
    shot('12 · session switcher', screen)
    record('session switcher opens', /archive|rename|focus/i.test(screen.text()))
    await send(KEY.escape, 700)

    // 12. Help.
    await send(KEY.ctrl('g'), 1000)
    shot('13 · help', screen)
    record('help lists the modes binding', /ctrl\+s/.test(screen.text()))
    await send(KEY.escape, 700)

    // 13. No stray escape sequences leaked as visible text.
    record('no escape sequences painted as text', !/\u001b\[[0-9;?]*[A-Za-z]/.test(screen.text()))

    // 14. Clean exit restores the terminal.
    const closed = new Promise((resolve) => {
      if (child.exitCode !== null) { resolve(true); return }
      const timer = setTimeout(() => resolve(false), 10_000)
      child.once('close', () => { clearTimeout(timer); resolve(true) })
    })
    child.stdin.write(KEY.ctrl('d'))
    record('ctrl+d exits', await closed)
    const restored = raw.includes('\u001b[?1002l') && raw.includes('\u001b[?1006l')
    record('mouse reporting disabled on exit', restored)
    record('left the alt screen', raw.includes('\u001b[?1049l'))
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    if (!args.keep && verifySession !== undefined) {
      // Leave the host as found rather than accumulating a session per run.
      await rpc('workspace.archiveSession', { sessionId: verifySession }).catch(() => {})
    }
    writeFileSync(args.out, `deck live verification — ${new Date().toISOString()}\nhost ${args.attach}  pty ${args.cols}x${args.rows}\n${shots.join('\n')}\n`)
    console.log(`\nscreenshots → ${args.out}`)
    console.log('\n=== summary ===')
    for (const step of steps) console.log(`${step.ok ? 'PASS' : 'FAIL'}  ${step.name}${step.detail ? ` — ${step.detail}` : ''}`)
    console.log(failures === 0 ? `PASS  all ${steps.length} steps` : `FAIL  ${failures}/${steps.length} steps`)
    if (failures > 0) process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
