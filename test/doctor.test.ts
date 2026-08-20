import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { HostDescription } from '../src/protocol/contract.ts'
import type { TerminalCapabilities } from '../src/term/capabilities.ts'
import {
  doctorFindings,
  doctorLines,
  type DoctorFinding,
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
})
