import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { loadPrefs, savePrefs, type DeckPrefs } from '../src/model/prefs.ts'

function tempEnv(): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'deck-prefs-'))
  return { dir, env: { DECK_HOME: dir } }
}

describe('prefs', () => {
  it('loads {} when the file is missing', () => {
    const { env } = tempEnv()
    assert.deepEqual(loadPrefs(env), {})
  })

  it('roundtrips grouping, pinned, and pinOrder as pretty JSON', () => {
    const { dir, env } = tempEnv()
    const prefs: DeckPrefs = {
      dashboard: {
        grouping: 'directory',
        pinned: ['alpha', 'beta'],
        pinOrder: ['beta', 'alpha'],
      },
    }
    assert.equal(savePrefs(prefs, env), true)
    assert.deepEqual(loadPrefs(env), prefs)

    const raw = readFileSync(join(dir, 'prefs.json'), 'utf8')
    assert.equal(raw.endsWith('\n'), true)
    assert.equal(raw, `${JSON.stringify(prefs, null, 2)}\n`)
  })

  it('yields {} for malformed JSON', () => {
    const { dir, env } = tempEnv()
    writeFileSync(join(dir, 'prefs.json'), '{not json', 'utf8')
    assert.deepEqual(loadPrefs(env), {})

    writeFileSync(join(dir, 'prefs.json'), 'null', 'utf8')
    assert.deepEqual(loadPrefs(env), {})

    writeFileSync(join(dir, 'prefs.json'), '[]', 'utf8')
    assert.deepEqual(loadPrefs(env), {})
  })

  it('merges dashboard updates without dropping the rest of the file', () => {
    const { env } = tempEnv()
    assert.equal(savePrefs({
      dashboard: { grouping: 'state', pinned: ['keep'], pinOrder: ['keep'] },
    }, env), true)
    assert.equal(savePrefs({
      dashboard: { grouping: 'directory', pinned: ['keep'], pinOrder: ['keep'] },
    }, env), true)
    assert.deepEqual(loadPrefs(env), {
      dashboard: { grouping: 'directory', pinned: ['keep'], pinOrder: ['keep'] },
    })
  })

  it('creates a missing directory on save', () => {
    const { dir, env } = tempEnv()
    const nested = join(dir, 'nested', 'home')
    const nestedEnv: NodeJS.ProcessEnv = { DECK_HOME: nested }
    const prefs: DeckPrefs = { dashboard: { grouping: 'state' } }
    assert.equal(savePrefs(prefs, nestedEnv), true)
    assert.deepEqual(loadPrefs(nestedEnv), prefs)
    assert.equal(env.DECK_HOME, dir)
  })
})
