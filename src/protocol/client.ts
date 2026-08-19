import {
  API_PATH,
  RESPOND_PATH,
  type ClientRequest,
  type ClientResponse,
  type RpcError,
  type RpcId,
  type RpcMethodName,
  type RpcReceipt,
  type RpcResult,
  type RequestPayload,
  type ResponseValue,
  type ServerResponse,
} from './contract.ts'

export interface DeckClientOptions {
  /** e.g. "http://127.0.0.1:3080" */
  baseUrl: string
  /** bounded unary deadline, default 30_000 */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Fold a thrown carrier failure the same way upstream `transportError` does. */
function transportError<T>(error: unknown): RpcResult<T> {
  return {
    ok: false,
    error: {
      code: 'internal',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}

function asRpcResult<T>(result: unknown): RpcResult<T> | undefined {
  if (!isRecord(result) || typeof result.ok !== 'boolean') return undefined
  if (result.ok) return { ok: true, value: result.value as T }
  const error = result.error
  if (!isRecord(error) || typeof error.code !== 'string' || typeof error.message !== 'string') {
    return undefined
  }
  const folded: RpcError = {
    code: error.code,
    message: error.message,
    details: 'details' in error ? error.details : {},
  }
  return { ok: false, error: folded }
}

function asServerResponse(value: unknown): ServerResponse | undefined {
  if (!isRecord(value)) return undefined
  if (value.type !== 'server-response' || typeof value.rpcId !== 'string') return undefined
  const result = asRpcResult<unknown>(value.result)
  if (result === undefined) return undefined
  return { type: 'server-response', rpcId: value.rpcId, result }
}

function asRpcReceipt(value: unknown): RpcReceipt | undefined {
  if (!isRecord(value) || typeof value.accepted !== 'boolean') return undefined
  if (value.accepted) return { accepted: true }
  if (value.reason === 'not-pending' || value.reason === 'bad-response') {
    return { accepted: false, reason: value.reason }
  }
  return undefined
}

function mergeSignals(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([timeout, signal])
}

export class DeckClient {
  readonly #baseUrl: string
  readonly #timeoutMs: number

  constructor(options: DeckClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * Mints the rpcId, wraps the envelope, verifies the echo, returns the result slot.
   * Business failures and transport exceptions both come back as `{ok:false}`; this
   * method does not throw.
   */
  async call<K extends RpcMethodName>(
    method: K,
    payload: RequestPayload<K>,
    signal?: AbortSignal,
  ): Promise<RpcResult<ResponseValue<K>>> {
    const rpcId = crypto.randomUUID()
    const body: ClientRequest = {
      type: 'client-request',
      rpcId,
      method,
      payload,
    }
    try {
      const response = await fetch(new URL(`${API_PATH}/${method}`, `${this.#baseUrl}/`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: mergeSignals(this.#timeoutMs, signal),
      })
      if (!response.ok) {
        return transportError(`transport failure for ${API_PATH}/${method}: HTTP ${response.status}`)
      }
      const parsed: unknown = await response.json()
      const envelope = asServerResponse(parsed)
      if (envelope === undefined) {
        return transportError(`transport failure for ${API_PATH}/${method}: malformed server-response`)
      }
      if (envelope.rpcId !== rpcId) {
        return transportError(
          `rpcId mismatch for ${method}: sent ${rpcId}, got ${envelope.rpcId}`,
        )
      }
      const result = asRpcResult<ResponseValue<K>>(envelope.result)
      if (result === undefined) {
        return transportError(`transport failure for ${API_PATH}/${method}: malformed result slot`)
      }
      return result
    } catch (error) {
      return transportError(error)
    }
  }

  /** Answers a server-request. `rpcId` MUST be the one the host sent. */
  async respond(rpcId: RpcId, value: unknown, signal?: AbortSignal): Promise<RpcReceipt> {
    const body: ClientResponse = {
      type: 'client-response',
      rpcId,
      result: { ok: true, value },
    }
    try {
      const response = await fetch(new URL(RESPOND_PATH, `${this.#baseUrl}/`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: mergeSignals(this.#timeoutMs, signal),
      })
      if (!response.ok) return { accepted: false, reason: 'bad-response' }
      const parsed: unknown = await response.json()
      return asRpcReceipt(parsed) ?? { accepted: false, reason: 'bad-response' }
    } catch {
      return { accepted: false, reason: 'bad-response' }
    }
  }
}
