import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fileHref, linkableFilePath } from '../src/term/uri.ts'

const noTmpl: NodeJS.ProcessEnv = {}

describe('fileHref', () => {
  it('uses DECK_EDITOR_URI as a template and defaults line to 1', () => {
    const env: NodeJS.ProcessEnv = { DECK_EDITOR_URI: 'cursor://file{path}:{line}' }
    assert.equal(fileHref('/tmp/x.ts', 3, env), 'cursor://file/tmp/x.ts:3')
    assert.equal(fileHref('/tmp/x.ts', undefined, env), 'cursor://file/tmp/x.ts:1')
  })

  it('encodes each path segment in a file:// URL', () => {
    assert.equal(fileHref('/tmp/foo bar.ts', undefined, noTmpl), 'file:///tmp/foo%20bar.ts')
    assert.equal(fileHref('/tmp/a#b.ts', undefined, noTmpl), 'file:///tmp/a%23b.ts')
  })

  it('keeps absolute unix and windows paths and resolves relative ones against cwd', () => {
    assert.equal(fileHref('/tmp/x.ts', undefined, noTmpl), 'file:///tmp/x.ts')
    assert.equal(fileHref('C:\\Users\\file.ts', undefined, noTmpl), 'file:///C%3A/Users/file.ts')
    const href = fileHref('src/ui/app.ts', undefined, noTmpl)
    assert.ok(href.startsWith('file://'), href)
    assert.ok(href.includes('app.ts'), href)
    const cwdSegs = process.cwd().replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
    const prefixed = cwdSegs.startsWith('/') ? cwdSegs : `/${cwdSegs}`
    assert.equal(href, `file://${prefixed}/src/ui/app.ts`)
  })

  it('appends #L<line> only when a line is given', () => {
    assert.equal(fileHref('/tmp/x.ts', 12, noTmpl), 'file:///tmp/x.ts#L12')
    assert.equal(fileHref('/tmp/x.ts', undefined, noTmpl), 'file:///tmp/x.ts')
  })

  it('ignores an empty DECK_EDITOR_URI template', () => {
    assert.equal(fileHref('/tmp/x.ts', undefined, { DECK_EDITOR_URI: '' }), 'file:///tmp/x.ts')
  })
})

describe('linkableFilePath', () => {
  it('accepts paths with slashes, relative prefixes, or a filename extension', () => {
    assert.equal(linkableFilePath('src/ui/app.ts'), true)
    assert.equal(linkableFilePath('/tmp/x.ts'), true)
    assert.equal(linkableFilePath('./foo'), true)
    assert.equal(linkableFilePath('../bar.ts'), true)
    assert.equal(linkableFilePath('README.md'), true)
    assert.equal(linkableFilePath('C:\\Users\\file.ts'), true)
  })

  it('rejects empty values, globs, command lines, and URLs', () => {
    assert.equal(linkableFilePath(''), false)
    assert.equal(linkableFilePath('ls src'), false)
    assert.equal(linkableFilePath('src/*.ts'), false)
    assert.equal(linkableFilePath('src/**/*.ts'), false)
    assert.equal(linkableFilePath('src/[a].ts'), false)
    assert.equal(linkableFilePath('foo?bar'), false)
    assert.equal(linkableFilePath('https://example.com/x.ts'), false)
    assert.equal(linkableFilePath('file.ts?x=1'), false)
    assert.equal(linkableFilePath('foo'), false)
  })
})
