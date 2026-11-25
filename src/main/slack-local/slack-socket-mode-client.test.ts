// Socket Mode: every envelope is acknowledged before it is handled, Slack's disconnect gets a fresh
// connection, a lost one comes back, and refused tokens stop it until they change.
import { afterEach, expect, it, vi } from 'vitest'
import {
  SlackSocketModeClient,
  type SocketModeSocket,
  type SocketModeState
} from './slack-socket-mode-client'

afterEach(() => vi.useRealTimers())

type FakeSocket = SocketModeSocket & {
  url: string
  sent: string[]
  emit: (event: string, data?: unknown) => void
  terminated: boolean
}

function harness(
  open: () => Response = () => Response.json({ ok: true, url: 'wss://slack.test/1' })
) {
  const sockets: FakeSocket[] = []
  const states: SocketModeState['state'][] = []
  const order: string[] = []
  const client = new SlackSocketModeClient({
    appToken: 'xapp-test',
    appId: 'A1',
    fetch: async () => open(),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test payload is the object it built.
    onEvent: (payload) => order.push(`event:${(payload as { id: string }).id}`),
    onState: (state) => states.push(state.state),
    random: () => 0,
    socketFactory: (url) => {
      const listeners = new Map<string, ((data?: unknown) => void)[]>()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test socket is the object it built.
      const socket: FakeSocket = {
        url,
        sent: [],
        terminated: false,
        on: (event: string, listener: (data?: unknown) => void) => {
          listeners.set(event, [...(listeners.get(event) ?? []), listener])
          return socket
        },
        send: (data) => {
          socket.sent.push(data)
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the ack body is JSON this client wrote.
          order.push(`ack:${(JSON.parse(data) as { envelope_id: string }).envelope_id}`)
        },
        ping: () => {},
        terminate: () => {
          socket.terminated = true
        },
        emit: (event, data) => listeners.get(event)?.forEach((listener) => listener(data))
      } as FakeSocket
      sockets.push(socket)
      return socket
    }
  })
  return { client, sockets, states, order }
}

const message = (body: unknown) => Buffer.from(JSON.stringify(body))

it('acknowledges before handling, reconnects on disconnect and on a lost socket', async () => {
  vi.useFakeTimers()
  const h = harness()
  h.client.start()
  await vi.advanceTimersByTimeAsync(0)
  const first = h.sockets[0]!
  first.emit('message', message({ type: 'hello' }))
  first.emit('message', message({ type: 'events_api', envelope_id: 'e1', payload: { id: 'p1' } }))
  expect(h.order).toEqual(['ack:e1', 'event:p1'])
  expect(h.states.at(-1)).toBe('connected')
  // Slack moves the connection: a new one at once, the old one let go.
  first.emit('message', message({ type: 'disconnect', reason: 'refresh_requested' }))
  await vi.advanceTimersByTimeAsync(0)
  expect(first.terminated).toBe(true)
  expect(h.sockets).toHaveLength(2)
  // A lost socket comes back after a backoff; the old one's late events go nowhere.
  h.sockets[1]!.emit('close')
  first.emit('message', message({ type: 'events_api', envelope_id: 'e2', payload: { id: 'p2' } }))
  await vi.advanceTimersByTimeAsync(1_000)
  expect(h.sockets).toHaveLength(3)
  expect(h.order).toEqual(['ack:e1', 'event:p1'])
  h.client.stop()
  expect(h.states.at(-1)).toBe('stopped')
})

it('refuses an app-level token of another app at hello', async () => {
  vi.useFakeTimers()
  const h = harness()
  h.client.start()
  await vi.advanceTimersByTimeAsync(0)
  h.sockets[0]!.emit('message', message({ type: 'hello', connection_info: { app_id: 'A2' } }))
  await vi.advanceTimersByTimeAsync(120_000)
  expect(h.sockets).toHaveLength(1)
  expect(h.sockets[0]!.terminated).toBe(true)
  expect(h.states.at(-1)).toBe('error')
})

it('stops trying once Slack refuses the app token', async () => {
  vi.useFakeTimers()
  const h = harness(() => Response.json({ ok: false, error: 'invalid_auth' }))
  h.client.start()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(h.sockets).toHaveLength(0)
  expect(h.states.at(-1)).toBe('error')
})
