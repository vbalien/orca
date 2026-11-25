// The wake gate on a bot's own Slack app: fail closed (nothing starts, nothing is posted), and the
// gate reads the message with every "this is incomplete" mark intact.
import { afterEach, expect, it, vi } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import type { SlackGateEvent } from '../../shared/bots/bot-slack-gate'
import type { SlackWakeDecision } from '../bots/slack-gate/slack-gate'
import { slackGateJevRequest } from '../bots/slack-gate/slack-gate-jev'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import { SlackLocalInbound } from './slack-local-inbound'
import { slackLocalReads } from './slack-local-reads'
import { localSlackWakeGate } from './slack-local-wake-gate'

type ThreadAnswer = { messages: { ts: string; user?: string; text: string }[]; has_more?: boolean }

const identity = { teamId: 'T1', botUserId: 'U0BOT', appId: 'A1' }
const THREAD = '1800000000.000100'
let nextEvent = 0
const envelope = (event: Record<string, unknown>) => ({
  type: 'event_callback',
  team_id: 'T1',
  api_app_id: 'A1',
  event_id: `Ev${++nextEvent}`,
  event: { type: 'app_mention', user: 'U0OWNER', channel: 'C1', ts: '1800000000.000200', ...event }
})
const passed: SlackWakeDecision = { verdict: 'wake', reason: 'passed', durationMs: 1 }
const jev = { question: 'Is this a request?', threshold: 0.5 }

function harness(
  decide: (event: SlackGateEvent) => Promise<SlackWakeDecision>,
  options: { thread?: ThreadAnswer | 'fail'; linked?: boolean } = {}
) {
  const methods: string[] = []
  const events: SlackGateEvent[] = []
  const calls: { kind: 'start' | 'send'; text: string }[] = []
  const fetch = vi.fn(async (url: string | URL | Request) => {
    const method = String(url).split('/').at(-1) ?? ''
    methods.push(method)
    if (method === 'conversations.replies') {
      const thread = options.thread ?? { messages: [] }
      return thread === 'fail'
        ? new Response('', { status: 500 })
        : Response.json({ ok: true, ...thread })
    }
    return method === 'users.info'
      ? Response.json({ ok: true, user: { name: 'owner' } })
      : Response.json({ ok: true })
  })
  const bot = {
    id: 'b1',
    name: 'Bot',
    agent: 'claude',
    members: [],
    slackConnection: { mode: 'local', teamId: 'T1', botUserId: 'U0BOT', ownerUserId: 'U0OWNER' }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the calls this path makes.
  const seam = {
    linkedChat: () => (options.linked ? { worktreeId: 'wt', sessionId: 's' } : null),
    start: async (_host: unknown, key: unknown, _id: string, input: { prompt: string }) => {
      calls.push({ kind: 'start', text: input.prompt })
      return { conversation: key, initial: { outcome: 'accepted' } }
    },
    send: async (_host: unknown, _key: unknown, _id: string, message: { text: string }) => {
      calls.push({ kind: 'send', text: message.text })
      return { outcome: 'accepted' }
    }
  } as unknown as ExternalConversationSeam
  const abort = new AbortController()
  const inbound = new SlackLocalInbound({
    identity,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test bot record with the fields the inbound path reads.
    bot: () => bot as unknown as Bot,
    seam: () => seam,
    host: () => ({}),
    reads: slackLocalReads(fetch, 'xoxb-test', abort.signal),
    wakeGate: localSlackWakeGate(async (_bot, event) => {
      events.push(event)
      return await decide(event)
    }),
    signal: abort.signal
  })
  return { inbound, methods, events, calls, abort }
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))
const own = (count: number, text = 'please deploy') =>
  Array.from({ length: count }, (_, i) => ({
    ts: `1800000000.0001${String(i + 10).padStart(2, '0')}`,
    user: 'U0OWNER',
    text: `${text} ${i}`
  }))

afterEach(() => {
  vi.useRealTimers()
})

it('starts nothing and posts nothing unless the gate truly wakes', async () => {
  const refusals: (() => Promise<SlackWakeDecision>)[] = [
    async () => ({ verdict: 'block', reason: 'blocked', durationMs: 1 }),
    async () => ({ verdict: 'wake', reason: 'cancelled', durationMs: 1 }),
    async () => ({ verdict: 'wake', reason: 'expired', durationMs: 1 }),
    async () => {
      throw new Error('gate down')
    }
  ]
  for (const refuse of refusals) {
    const h = harness(refuse)
    h.inbound.receive(envelope({ text: '<@U0BOT> deploy', thread_ts: THREAD }))
    await settled()
    expect(h.events).toHaveLength(1)
    expect(h.calls).toEqual([])
    // Only reads ever reach Slack before the gate wakes.
    expect(new Set(h.methods)).toEqual(new Set(['users.info', 'conversations.replies']))
  }
  const woken = harness(async () => passed)
  woken.inbound.receive(envelope({ text: '<@U0BOT> deploy' }))
  await settled()
  expect(woken.calls).toEqual([{ kind: 'start', text: 'deploy' }])
})

it('hands the gate the message as Slack said it', async () => {
  const h = harness(async () => passed)
  h.inbound.receive(envelope({ text: '<@U0BOT> hi' }))
  await settled()
  const [event] = h.events
  expect(event).toMatchObject({
    case: 'mention',
    teamId: 'T1',
    channelId: 'C1',
    placeKind: 'channel',
    threadTs: '1800000000.000200',
    messageTs: '1800000000.000200',
    from: { userId: 'U0OWNER', name: 'owner', role: 'owner' },
    text: 'hi',
    mentioned: true
  })
  expect(event?.eventId).toMatch(/^Ev\d+$/)
  expect(event).not.toHaveProperty('mentionUnknown')
  expect(event).not.toHaveProperty('earlierOwn')
  expect(event).not.toHaveProperty('truncated')
})

it('marks a bare mention’s earlier request incomplete or cut when it is', async () => {
  const many = harness(async () => passed, { thread: { messages: own(11) } })
  many.inbound.receive(envelope({ text: '<@U0BOT>', thread_ts: THREAD }))
  const long = harness(async () => passed, {
    thread: { messages: [{ ts: '1800000000.000150', user: 'U0OWNER', text: 'x'.repeat(5000) }] }
  })
  long.inbound.receive(envelope({ text: '<@U0BOT>', thread_ts: THREAD }))
  await settled()
  expect(many.events[0]?.earlierOwn).toMatchObject({ incomplete: true })
  expect(many.events[0]?.earlierOwn?.texts).toHaveLength(10)
  expect(long.events[0]?.truncated).toBe(true)
  expect(long.events[0]?.earlierOwn?.texts[0]).toHaveLength(4000)
})

it('says a bare mention’s earlier request is unknown when the thread wasn’t read whole', async () => {
  const unknown = { texts: [], incomplete: true }
  const partial = harness(async () => passed, { thread: { messages: own(3), has_more: true } })
  partial.inbound.receive(envelope({ text: '<@U0BOT>', thread_ts: THREAD }))
  const failed = harness(async () => passed, { thread: 'fail' })
  failed.inbound.receive(envelope({ text: '<@U0BOT>', thread_ts: THREAD }))
  // A running chat's thread is never read again: unknown too.
  const linked = harness(async () => passed, { linked: true })
  linked.inbound.receive(envelope({ text: '<@U0BOT>', thread_ts: THREAD }))
  await settled()
  expect(partial.events[0]?.earlierOwn).toEqual(unknown)
  expect(failed.events[0]?.earlierOwn).toEqual(unknown)
  expect(failed.events[0]?.context).toEqual([
    { kind: 'unreadable', text: '(this thread could not be read)' }
  ])
  expect(linked.events[0]?.earlierOwn).toEqual(unknown)
  expect(linked.methods).not.toContain('conversations.replies')
  expect(linked.calls).toEqual([{ kind: 'send', text: '(mentioned you with no message)' }])
  const event = linked.events[0]
  expect(event && slackGateJevRequest(jev, event)).toMatchObject({
    state: { earlierOwn: { texts: [], incomplete: true } }
  })
})

it('shows Jev that earlier thread messages were left out', async () => {
  const others = Array.from({ length: 21 }, (_, i) => ({
    ts: `1800000000.0001${String(i + 10).padStart(2, '0')}`,
    user: 'U0OTHER',
    text: `note ${i}`
  }))
  const h = harness(async () => passed, { thread: { messages: others } })
  h.inbound.receive(envelope({ text: '<@U0BOT> sum it up', thread_ts: THREAD }))
  await settled()
  const event = h.events[0]
  const marker = '(earlier messages in this thread are not shown)'
  expect(event?.context?.[0]).toEqual({ kind: 'more', text: marker })
  expect(event?.context).toHaveLength(21)
  const request = event && slackGateJevRequest(jev, event)
  expect(request).toMatchObject({
    state: { earlierMessages: [marker, ...others.slice(1).map((entry) => entry.text)] }
  })
})

it('drops a message whose check outlives the connection or its deadline, and goes on', async () => {
  let wake: (decision: SlackWakeDecision) => void = () => {}
  const pending = () =>
    new Promise<SlackWakeDecision>((resolve) => {
      wake = resolve
    })
  const closed = harness(pending)
  closed.inbound.receive(envelope({ text: '<@U0BOT> one' }))
  await settled()
  closed.abort.abort()
  wake(passed)
  await settled()
  expect(closed.calls).toEqual([])

  vi.useFakeTimers()
  let first = true
  const h = harness(async () => {
    if (first) {
      first = false
      return await pending()
    }
    return passed
  })
  h.inbound.receive(envelope({ text: '<@U0BOT> one', thread_ts: THREAD }))
  h.inbound.receive(envelope({ text: '<@U0BOT> two', thread_ts: THREAD, ts: '1800000000.000300' }))
  await vi.advanceTimersByTimeAsync(0)
  expect(h.events).toHaveLength(1)
  // The first check passes its deadline still undecided: the thread's next message goes on.
  await vi.advanceTimersByTimeAsync(60_001)
  expect(h.calls).toEqual([{ kind: 'start', text: 'two' }])
  wake(passed)
  await vi.advanceTimersByTimeAsync(0)
  expect(h.calls).toEqual([{ kind: 'start', text: 'two' }])
})
