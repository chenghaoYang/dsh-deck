import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  HARNESS_IDS,
  buildHarnessOverlay,
  discoverHarnesses,
  formatHarnessList,
  harnessAssistantText,
  isHarnessId,
  isSessionHarness,
  spawnHarnessTurn,
  specOf,
  type HarnessId,
} from '../src/harness.ts'

const ALL_IDS: readonly HarnessId[] = ['hermes', 'codex', 'claudecode', 'pi', 'fx', 'kimicode']

function snapshotTree(root: string, files: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rel of files) {
    const path = join(root, rel)
    out[rel] = existsSync(path) ? readFileSync(path, 'utf8') : ''
  }
  return out
}

function stubScript(): string {
  return `#!${process.execPath}
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const homes = [
  process.env.HERMES_HOME,
  process.env.CODEX_HOME,
  process.env.CLAUDE_CONFIG_DIR,
  process.env.PI_CODING_AGENT_DIR,
  process.env.FX_HOME,
  process.env.KIMI_CODE_HOME,
].filter((value) => typeof value === 'string' && value.length > 0)
for (const home of homes) {
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'deck-overlay-wrote'), 'ok')
}
process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  DECK_HARNESS: process.env.DECK_HARNESS,
  DECK_HARNESS_PROVIDER: process.env.DECK_HARNESS_PROVIDER,
  DECK_HARNESS_MODEL: process.env.DECK_HARNESS_MODEL,
  DECK_HARNESS_EFFORT: process.env.DECK_HARNESS_EFFORT,
  HERMES_HOME: process.env.HERMES_HOME,
  CODEX_HOME: process.env.CODEX_HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  FX_HOME: process.env.FX_HOME,
  KIMI_CODE_HOME: process.env.KIMI_CODE_HOME,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  HERMES_INFERENCE_MODEL: process.env.HERMES_INFERENCE_MODEL,
  FX_MODEL: process.env.FX_MODEL,
  KIMI_MODEL: process.env.KIMI_MODEL,
}) + '\\n')
`
}

function makeBins(root: string, names: readonly string[]): string {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const body = stubScript()
  for (const name of names) {
    const path = join(bin, name)
    writeFileSync(path, body, { mode: 0o755 })
    chmodSync(path, 0o755)
  }
  return bin
}

function seedUserHomes(home: string): readonly string[] {
  const files = [
    '.codex/config.toml',
    '.claude/settings.json',
    '.hermes/config.yaml',
    '.kimi-code/config.toml',
    '.pi/agent/settings.json',
    '.fx/config.json',
  ]
  const contents = {
    '.codex/config.toml': 'model = "standalone-codex"\n',
    '.claude/settings.json': '{"model":"standalone-claude"}\n',
    '.hermes/config.yaml': 'model: standalone-hermes\n',
    '.kimi-code/config.toml': 'default_model = "standalone-kimi"\n',
    '.pi/agent/settings.json': '{"model":"standalone-pi"}\n',
    '.fx/config.json': '{"model":"standalone-fx"}\n',
  }
  for (const rel of files) {
    const path = join(home, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, contents[rel as keyof typeof contents])
  }
  return files
}

describe('harness catalog', () => {
  it('names the six PATH harnesses and their aliases', () => {
    assert.deepEqual([...HARNESS_IDS], [...ALL_IDS])
    assert.equal(isHarnessId('claudecode'), true)
    assert.equal(isHarnessId('claude'), false)
    assert.equal(isSessionHarness('dsh'), true)
    assert.equal(isSessionHarness('claude'), false)
    assert.deepEqual(specOf('claudecode').binaries, ['claude', 'claudecode'])
    assert.deepEqual(specOf('kimicode').binaries, ['kimi', 'kimicode'])
  })
})

describe('discoverHarnesses', () => {
  it('reports present vs missing on a fake PATH, including claude/kimi aliases', () => {
    const root = mkdtempSync(join(tmpdir(), 'deck-harness-path-'))
    const bin = makeBins(root, ['hermes', 'codex', 'claude', 'kimi'])
    const rows = discoverHarnesses({
      env: { PATH: bin },
      pathSep: ':',
      platform: 'darwin',
    })
    assert.equal(rows.length, 6)
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]))
    assert.equal(byId.hermes?.present, true)
    assert.equal(byId.codex?.present, true)
    assert.equal(byId.claudecode?.present, true)
    assert.equal(byId.claudecode?.resolvedName, 'claude')
    assert.ok(byId.claudecode?.binary?.endsWith('/claude'))
    assert.equal(byId.kimicode?.present, true)
    assert.equal(byId.kimicode?.resolvedName, 'kimi')
    assert.ok(byId.kimicode?.binary?.endsWith('/kimi'))
    assert.equal(byId.pi?.present, false)
    assert.equal(byId.fx?.present, false)
    assert.equal(byId.pi?.binary, undefined)

    const listed = formatHarnessList(rows)
    for (const id of ALL_IDS) assert.match(listed, new RegExp(id))
    assert.match(listed, /ok\s+hermes/)
    assert.match(listed, /ok\s+claudecode/)
    assert.match(listed, /miss\s+pi/)
    assert.match(listed, /miss\s+fx/)
  })

  it('treats claudecode and kimicode binaries as aliases when claude/kimi are absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'deck-harness-alias-'))
    const bin = makeBins(root, ['claudecode', 'kimicode'])
    const rows = discoverHarnesses({ env: { PATH: bin }, pathSep: ':', platform: 'darwin' })
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]))
    assert.equal(byId.claudecode?.present, true)
    assert.equal(byId.claudecode?.resolvedName, 'claudecode')
    assert.equal(byId.kimicode?.present, true)
    assert.equal(byId.kimicode?.resolvedName, 'kimicode')
  })

  it('does not consult process.env PATH when env.PATH is empty', () => {
    const rows = discoverHarnesses({
      env: { PATH: '' },
      pathSep: ':',
      platform: 'darwin',
    })
    assert.equal(rows.every((row) => row.present === false), true)
  })
})

describe('buildHarnessOverlay', () => {
  it('injects dsh selection into argv/env and points home vars at the overlay', () => {
    const root = mkdtempSync(join(tmpdir(), 'deck-harness-overlay-'))
    const userHome = join(root, 'user')
    const overlayHome = join(root, 'overlay')
    mkdirSync(userHome, { recursive: true })
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: userHome,
      DEEPSEEK_API_KEY: 'dsk-test',
      DEEPSEEK_BASE_URL: 'http://127.0.0.1:4310',
      UNRELATED: 'keep-me',
    }
    const selection = { provider: 'deepseek-official', model: 'deepseek-v4-flash', effort: 'high' }

    for (const id of ALL_IDS) {
      const plan = buildHarnessOverlay({
        harness: id,
        binary: `/opt/${id}`,
        selection,
        overlayHome: join(overlayHome, id),
        env: source,
        cwd: '/work',
        userHome,
      })
      assert.notEqual(plan.env, source)
      assert.notEqual(plan.env, process.env)
      assert.equal(plan.env.UNRELATED, 'keep-me')
      assert.equal(plan.env.DECK_HARNESS, id)
      assert.equal(plan.env.DECK_HARNESS_PROVIDER, 'deepseek-official')
      assert.equal(plan.env.DECK_HARNESS_MODEL, 'deepseek-v4-flash')
      assert.equal(plan.env.DECK_HARNESS_EFFORT, 'high')
      assert.equal(plan.cwd, '/work')
      const spec = specOf(id)
      for (const homeVar of spec.homeVars) {
        assert.equal(plan.env[homeVar], join(overlayHome, id), `${id} ${homeVar}`)
        assert.ok(plan.isolatedHomeVars.includes(homeVar))
      }
      for (const dir of spec.userHomeDirs) {
        assert.ok(plan.protectedHomes.includes(join(userHome, dir)), `${id} protects ${dir}`)
      }
      const argv = plan.argv.join(' ')
      if (id === 'fx') {
        assert.equal(plan.env.FX_MODEL, 'deepseek-v4-flash')
        assert.ok(!plan.argv.includes('--model'))
      } else {
        assert.ok(argv.includes('deepseek-v4-flash'), `${id} argv model`)
      }
      if (id !== 'fx' && id !== 'kimicode') {
        assert.ok(
          argv.includes('deepseek-official') || argv.includes('high') || argv.includes('--model'),
          `${id} argv carries dsh selection`,
        )
      }
    }

    const hermes = buildHarnessOverlay({
      harness: 'hermes',
      binary: '/opt/hermes',
      selection,
      overlayHome: join(overlayHome, 'hermes'),
      env: source,
      cwd: '/work',
      userHome,
      prompt: 'hello',
    })
    assert.ok(hermes.argv.includes('--ignore-user-config'))
    assert.ok(hermes.argv.includes('--yolo'))
    assert.ok(hermes.argv.includes('-m'))
    assert.ok(!hermes.argv.includes('--provider'))
    assert.ok(!hermes.argv.includes('deepseek-official'))
    assert.ok(hermes.argv.includes('--reasoning'))
    assert.ok(hermes.argv.includes('-z'))
    assert.equal(hermes.env.HERMES_INFERENCE_MODEL, 'deepseek-v4-flash')
    assert.equal(hermes.env.DECK_HARNESS_PROVIDER, 'deepseek-official')

    const claude = buildHarnessOverlay({
      harness: 'claudecode',
      binary: '/opt/claude',
      selection,
      overlayHome: join(overlayHome, 'claude'),
      env: source,
      cwd: '/work',
      userHome,
      prompt: 'hello',
    })
    assert.ok(claude.argv.includes('--model'))
    assert.ok(claude.argv.includes('--effort'))
    assert.ok(claude.argv.includes('--dangerously-skip-permissions'))
    assert.equal(claude.env.ANTHROPIC_MODEL, 'deepseek-v4-flash')
    assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, 'dsk-test')
    assert.equal(claude.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4310')
    assert.equal(claude.env.CLAUDE_CONFIG_DIR, join(overlayHome, 'claude'))

    const fx = buildHarnessOverlay({
      harness: 'fx',
      binary: '/opt/fx',
      selection,
      overlayHome: join(overlayHome, 'fx'),
      env: source,
      cwd: '/work',
      userHome,
      prompt: 'hello',
    })
    assert.ok(!fx.argv.includes('--model'))
    assert.ok(fx.argv.includes('ask'))
    assert.ok(fx.argv.includes('--json'))
    assert.ok(fx.argv.includes('--yolo'))
    assert.equal(fx.env.FX_MODEL, 'deepseek-v4-flash')
    assert.equal(fx.env.HOME, join(overlayHome, 'fx', 'home'))
    assert.notEqual(fx.env.HOME, source.HOME)
    assert.notEqual(fx.env, process.env)

    const pi = buildHarnessOverlay({
      harness: 'pi',
      binary: '/opt/pi',
      selection,
      overlayHome: join(overlayHome, 'pi'),
      env: source,
      cwd: '/work',
      userHome,
      prompt: 'hello',
    })
    assert.ok(pi.argv.includes('-p'))
    assert.ok(pi.argv.includes('--model'))
    assert.ok(!pi.argv.includes('--provider'))
    assert.ok(!pi.argv.includes('deepseek-official'))
    assert.equal(pi.env.DECK_HARNESS_PROVIDER, 'deepseek-official')

    const skip = new Map<HarnessId, string>([
      ['hermes', '--yolo'],
      ['codex', '--dangerously-bypass-approvals-and-sandbox'],
      ['claudecode', '--dangerously-skip-permissions'],
      ['fx', '--yolo'],
      ['kimicode', '--auto'],
    ])
    for (const [id, flag] of skip) {
      const plan = buildHarnessOverlay({
        harness: id,
        binary: `/opt/${id}`,
        selection,
        overlayHome: join(overlayHome, id),
        env: source,
        cwd: '/work',
        userHome,
        prompt: 'hello',
      })
      assert.ok(plan.argv.includes(flag), `${id} overlay must pass ${flag}`)
    }
  })

  it('maps ARK Agent Plan keys onto Claude /api/plan and OpenAI /api/plan/v3 without touching user homes', () => {
    const root = mkdtempSync(join(tmpdir(), 'deck-harness-ark-'))
    const userHome = join(root, 'user')
    mkdirSync(userHome, { recursive: true })
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: userHome,
      ARK_API_KEY: 'ark-test-key',
    }
    const selection = { provider: 'ark-plan', model: 'deepseek-v4-flash' }

    const claude = buildHarnessOverlay({
      harness: 'claudecode',
      binary: '/opt/claude',
      selection,
      overlayHome: join(root, 'overlay', 'claude'),
      env: source,
      cwd: '/work',
      userHome,
    })
    assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, 'ark-test-key')
    assert.equal(claude.env.ANTHROPIC_BASE_URL, 'https://ark.cn-beijing.volces.com/api/plan')
    assert.equal(claude.env.ANTHROPIC_MODEL, 'deepseek-v4-flash')
    assert.notEqual(claude.env, process.env)

    const codex = buildHarnessOverlay({
      harness: 'codex',
      binary: '/opt/codex',
      selection,
      overlayHome: join(root, 'overlay', 'codex'),
      env: source,
      cwd: '/work',
      userHome,
    })
    assert.equal(codex.env.OPENAI_API_KEY, 'ark-test-key')
    assert.equal(codex.env.OPENAI_BASE_URL, 'https://ark.cn-beijing.volces.com/api/plan/v3')
  })

  it('ignores a UUID ARK_API_KEY and prefers ARK_PLAN_API_KEY for Agent Plan', () => {
    const root = mkdtempSync(join(tmpdir(), 'deck-harness-ark-uuid-'))
    const userHome = join(root, 'user')
    mkdirSync(userHome, { recursive: true })
    const selection = { provider: 'ark-plan', model: 'deepseek-v4-flash' }

    const ignored = buildHarnessOverlay({
      harness: 'claudecode',
      binary: '/opt/claude',
      selection,
      overlayHome: join(root, 'overlay', 'ignored'),
      env: {
        PATH: '/usr/bin',
        HOME: userHome,
        ARK_API_KEY: '8ed2037c-d570-415c-9026-7e596425262d',
      },
      cwd: '/work',
      userHome,
    })
    assert.equal(ignored.env.ANTHROPIC_AUTH_TOKEN, undefined)
    assert.equal(ignored.env.ANTHROPIC_BASE_URL, undefined)

    const preferred = buildHarnessOverlay({
      harness: 'codex',
      binary: '/opt/codex',
      selection,
      overlayHome: join(root, 'overlay', 'preferred'),
      env: {
        PATH: '/usr/bin',
        HOME: userHome,
        ARK_API_KEY: '8ed2037c-d570-415c-9026-7e596425262d',
        ARK_PLAN_API_KEY: 'ark-plan-key',
        OPENAI_API_KEY: 'sk-unrelated',
        ARK_PLAN_BASE_URL: 'https://ark.cn-beijing.volces.com/api/plan/v3',
      },
      cwd: '/work',
      userHome,
    })
    assert.equal(preferred.env.OPENAI_API_KEY, 'ark-plan-key')
    assert.equal(preferred.env.OPENAI_BASE_URL, 'https://ark.cn-beijing.volces.com/api/plan/v3')
  })

  it('fills missing Agent Plan keys from the dsh credentials file without using os.homedir', () => {
    const root = mkdtempSync(join(tmpdir(), 'deck-harness-ark-cred-'))
    const userHome = join(root, 'user')
    const dshHome = join(userHome, '.dsh')
    mkdirSync(dshHome, { recursive: true })
    writeFileSync(
      join(dshHome, '.credentials.yaml'),
      'ARK_PLAN_API_KEY: ark-from-file\nNVIDIA_API_KEY: nvapi-keep\n',
      { mode: 0o600 },
    )
    const selection = { provider: 'ark-plan', model: 'deepseek-v4-flash' }

    const fromHome = buildHarnessOverlay({
      harness: 'claudecode',
      binary: '/opt/claude',
      selection,
      overlayHome: join(root, 'overlay', 'from-home'),
      env: { PATH: '/usr/bin', HOME: userHome },
      cwd: '/work',
      userHome,
    })
    assert.equal(fromHome.env.ARK_PLAN_API_KEY, 'ark-from-file')
    assert.equal(fromHome.env.ANTHROPIC_AUTH_TOKEN, 'ark-from-file')
    assert.equal(fromHome.env.ANTHROPIC_BASE_URL, 'https://ark.cn-beijing.volces.com/api/plan')
    assert.equal(fromHome.env.NVIDIA_API_KEY, 'nvapi-keep')

    const isolated = buildHarnessOverlay({
      harness: 'codex',
      binary: '/opt/codex',
      selection,
      overlayHome: join(root, 'overlay', 'isolated'),
      env: { PATH: '/usr/bin' },
      cwd: '/work',
      userHome,
    })
    assert.equal(isolated.env.ARK_PLAN_API_KEY, undefined)
    assert.equal(isolated.env.OPENAI_API_KEY, undefined)
    assert.equal(isolated.env.OPENAI_BASE_URL, undefined)
  })
})

describe('harnessAssistantText', () => {
  it('unwraps fx ask --json output and leaves other CLIs as stdout', () => {
    assert.equal(
      harnessAssistantText('fx', '{"output":"the answer","ok":true}\n'),
      'the answer',
    )
    assert.equal(
      harnessAssistantText('fx', 'noise\n{"output":"line two"}\n'),
      'line two',
    )
    assert.equal(harnessAssistantText('codex', 'plain stdout\n'), 'plain stdout')
    assert.equal(harnessAssistantText('fx', 'not json'), 'not json')
  })
})

describe('spawnHarnessTurn abort', () => {
  it('kills a long-running overlay child when the signal aborts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'deck-harness-abort-'))
    const bin = join(root, 'bin')
    mkdirSync(bin, { recursive: true })
    const sleeper = join(bin, 'codex')
    writeFileSync(sleeper, `#!${process.execPath}\nsetInterval(() => {}, 1000)\n`, { mode: 0o755 })
    chmodSync(sleeper, 0o755)
    const plan = buildHarnessOverlay({
      harness: 'codex',
      binary: sleeper,
      selection: { provider: 'nvidia', model: 'inkling' },
      overlayHome: join(root, 'overlay'),
      env: { PATH: bin, HOME: join(root, 'user') },
      cwd: root,
      userHome: join(root, 'user'),
      prompt: 'hang',
    })
    const ac = new AbortController()
    const started = Date.now()
    const pending = spawnHarnessTurn(plan, { signal: ac.signal, timeoutMs: 20_000 })
    await new Promise((resolveWait) => setTimeout(resolveWait, 80))
    ac.abort()
    const result = await pending
    assert.equal(result.aborted, true)
    assert.ok(Date.now() - started < 5_000, 'abort must not wait for the 120s timeout')
  })
})

describe('overlay isolation', () => {
  it('dry-run spawn writes only the overlay home; fake user homes stay byte-identical', async () => {
    const root = mkdtempSync(join(tmpdir(), 'deck-harness-iso-'))
    const userHome = join(root, 'user')
    mkdirSync(userHome, { recursive: true })
    const userFiles = seedUserHomes(userHome)
    const before = snapshotTree(userHome, userFiles)
    const bin = makeBins(root, ['hermes', 'codex', 'claude', 'pi', 'fx', 'kimi'])
    const rows = discoverHarnesses({ env: { PATH: bin }, pathSep: ':', platform: 'darwin' })
    const source: NodeJS.ProcessEnv = {
      PATH: bin,
      HOME: userHome,
      DEEPSEEK_API_KEY: 'dsk-test',
      DEEPSEEK_BASE_URL: 'http://127.0.0.1:4310',
    }
    const selection = { provider: 'nvidia', model: 'inkling', effort: 'low' }

    for (const row of rows) {
      assert.equal(row.present, true, `${row.id} should be on the fake PATH`)
      assert.ok(row.binary !== undefined)
      const overlayHome = join(root, 'overlay', row.id)
      const plan = buildHarnessOverlay({
        harness: row.id,
        binary: row.binary,
        selection,
        overlayHome,
        env: source,
        cwd: root,
        userHome,
        prompt: 'ping',
      })
      assert.notEqual(plan.env, process.env)
      const result = await spawnHarnessTurn(plan, { timeoutMs: 8_000 })
      assert.equal(result.code, 0, `${row.id} stub failed: ${result.stderr}`)
      const report = JSON.parse(result.stdout) as {
        argv?: string[]
        DECK_HARNESS_MODEL?: string
        DECK_HARNESS_PROVIDER?: string
      }
      assert.equal(report.DECK_HARNESS_MODEL, 'inkling')
      assert.equal(report.DECK_HARNESS_PROVIDER, 'nvidia')
      if (row.id === 'hermes' || row.id === 'pi') {
        assert.ok(!(report.argv ?? []).includes('--provider'), `${row.id} must not pass --provider`)
        assert.ok(!(report.argv ?? []).includes('nvidia'), `${row.id} must not pass a raw dsh provider id`)
      }
      assert.equal(readFileSync(join(overlayHome, 'deck-overlay-wrote'), 'utf8'), 'ok')
    }

    const after = snapshotTree(userHome, userFiles)
    assert.deepEqual(after, before)
    assert.equal(existsSync(join(userHome, '.codex', 'deck-overlay-wrote')), false)
    assert.equal(existsSync(join(userHome, '.claude', 'deck-overlay-wrote')), false)
    assert.equal(existsSync(join(userHome, '.hermes', 'deck-overlay-wrote')), false)
  })
})
