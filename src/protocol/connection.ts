import type { DeckClient } from './client.ts'
import {
  HOST_EVENTS_PATH,
  MUX_EVENTS_PATH,
  type HostDescription,
  type HostFrame,
  type MuxFrame,
  type RpcId,
  type ServerRequest,
} from './contract.ts'
import { isRecord } from './guards.ts'

export type ConnectionState = 'connecting' | 'ready' | 'reconnecting' | 'closed'

export interface ConnectionEvents {
  state(state: ConnectionState, detail?: string): void
  /** Host description captured by the handshake that opened this generation. */
  ready(host: HostDescription, generation: number): void
  mux(frame: MuxFrame, rpcId: RpcId): void
  host(frame: HostFrame, rpcId: RpcId): void
  /** Generation lost; the consumer must discard live state and refetch history. */
  lost(reason: string, generation: number): void
}

const BACKOFF_MIN_MS = 250
const BACKOFF_MAX_MS = 8_000

function isServerRequest(value: unknown): value is ServerRequest {
  return isRecord(value)
    && value.type === 'server-request'
    && typeof value.rpcId === 'string'
    && typeof value.method === 'string'
}

function hasFrameType(value: unknown): value is { type: string } {
  return isRecord(value) && typeof value.type === 'string'
}

function downlinkUrl(baseUrl: string, path: string): string {
  const url = new URL(path, `${baseUrl.replace(/\/+$/, '')}/`)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

/**
 * One connection generation: both downlinks plus `host.describe`. Either socket
 * ending kills the generation — `since` resume is unimplemented upstream, so
 * the consumer must refetch history after `lost`.
 */
export class Connection {
  readonly #client: DeckClient
  readonly #baseUrl: string
  readonly #events: Partial<ConnectionEvents>
  #state: ConnectionState = 'closed'
  #generation = 0
  /** Bumped on every start(); stale loops detect the restart and exit. */
  #epoch = 0
  #running = false
  #reconnectAttempt = 0
  #generationAbort: AbortController | null = null
  #idleAbort: AbortController | null = null
  #mux: WebSocket | null = null
  #host: WebSocket | null = null
  #announcedReady = false

  constructor(client: DeckClient, baseUrl: string, events: Partial<ConnectionEvents>) {
    this.#client = client
    this.#baseUrl = baseUrl.replace(/\/+$/, '')
    this.#events = events
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    // A loop suspended in sleep/handshake from a previous close() must not
    // resume into the restarted run; the epoch check makes it a no-op.
    this.#epoch += 1
    this.#reconnectAttempt = 0
    this.#setState('connecting')
    void this.#loop()
  }

  close(): void {
    this.#running = false
    this.#generationAbort?.abort()
    this.#idleAbort?.abort()
    this.#teardownSockets()
    this.#setState('closed')
  }

  get state(): ConnectionState {
    return this.#state
  }

  get generation(): number {
    return this.#generation
  }

  #setState(state: ConnectionState, detail?: string): void {
    const changed = this.#state !== state
    this.#state = state
    if (!changed && detail === undefined) return
    this.#safe(() => {
      if (detail === undefined) this.#events.state?.(state)
      else this.#events.state?.(state, detail)
    })
  }

  #safe(fn: () => void): void {
    try {
      fn()
    } catch (error) {
      console.error('[deck] connection event handler threw:', error)
    }
  }

  #backoffDelay(): number {
    const exp = Math.max(0, this.#reconnectAttempt - 1)
    const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * (2 ** exp))
    return cap / 2 + Math.random() * (cap / 2)
  }

  #failGeneration(reason: string): void {
    const ac = this.#generationAbort
    if (ac === null || ac.signal.aborted) return
    ac.abort(reason)
  }

  #teardownSockets(): void {
    const mux = this.#mux
    const host = this.#host
    this.#mux = null
    this.#host = null
    if (mux !== null && mux.readyState < WebSocket.CLOSING) mux.close()
    if (host !== null && host.readyState < WebSocket.CLOSING) host.close()
  }

  async #loop(): Promise<void> {
    const epoch = this.#epoch
    while (this.#running && epoch === this.#epoch) {
      const gen = ++this.#generation
      const ac = new AbortController()
      this.#generationAbort = ac
      this.#announcedReady = false
      let loseReason = 'connection lost'

      ac.signal.addEventListener('abort', () => {
        const reason = ac.signal.reason
        if (typeof reason === 'string' && reason.length > 0) loseReason = reason
        else if (reason instanceof Error) loseReason = reason.message
      }, { once: true })

      try {
        const host = await this.#handshake(gen, ac)
        if (!this.#running || epoch !== this.#epoch || ac.signal.aborted) {
          throw new Error(loseReason)
        }
        this.#reconnectAttempt = 0
        this.#announcedReady = true
        this.#setState('ready')
        this.#safe(() => this.#events.ready?.(host, gen))
        await whenAborted(ac.signal)
        if (!this.#running || epoch !== this.#epoch) return
        this.#safe(() => this.#events.lost?.(loseReason, gen))
      } catch (error) {
        // Carry the real error so the abort listener keeps its message
        // instead of a generic "operation aborted" reason.
        if (!ac.signal.aborted) ac.abort(error)
        if (this.#announcedReady && this.#running && epoch === this.#epoch) {
          const message = error instanceof Error ? error.message : String(error)
          this.#safe(() => this.#events.lost?.(message, gen))
        }
      } finally {
        // A restarted run already owns fresh sockets; tearing them down or
        // clobbering its abort controller here would leak the new generation.
        if (epoch === this.#epoch) {
          this.#teardownSockets()
          this.#generationAbort = null
        }
      }

      if (!this.#running || epoch !== this.#epoch) return
      this.#setState('reconnecting', loseReason)
      this.#reconnectAttempt += 1
      const idle = new AbortController()
      this.#idleAbort = idle
      await sleep(this.#backoffDelay(), idle.signal)
      if (epoch === this.#epoch) this.#idleAbort = null
    }
  }

  /**
   * Readiness is conjunctive: both sockets OPEN and `host.describe` ok.
   * Sockets start pumping immediately — baseline `session/subscribed` frames
   * can arrive during the unary handshake and must not be dropped.
   */
  async #handshake(gen: number, ac: AbortController): Promise<HostDescription> {
    const muxUrl = downlinkUrl(this.#baseUrl, MUX_EVENTS_PATH)
    const hostUrl = downlinkUrl(this.#baseUrl, HOST_EVENTS_PATH)
    const describeP = this.#client.call('host.describe', {}, ac.signal)
    const muxP = this.#openSocket(muxUrl, 'mux', gen, ac)
    const hostP = this.#openSocket(hostUrl, 'host', gen, ac)
    const [describe, mux, host] = await Promise.all([describeP, muxP, hostP])
    if (ac.signal.aborted) throw new Error('generation aborted during readiness handshake')
    if (!describe.ok) {
      throw new Error(`host.describe failed: ${describe.error.code}: ${describe.error.message}`)
    }
    if (mux.readyState !== WebSocket.OPEN || host.readyState !== WebSocket.OPEN) {
      throw new Error('socket closed during handshake')
    }
    return describe.value
  }

  #openSocket(
    url: string,
    kind: 'mux' | 'host',
    gen: number,
    ac: AbortController,
  ): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      let settled = false
      let opened = false
      const socket = new WebSocket(url)
      if (kind === 'mux') this.#mux = socket
      else this.#host = socket

      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        ac.signal.removeEventListener('abort', onAbort)
        if (error !== undefined) reject(error)
        else resolve(socket)
      }

      const onAbort = (): void => {
        if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
          socket.close()
        }
        finish(new Error(`${kind} aborted`))
      }

      socket.addEventListener('open', () => {
        opened = true
        finish()
      })
      socket.addEventListener('message', (event) => {
        this.#onMessage(kind, event, gen)
      })
      socket.addEventListener('close', () => {
        if (!opened) {
          finish(new Error(`${kind} closed before open`))
          return
        }
        if (gen === this.#generation) this.#failGeneration(`${kind} socket closed`)
      })
      socket.addEventListener('error', () => {
        if (!opened) finish(new Error(`${kind} socket error`))
      })

      if (ac.signal.aborted) {
        onAbort()
        return
      }
      ac.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  #onMessage(kind: 'mux' | 'host', event: MessageEvent, gen: number): void {
    if (gen !== this.#generation) return
    try {
      if (typeof event.data !== 'string') {
        console.error(`[deck] dropping non-text WebSocket frame on ${kind}`)
        return
      }
      const parsed: unknown = JSON.parse(event.data)
      if (!isServerRequest(parsed)) {
        console.error(`[deck] dropping malformed envelope on ${kind}:`, parsed)
        return
      }
      if (!hasFrameType(parsed.payload)) {
        console.error(`[deck] dropping malformed frame on ${kind}:`, parsed.payload)
        return
      }
      const frame = parsed.payload
      if (frame.type === 'stream/error') {
        this.#failGeneration(`${kind} stream/error`)
        return
      }
      if (kind === 'mux') this.#safe(() => this.#events.mux?.(frame as MuxFrame, parsed.rpcId))
      else this.#safe(() => this.#events.host?.(frame as HostFrame, parsed.rpcId))
    } catch (error) {
      console.error(`[deck] dropping malformed WebSocket frame on ${kind}:`, error)
    }
  }
}
