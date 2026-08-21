import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { HostDescription } from '../src/protocol/contract.ts'
import type { TerminalCapabilities } from '../src/term/capabilities.ts'
import {
  doctorFindings,
  doctorFix,
  doctorFixLines,
  doctorLines,
  type DoctorFinding,
  type DoctorFixItem,
  type DoctorInput,
} from '../src/ui/doctor.ts'

const HOST: HostDescription = {
  version: '0.1.0',
  cwd: '/tmp/workspace',
  provider: 'deepseek',
  model: 'deepseek-chat',
  attachedSessions: 3,
  home: '/home/deck',
  canOpenPath: true,
}

const REQUIRED_NAMES = [
  'node',
  'tty',
  'terminal',
  'truecolor',
  'hyperlinks',
  'kitty graphics',
  'notifications',
  'progress',
  'clipboard',
  'sync output',
  'unicode core',
  'mouse',
  'host',
  'cwd',
  'editor uri',
] as const

function ghosttyCaps(over: Partial<TerminalCapabilities> = {}): TerminalCapabilities {
  return {
    isGhostty: true,
    trueColor: true,
    hyperlinks: true,
    kittyGraphics: true,
    notifications: true,
    progress: true,
    clipboard: true,
    syncOutput: true,
    unicodeCore: true,
    termProgram: 'ghostty',
    termProgramVersion: '1.3.1',
    ...over,
  }
}

function baseInput(over: Partial<DoctorInput> = {}): DoctorInput {
  return {
    caps: ghosttyCaps(),
    host: HOST,
    env: { TERM: 'xterm-ghostty', TERM_PROGRAM: 'ghostty' },
    mouseEnabled: true,
    nodeVersion: 'v22.19.0',
    platform: 'darwin',
    isTTY: true,
    cwd: '/tmp/deck',
    clipboardRoute: 'pbcopy',
    ...over,
  }
}

function byName(findings: readonly DoctorFinding[], name: string): DoctorFinding {
  const found = findings.find((f) => f.name === name)
  assert.ok(found, `missing finding ${name}`)
  return found
}

function namesOf(findings: readonly DoctorFinding[]): string[] {
  return findings.map((f) => f.name)
}

describe('doctor', () => {
  it('Ghostty-like caps + host + tty → hyperlinks/truecolor/host ok, no ascii finding', () => {
    const findings = doctorFindings(baseInput())
    assert.equal(byName(findings, 'hyperlinks').status, 'ok')
    assert.equal(byName(findings, 'truecolor').status, 'ok')
    assert.equal(byName(findings, 'host').status, 'ok')
    assert.equal(byName(findings, 'host').detail, 'v0.1.0 · /tmp/workspace · deepseek/deepseek-chat')
    assert.equal(byName(findings, 'tty').status, 'ok')
    assert.equal(byName(findings, 'terminal').status, 'ok')
    assert.match(byName(findings, 'terminal').detail, /TERM=xterm-ghostty/)
    assert.match(byName(findings, 'terminal').detail, /TERM_PROGRAM=ghostty/)
    assert.equal(byName(findings, 'node').status, 'ok')
    assert.ok(!namesOf(findings).includes('ascii'))
    assert.ok(!namesOf(findings).includes('caps override'))
    assert.ok(!namesOf(findings).includes('vim'))
    assert.deepEqual(namesOf(findings).slice(0, REQUIRED_NAMES.length), [...REQUIRED_NAMES])
    for (const id of ['hermes', 'codex', 'claudecode', 'pi', 'fx', 'kimicode']) {
      const finding = byName(findings, `harness ${id}`)
      assert.equal(finding.status, 'off')
      assert.match(finding.detail, /not on PATH/)
    }
  })

  it('NO_COLOR → truecolor off', () => {
    const findings = doctorFindings(baseInput({
      env: { TERM: 'xterm-ghostty', TERM_PROGRAM: 'ghostty', NO_COLOR: '1' },
    }))
    const truecolor = byName(findings, 'truecolor')
    assert.equal(truecolor.status, 'off')
    assert.match(truecolor.detail, /NO_COLOR/)
  })

  it('isTTY false → tty warn', () => {
    const findings = doctorFindings(baseInput({ isTTY: false }))
    const tty = byName(findings, 'tty')
    assert.equal(tty.status, 'warn')
    assert.equal(tty.detail, 'stdin is not a tty; keys/mouse may not work')
  })

  it('node 18.x → node warn', () => {
    const findings = doctorFindings(baseInput({ nodeVersion: 'v18.20.4' }))
    const node = byName(findings, 'node')
    assert.equal(node.status, 'warn')
    assert.match(node.detail, /18/)
  })

  it('node 22.19.0 → node ok', () => {
    assert.equal(byName(doctorFindings(baseInput({ nodeVersion: 'v22.19.0' })), 'node').status, 'ok')
    assert.equal(byName(doctorFindings(baseInput({ nodeVersion: '22.19.0' })), 'node').status, 'ok')
    assert.equal(byName(doctorFindings(baseInput({ nodeVersion: 'v22.19.1' })), 'node').status, 'ok')
    assert.equal(byName(doctorFindings(baseInput({ nodeVersion: 'v22.18.9' })), 'node').status, 'warn')
  })

  it('missing host → host warn', () => {
    const { host: _host, ...rest } = baseInput()
    const findings = doctorFindings(rest)
    const host = byName(findings, 'host')
    assert.equal(host.status, 'warn')
    assert.equal(host.detail, 'not connected')
  })

  it('DECK_ASCII=1 → ascii finding present', () => {
    const findings = doctorFindings(baseInput({
      env: { TERM: 'xterm-ghostty', TERM_PROGRAM: 'ghostty', DECK_ASCII: '1' },
    }))
    const ascii = byName(findings, 'ascii')
    assert.equal(ascii.status, 'warn')
    assert.match(ascii.detail, /unicode glyphs/i)
    const order = namesOf(findings)
    assert.ok(order.indexOf('ascii') > order.indexOf('editor uri'))
  })

  it('DECK_CAPS=+progress → caps override finding', () => {
    const findings = doctorFindings(baseInput({
      env: { TERM: 'xterm-ghostty', TERM_PROGRAM: 'ghostty', DECK_CAPS: '+progress' },
    }))
    const override = byName(findings, 'caps override')
    assert.equal(override.status, 'warn')
    assert.equal(override.detail, '+progress')
  })

  it('doctorLines starts with `deck doctor` and includes padded statuses', () => {
    const findings = doctorFindings(baseInput({ isTTY: false, mouseEnabled: false }))
    const lines = doctorLines(findings)
    assert.equal(lines[0], 'deck doctor')
    assert.ok(lines.length > 1)
    for (const line of lines.slice(1)) {
      assert.match(line, /^(ok  |warn|off ) \S/)
      const status = line.startsWith('ok') ? 'ok' : line.startsWith('warn') ? 'warn' : 'off'
      assert.ok(line.startsWith(`${status.padEnd(4)} `))
      assert.match(line, /  \S/)
    }
  })

  it('mouseEnabled false → mouse not ok', () => {
    const findings = doctorFindings(baseInput({ mouseEnabled: false }))
    const mouse = byName(findings, 'mouse')
    assert.notEqual(mouse.status, 'ok')
    assert.match(mouse.detail, /ctrl\+t/)
  })

  it('unicode core false is warn, not off', () => {
    const findings = doctorFindings(baseInput({
      caps: ghosttyCaps({ unicodeCore: false }),
    }))
    const unicode = byName(findings, 'unicode core')
    assert.equal(unicode.status, 'warn')
    assert.match(unicode.detail, /wide CJK/)
  })

  it('DECK_VIM=1 adds a vim finding; unset skips it', () => {
    const on = doctorFindings(baseInput({
      env: { TERM: 'xterm-ghostty', TERM_PROGRAM: 'ghostty', DECK_VIM: '1' },
    }))
    assert.equal(byName(on, 'vim').status, 'ok')
    assert.match(byName(on, 'vim').detail, /\/vim-mode/)

    const truthy = doctorFindings(baseInput({
      env: { TERM: 'xterm-ghostty', TERM_PROGRAM: 'ghostty', DECK_VIM: 'true' },
    }))
    assert.equal(byName(truthy, 'vim').status, 'ok')

    const off = doctorFindings(baseInput())
    assert.ok(!namesOf(off).includes('vim'))
  })

  it('DECK_EDITOR_URI set is ok with the template', () => {
    const findings = doctorFindings(baseInput({
      env: {
        TERM: 'xterm-ghostty',
        TERM_PROGRAM: 'ghostty',
        DECK_EDITOR_URI: 'cursor://file{path}:{line}',
      },
    }))
    const editor = byName(findings, 'editor uri')
    assert.equal(editor.status, 'ok')
    assert.equal(editor.detail, 'cursor://file{path}:{line}')
  })

  it('unknown terminal (TERM=dumb / missing TERM_PROGRAM) warns', () => {
    const caps: TerminalCapabilities = {
      isGhostty: false,
      trueColor: false,
      hyperlinks: false,
      kittyGraphics: false,
      notifications: false,
      progress: false,
      clipboard: false,
      syncOutput: false,
      unicodeCore: false,
    }
    const findings = doctorFindings(baseInput({
      caps,
      env: { TERM: 'dumb' },
    }))
    const terminal = byName(findings, 'terminal')
    assert.equal(terminal.status, 'warn')
    assert.match(terminal.detail, /TERM=dumb/)
  })

  it('OSC 52 off with no native clipboard route warns', () => {
    const { clipboardRoute: _route, ...rest } = baseInput({
      caps: ghosttyCaps({ clipboard: false }),
    })
    const findings = doctorFindings(rest)
    assert.equal(byName(findings, 'clipboard').status, 'warn')
  })

  it('reports present PATH harnesses without installing them', () => {
    const findings = doctorFindings(baseInput({
      env: {
        TERM: 'xterm-ghostty',
        TERM_PROGRAM: 'ghostty',
        PATH: '/opt/fake-bin',
      },
    }))
    // PATH is fake and empty of binaries — listing must still name all six.
    for (const id of ['hermes', 'codex', 'claudecode', 'pi', 'fx', 'kimicode']) {
      assert.ok(namesOf(findings).includes(`harness ${id}`), `missing harness ${id}`)
    }
  })
})

const GHOSTTY_FILL = [
  'hyperlinks',
  'truecolor',
  'clipboard',
  'sync output',
  'unicode core',
  'kitty graphics',
  'progress',
  'notifications',
  'mouse',
] as const

function offCaps(over: Partial<TerminalCapabilities> = {}): TerminalCapabilities {
  return {
    isGhostty: false,
    trueColor: false,
    hyperlinks: false,
    kittyGraphics: false,
    notifications: false,
    progress: false,
    clipboard: false,
    syncOutput: false,
    unicodeCore: false,
    ...over,
  }
}

function appliedByName(items: readonly DoctorFixItem[], name: string): DoctorFixItem {
  const found = items.find((item) => item.name === name)
  assert.ok(found, `missing fix item ${name}`)
  return found
}

describe('doctorFix', () => {
  it('Ghostty with all caps off + mouse off applies known-terminal fill; findings become ok', () => {
    const caps = ghosttyCaps({
      trueColor: false,
      hyperlinks: false,
      kittyGraphics: false,
      notifications: false,
      progress: false,
      clipboard: false,
      syncOutput: false,
      unicodeCore: false,
    })
    const result = doctorFix(baseInput({
      caps,
      mouseEnabled: false,
      env: {
        TERM: 'xterm-ghostty',
        TERM_PROGRAM: 'ghostty',
        DECK_EDITOR_URI: 'cursor://file{path}:{line}',
      },
    }))
    assert.equal(result.mouseEnabled, true)
    assert.equal(result.caps.trueColor, true)
    assert.equal(result.caps.hyperlinks, true)
    assert.equal(result.caps.clipboard, true)
    assert.equal(result.caps.syncOutput, true)
    assert.equal(result.caps.unicodeCore, true)
    assert.equal(result.caps.kittyGraphics, true)
    assert.equal(result.caps.progress, true)
    assert.equal(result.caps.notifications, true)
    for (const name of GHOSTTY_FILL) {
      const item = appliedByName(result.applied, name)
      assert.equal(item.applied, true)
      assert.equal(byName(result.findings, name).status, 'ok')
    }
    assert.equal(appliedByName(result.applied, 'mouse').detail, 'capture re-enabled')
    assert.equal(result.snippet, '')
    assert.ok(!('vimMode' in result))
  })

  it('NO_COLOR set → truecolor NOT applied', () => {
    const result = doctorFix(baseInput({
      caps: ghosttyCaps({
        trueColor: false,
        hyperlinks: false,
        kittyGraphics: false,
        notifications: false,
        progress: false,
        clipboard: false,
        syncOutput: false,
        unicodeCore: false,
      }),
      mouseEnabled: false,
      env: { TERM: 'xterm-ghostty', TERM_PROGRAM: 'ghostty', NO_COLOR: '1' },
    }))
    assert.equal(result.caps.trueColor, false)
    const truecolor = result.applied.find((item) => item.name === 'truecolor')
    assert.ok(truecolor === undefined || truecolor.applied === false)
    assert.equal(byName(result.findings, 'truecolor').status, 'off')
    assert.equal(appliedByName(result.applied, 'hyperlinks').applied, true)
    assert.equal(result.caps.hyperlinks, true)
  })

  it('kitty: kittyGraphics applied, progress NOT applied', () => {
    const result = doctorFix(baseInput({
      caps: offCaps({ termProgram: 'kitty' }),
      env: { TERM: 'xterm-kitty', TERM_PROGRAM: 'kitty' },
      mouseEnabled: true,
    }))
    assert.equal(appliedByName(result.applied, 'kitty graphics').applied, true)
    assert.equal(result.caps.kittyGraphics, true)
    assert.equal(result.caps.progress, false)
    assert.equal(result.caps.notifications, false)
    assert.ok(!result.applied.some((item) => item.name === 'progress' && item.applied))
    assert.ok(!result.applied.some((item) => item.name === 'notifications' && item.applied))
    assert.equal(result.caps.hyperlinks, true)
    assert.equal(result.caps.unicodeCore, true)
  })

  it('unknown TERM=dumb: no fake caps; snippet mentions DECK_CAPS', () => {
    const caps = offCaps()
    const result = doctorFix(baseInput({
      caps,
      env: { TERM: 'dumb' },
    }))
    assert.equal(result.caps.hyperlinks, false)
    assert.equal(result.caps.trueColor, false)
    assert.equal(result.caps.clipboard, false)
    assert.equal(result.caps.kittyGraphics, false)
    assert.equal(result.caps.progress, false)
    assert.match(result.snippet, /DECK_CAPS/)
    assert.match(result.snippet, /\+hyperlinks/)
    assert.match(result.snippet, /\+clipboard/)
    assert.equal(appliedByName(result.applied, 'hyperlinks').applied, false)
    assert.equal(appliedByName(result.applied, 'clipboard').applied, false)
  })

  it('editor uri unset → skip + snippet contains DECK_EDITOR_URI', () => {
    const result = doctorFix(baseInput())
    const editor = appliedByName(result.applied, 'editor uri')
    assert.equal(editor.applied, false)
    assert.match(editor.detail, /file:\/\//)
    assert.match(result.snippet, /DECK_EDITOR_URI/)
    assert.match(result.snippet, /cursor:\/\/file\{path\}:\{line\}/)
  })

  it('node old version → skip node, still in findings as warn', () => {
    const result = doctorFix(baseInput({ nodeVersion: 'v18.20.4' }))
    const node = appliedByName(result.applied, 'node')
    assert.equal(node.applied, false)
    assert.match(node.detail, /cannot upgrade Node/)
    assert.equal(byName(result.findings, 'node').status, 'warn')
    assert.match(byName(result.findings, 'node').detail, /18/)
  })

  it('does not mutate input.caps', () => {
    const caps = ghosttyCaps({ hyperlinks: false, trueColor: false })
    Object.freeze(caps)
    const input = baseInput({ caps, mouseEnabled: false })
    Object.freeze(input)
    const result = doctorFix(input)
    assert.notEqual(result.caps, caps)
    assert.equal(caps.hyperlinks, false)
    assert.equal(caps.trueColor, false)
    assert.equal(input.mouseEnabled, false)
    assert.equal(result.caps.hyperlinks, true)
    assert.equal(result.caps.trueColor, true)
    assert.equal(result.mouseEnabled, true)
  })

  it('doctorFixLines contains `deck doctor fix` and `fix  mouse`', () => {
    const result = doctorFix(baseInput({ mouseEnabled: false }))
    const lines = doctorFixLines(result)
    assert.equal(lines[0], 'deck doctor fix')
    assert.ok(lines.some((line) => line.includes('fix  mouse')))
    const blank = lines.indexOf('')
    assert.ok(blank > 0)
    assert.equal(lines[blank + 1], 'deck doctor')
  })
})
