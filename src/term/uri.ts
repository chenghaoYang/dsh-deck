/**
 * File URI construction for OSC 8 links. Does not import node:url.
 */

export function fileHref(path: string, line?: number, env?: NodeJS.ProcessEnv): string {
  const tmpl = (env ?? process.env).DECK_EDITOR_URI
  if (tmpl !== undefined && tmpl.length > 0) {
    return tmpl.replaceAll('{path}', path).replaceAll('{line}', String(line ?? 1))
  }
  const abs = path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? path : `${process.cwd()}/${path}`
  const href = pathToFileUrl(abs)
  return line !== undefined ? `${href}#L${line}` : href
}

/** True when `value` looks like a filesystem path worth turning into an OSC 8 link. */
export function linkableFilePath(value: string): boolean {
  if (value.length === 0) return false
  if (/[*?[\]]/.test(value)) return false
  const absolute = value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
  if (value.includes('://') && !absolute) return false
  if (value.includes('/') || value.includes('\\')) return true
  if (value.startsWith('./') || value.startsWith('../')) return true
  const base = value.split(/[/\\]/).pop() ?? ''
  if (!/[A-Za-z]/.test(base)) return false
  const lastDot = base.lastIndexOf('.')
  if (lastDot <= 0) return false
  const ext = base.slice(lastDot + 1)
  return ext.length > 0 && ext.length <= 8 && /^[A-Za-z0-9]+$/.test(ext)
}

export type PathRun = { text: string; href?: string }

// `:` is omitted so `path:line` and `https://…` stay one token; line suffixes
// are stripped in hrefForToken, and URLs are rejected by linkableFilePath.
const TOKEN_SEP = /[\s()[\]{}<>,;!?]/
const LINE_SUFFIX = /^(.+?):(\d+)(?::(\d+))?$/

/** Split text into `{text, href?}` runs. `href` is omitted when not a link. */
export function linkifyPathRuns(text: string, env?: NodeJS.ProcessEnv): PathRun[] {
  if (text.length === 0) return []
  const runs: PathRun[] = []
  let i = 0
  let buf = ''
  const flushBuf = (): void => {
    if (buf.length === 0) return
    tokenizeBare(buf, env, runs)
    buf = ''
  }
  while (i < text.length) {
    if (text.charCodeAt(i) === 96) {
      const end = text.indexOf('`', i + 1)
      if (end > i + 1) {
        const inner = text.slice(i + 1, end)
        const href = hrefForToken(inner, env)
        if (href !== undefined) {
          flushBuf()
          pushRun(runs, '`')
          pushRun(runs, inner, href)
          pushRun(runs, '`')
          i = end + 1
          continue
        }
      }
    }
    buf += text[i] ?? ''
    i += 1
  }
  flushBuf()
  return runs
}

function tokenizeBare(text: string, env: NodeJS.ProcessEnv | undefined, runs: PathRun[]): void {
  let i = 0
  while (i < text.length) {
    const ch = text[i] ?? ''
    if (TOKEN_SEP.test(ch)) {
      let j = i + 1
      while (j < text.length && TOKEN_SEP.test(text[j] ?? '')) j += 1
      pushRun(runs, text.slice(i, j))
      i = j
      continue
    }
    let j = i + 1
    while (j < text.length && !TOKEN_SEP.test(text[j] ?? '')) j += 1
    const token = text.slice(i, j)
    const href = hrefForToken(token, env)
    if (href !== undefined) pushRun(runs, token, href)
    else pushRun(runs, token)
    i = j
  }
}

function hrefForToken(token: string, env?: NodeJS.ProcessEnv): string | undefined {
  const lined = LINE_SUFFIX.exec(token)
  if (lined !== null) {
    const path = lined[1]
    const lineRaw = lined[2]
    if (path !== undefined && lineRaw !== undefined && linkableFilePath(path)) {
      return fileHref(path, Number(lineRaw), env)
    }
  }
  if (linkableFilePath(token)) return fileHref(token, undefined, env)
  return undefined
}

function pushRun(runs: PathRun[], text: string, href?: string): void {
  if (text.length === 0) return
  const last = runs[runs.length - 1]
  if (href === undefined && last !== undefined && last.href === undefined) {
    last.text += text
    return
  }
  if (href !== undefined) runs.push({ text, href })
  else runs.push({ text })
}

function pathToFileUrl(abs: string): string {
  const normalized = abs.replace(/\\/g, '/')
  const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${prefixed.split('/').map(encodeURIComponent).join('/')}`
}
