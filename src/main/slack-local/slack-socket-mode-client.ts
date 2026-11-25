// Slack Socket Mode for a bot's own app: Slack's events arrive over a WebSocket this computer opens,
// so no public URL and no Orca Cloud. Each envelope is acknowledged before it is handled.
import WebSocket from 'ws'
import { openSocketModeUrl, slackFields, SlackApiError, type SlackFetch } from './slack-web-api'

const HANDSHAKE_TIMEOUT_MS = 10_000
const PING_INTERVAL_MS = 30_000
const PONG_TIMEOUT_MS = 10_000
// From opening the socket to Slack's hello; past it the connection is tried again.
const HELLO_TIMEOUT_MS = 15_000
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 60_000
// Tokens Slack won't take until they change: trying again only gets refused again.
const FATAL_CODES = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'account_inactive',
  'not_allowed_token_type',
  'missing_scope'
])

export type SocketModeState =
  | { state: 'connecting' }
  | { state: 'connected' }
  | { state: 'error'; error: string }
  | { state: 'stopped' }

/** The parts of a `ws` socket this client uses, so tests can stand in for one. */
export type SocketModeSocket = {
  on(event: 'open' | 'pong', listener: () => void): unknown
  on(event: 'message', listener: (data: WebSocket.RawData) => void): unknown
  on(event: 'close', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  send(data: string): void
  ping(): void
  terminate(): void
}

export type SocketModeClientOptions = {
  appToken: string
  /** The app the bot token belongs to: an app-level token of another app is refused at hello. */
  appId: string
  fetch: SlackFetch
  /** An events_api envelope's payload, after its ack went. */
  onEvent: (payload: unknown) => void
  onState: (state: SocketModeState) => void
  socketFactory?: (url: string) => SocketModeSocket
  random?: () => number
}

const defaultSocket = (url: string): SocketModeSocket =>
  new WebSocket(url, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS })

export class SlackSocketModeClient {
  private readonly stopped = new AbortController()
  private socket: SocketModeSocket | null = null
  private failures = 0
  private retry: ReturnType<typeof setTimeout> | null = null
  private ping: ReturnType<typeof setInterval> | null = null
  private pongDue: ReturnType<typeof setTimeout> | null = null
  private helloDue: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: SocketModeClientOptions) {}

  start(): void {
    void this.connect()
  }

  stop(): void {
    if (this.stopped.signal.aborted) {
      return
    }
    this.stopped.abort()
    this.clearTimers()
    this.socket?.terminate()
    this.socket = null
    this.options.onState({ state: 'stopped' })
  }

  private async connect(): Promise<void> {
    if (this.stopped.signal.aborted) {
      return
    }
    this.options.onState({ state: 'connecting' })
    let url: string
    try {
      url = await openSocketModeUrl(this.options.fetch, this.options.appToken, this.stopped.signal)
    } catch (error) {
      const code = error instanceof SlackApiError ? error.code : 'network'
      if (FATAL_CODES.has(code)) {
        this.fail(code)
        return
      }
      this.reconnectLater(error instanceof SlackApiError ? error.retryAfterMs : undefined)
      return
    }
    if (this.stopped.signal.aborted) {
      return
    }
    const socket = (this.options.socketFactory ?? defaultSocket)(url)
    this.socket = socket
    this.helloDue = setTimeout(() => socket.terminate(), HELLO_TIMEOUT_MS)
    this.helloDue.unref?.()
    const current = () => this.socket === socket && !this.stopped.signal.aborted
    socket.on('message', (data) => {
      if (current()) {
        this.received(socket, data)
      }
    })
    socket.on('pong', () => {
      if (this.pongDue) {
        clearTimeout(this.pongDue)
        this.pongDue = null
      }
    })
    socket.on('error', () => {
      // A close follows; reconnecting happens there.
    })
    socket.on('close', () => {
      if (current()) {
        this.socket = null
        this.clearTimers()
        this.reconnectLater()
      }
    })
  }

  private received(socket: SocketModeSocket, data: WebSocket.RawData): void {
    let message: Record<string, unknown>
    try {
      message = slackFields(JSON.parse(String(data)))
    } catch {
      return
    }
    if (message.type === 'hello') {
      if (this.helloDue) {
        clearTimeout(this.helloDue)
        this.helloDue = null
      }
      const appId = slackFields(message.connection_info).app_id
      if (typeof appId === 'string' && appId !== this.options.appId) {
        this.fail('app_mismatch')
        return
      }
      this.failures = 0
      this.keepAlive(socket)
      this.options.onState({ state: 'connected' })
      return
    }
    if (message.type === 'disconnect') {
      // Slack is moving this connection: a fresh URL, now.
      this.socket = null
      this.clearTimers()
      socket.terminate()
      void this.connect()
      return
    }
    // Every envelope is acknowledged at once, so Slack doesn't send it again while it is handled.
    if (typeof message.envelope_id === 'string') {
      socket.send(JSON.stringify({ envelope_id: message.envelope_id }))
    }
    if (message.type === 'events_api') {
      this.options.onEvent(message.payload)
    }
  }

  /** Slack won't take these tokens: stopped, saying why, until they change. */
  private fail(code: string): void {
    this.stopped.abort()
    this.clearTimers()
    this.socket?.terminate()
    this.socket = null
    this.options.onState({ state: 'error', error: code })
  }

  private keepAlive(socket: SocketModeSocket): void {
    this.clearTimers()
    this.ping = setInterval(() => {
      socket.ping()
      this.pongDue ??= setTimeout(() => socket.terminate(), PONG_TIMEOUT_MS)
    }, PING_INTERVAL_MS)
    this.ping.unref?.()
  }

  private reconnectLater(retryAfterMs?: number): void {
    if (this.stopped.signal.aborted) {
      return
    }
    const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.failures)
    this.failures += 1
    const jitter = backoff * 0.5 * (this.options.random ?? Math.random)()
    this.options.onState({ state: 'connecting' })
    this.retry = setTimeout(
      () => {
        this.retry = null
        void this.connect()
      },
      Math.max(retryAfterMs ?? 0, backoff + jitter)
    )
    this.retry.unref?.()
  }

  private clearTimers(): void {
    for (const timer of [this.retry, this.pongDue, this.helloDue]) {
      if (timer) {
        clearTimeout(timer)
      }
    }
    if (this.ping) {
      clearInterval(this.ping)
    }
    this.retry = null
    this.pongDue = null
    this.helloDue = null
    this.ping = null
  }
}

/** The app an app-level token connects as, from Socket Mode's hello; null when Slack doesn't say. */
export async function socketModeAppId(
  fetchImpl: SlackFetch,
  appToken: string,
  socketFactory: (url: string) => SocketModeSocket = defaultSocket
): Promise<string | null> {
  const url = await openSocketModeUrl(fetchImpl, appToken)
  const socket = socketFactory(url)
  try {
    return await new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new SlackApiError('hello_timeout', 'refused')),
        HELLO_TIMEOUT_MS
      )
      const settle = (run: () => void): void => {
        clearTimeout(timer)
        run()
      }
      socket.on('message', (data) => {
        let message: Record<string, unknown>
        try {
          message = slackFields(JSON.parse(String(data)))
        } catch {
          return
        }
        if (message.type === 'hello') {
          const appId = slackFields(message.connection_info).app_id
          settle(() => resolve(typeof appId === 'string' ? appId : null))
        }
      })
      socket.on('error', () => settle(() => reject(new SlackApiError('network', 'refused'))))
      socket.on('close', () => settle(() => reject(new SlackApiError('closed', 'refused'))))
    })
  } finally {
    socket.terminate()
  }
}
