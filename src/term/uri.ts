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
  return base.includes('.')
}

function pathToFileUrl(abs: string): string {
  const normalized = abs.replace(/\\/g, '/')
  const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${prefixed.split('/').map(encodeURIComponent).join('/')}`
}
