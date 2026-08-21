import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'src', 'cli.ts')

function runCli(args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('close', (code) => {
      resolveRun({ code, stdout, stderr })
    })
  })
}

describe('CLI flags', () => {
  it('--help prints deck usage', async () => {
    const result = await runCli(['--help'], {})
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /deck/)
    assert.match(result.stdout, /--attach/)
    assert.match(result.stdout, /--harness/)
  })

  it('--harness lists all six ids with present or missing status', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deck-cli-harness-'))
    const bin = join(dir, 'bin')
    mkdirSync(bin, { recursive: true })
    for (const name of ['hermes', 'codex', 'claude', 'kimi']) {
      const path = join(bin, name)
      writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      chmodSync(path, 0o755)
    }
    const result = await runCli(['--harness'], { PATH: bin })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /deck harness/)
    for (const id of ['hermes', 'codex', 'claudecode', 'pi', 'fx', 'kimicode']) {
      assert.match(result.stdout, new RegExp(id))
    }
    assert.match(result.stdout, /ok\s+hermes/)
    assert.match(result.stdout, /ok\s+claudecode/)
    assert.match(result.stdout, /miss\s+pi/)
    assert.match(result.stdout, /miss\s+fx/)
  })
})
