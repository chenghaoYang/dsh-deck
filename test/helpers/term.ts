/**
 * Shared fixtures for the terminal layer tests: a full capabilities record,
 * an in-memory output stream, and an InputReader wired to collect keys.
 */

import { Readable } from 'node:stream'
import type { TerminalCapabilities } from '../../src/term/capabilities.ts'
import { InputReader, type Key } from '../../src/term/input.ts'

export function caps(over: Partial<TerminalCapabilities> = {}): TerminalCapabilities {
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
    ...over,
  }
}

export function fakeOut(columns = 40, rows = 8) {
  let data = ''
  const stream = {
    columns,
    rows,
    isTTY: false,
    write(chunk: string | Uint8Array) {
      data += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      return true
    },
    on() {
      return stream
    },
    removeListener() {
      return stream
    },
  }
  return {
    stream: stream as unknown as NodeJS.WriteStream,
    get output() {
      return data
    },
    clear() {
      data = ''
    },
  }
}

export function collectKeys(input: Readable): { reader: InputReader; keys: Key[] } {
  const reader = new InputReader(input as unknown as NodeJS.ReadStream)
  const keys: Key[] = []
  reader.onKey((k) => keys.push(k))
  reader.start()
  return { reader, keys }
}
