/**
 * Shared runtime guards for untrusted wire data. Arrays are never valid
 * records here — JSON payloads arrive as objects, and treating an array as a
 * record only produces accidental `undefined` property reads.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
