// The wake gate on a bot's own Slack app: fail closed (nothing starts, nothing is posted), and the
// gate reads the message with every "this is incomplete" mark intact.
import { afterEach, expect, it, vi } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import type { SlackGateEvent } from '../../shared/bots/bot-slack-gate'
import type { SlackWakeDecision } from '../bots/slack-gate/slack-gate'
import type { BotSlackGate } from '../../shared/bots/bot-slack-gate'
import { slackGateOpenAIRequest } from '../../shared/bots/slack-gate-openai-request'
import { SLACK_GATE_DEFAULT_RULES } from '../../shared/bots/slack-gate-default-rules'
import type { SlackGateRulesConfig } from '../../shared/bots/slack-gate-rules-config'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import { SlackLocalInbound } from './slack-local-inbound'
import { slackLocalReads } from './slack-local-reads'
import { localSlackWakeGate } from './slack-local-wake-gate'
import { SlackGateDecider } from '../bots/slack-gate/slack-gate'
import { askSlackGateOpenAI } from '../bots/slack-gate/slack-gate-openai'
import { GATE_CONTEXT_BUDGET_MS } from './slack-local-gate-context'

type ThreadAnswer = {
  messages: { ts: string; user?: string; bot_id?: string; text: string }[]
  has_more?: boolean
  response_metadata?: { next_cursor: string }
}

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
const everything: SlackGateRulesConfig = {
  questions: [{ type: 'predicate', name: 'asks', instructions: 'Is this a request?' }],
  send: { message: true, earlierMessages: true, earlierOwn: true },
  rules: [{ question: 'asks', wakeIf: { atLeast: 0.5 } }]
}
const sent = (event: SlackGateEvent | undefined) =>
  event
    ? slackGateOpenAIRequest(everything, { name: 'Bot' }, event)?.input[1].content[0].data
    : null

function harness(
  decide: (event: SlackGateEvent) => Promise<SlackWakeDecision>,
  options: {
    thread?: ThreadAnswer | 'fail'
    linked?: boolean
    slackGate?: BotSlackGate
    /** conversations.replies by its `cursor` ('' for the first page), or a held or failing answer. */
    replies?: (cursor: string) => Promise<Response>
  } = {}
) {
  const repliesBodies: URLSearchParams[] = []
  const methods: string[] = []
  const events: SlackGateEvent[] = []
  const calls: { kind: 'start' | 'send'; text: string }[] = []
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').at(-1) ?? ''
    methods.push(method)
    if (method === 'conversations.replies' && options.replies) {
      const body = new URLSearchParams(String(init?.body))
      repliesBodies.push(body)
      return await options.replies(body.get('cursor') ?? '')
    }
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
    slackConnection: { mode: 'local', teamId: 'T1', botUserId: 'U0BOT', ownerUserId: 'U0OWNER' },
    ...(options.slackGate ? { slackGate: options.slackGate } : {})
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
  return { inbound, methods, events, calls, abort, repliesBodies }
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
  expect(sent(linked.events[0])).toMatchObject({ earlierOwn: { texts: [], incomplete: true } })
})

it('shows the gate that earlier thread messages were left out', async () => {
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
  expect(sent(event)).toMatchObject({
    earlierMessages: [marker, ...others.slice(1).map((entry) => entry.text)]
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

const openaiGate = (openai: SlackGateRulesConfig = SLACK_GATE_DEFAULT_RULES): BotSlackGate => ({
  on: true,
  kind: 'openai',
  appliesTo: ['thread_reply'],
  timeoutSeconds: 10,
  onError: 'wake',
  openai
})
const reply = (text: string, ts = '1800000000.000900') =>
  envelope({ type: 'message', channel_type: 'channel', thread_ts: THREAD, ts, text })

it('runs the default OpenAI gate on a reply in a running chat, with the thread read for it alone', async () => {
  const bodies: { input: { content: { data: Record<string, unknown> }[] }[] }[] = []
  let probability = 0.1
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return Response.json({ answers: [{ type: 'predicate', name: 'for_the_bot', probability }] })
  })
  const decider = new SlackGateDecider({
    readKey: async () => 'k1',
    now: Date.now,
    askOpenAI: (input) => askSlackGateOpenAI({ ...input, fetch }),
    runCommand: () => {
      throw new Error('unused')
    }
  })
  const slackGate = openaiGate()
  const thread: ThreadAnswer = {
    messages: [
      { ts: THREAD, user: 'U0OWNER', text: '<@U0BOT> can you check the deploy?' },
      { ts: '1800000000.000300', user: 'U0BOT', bot_id: 'B0BOT', text: 'It failed. Roll back?' },
      { ts: '1800000000.000400', user: 'U0CI', bot_id: 'B0CI', text: 'build 12 failed' },
      { ts: '1800000000.000500', user: 'U0OTHER', text: 'ugh' }
    ]
  }
  const h = harness((event) => decider.decide({ id: 'b1', name: 'Bot', slackGate }, event), {
    linked: true,
    slackGate,
    replies: async () => Response.json({ ok: true, ...thread })
  })
  // People talking among themselves: blocked, nothing posted.
  h.inbound.receive(reply('lol same'))
  await vi.waitFor(() => expect(h.events).toHaveLength(1))
  await settled()
  expect(h.calls).toEqual([])
  expect(bodies[0]?.input[1]?.content[0]?.data).toEqual({
    message: 'lol same',
    earlierMessages: [
      { from: 'person', text: '<@U0BOT> can you check the deploy?' },
      { from: 'this_bot', text: 'It failed. Roll back?' },
      { from: 'app', text: 'build 12 failed' },
      { from: 'person', text: 'ugh' }
    ],
    mentioned: false,
    fromRole: 'owner',
    botName: 'Bot'
  })
  // Read with `latest` set to the reply, for the gate only: the chat gets the reply alone.
  expect(h.repliesBodies[0]?.get('latest')).toBe('1800000000.000900')
  probability = 0.9
  h.inbound.receive(reply('yes, roll back', '1800000000.000950'))
  await vi.waitFor(() => expect(h.calls).toEqual([{ kind: 'send', text: 'yes, roll back' }]))
  // A mention in the running chat wakes without a check or a read.
  h.inbound.receive(reply('<@U0BOT> status?', '1800000000.000990'))
  await vi.waitFor(() => expect(h.calls).toHaveLength(2))
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(h.repliesBodies).toHaveLength(2)
})

it('reads a long thread by pages and never passes off its oldest messages as the latest', async () => {
  const page = (from: number, count: number, cursor?: string): Response =>
    Response.json({
      ok: true,
      messages: Array.from({ length: count }, (_, i) => ({
        ts: `1800000000.${String(from + i).padStart(6, '0')}`,
        user: 'U0OTHER',
        text: `m${from + i}`
      })),
      ...(cursor ? { has_more: true, response_metadata: { next_cursor: cursor } } : {})
    })
  const slackGate = openaiGate()
  const long = harness(async () => passed, {
    linked: true,
    slackGate,
    replies: async (cursor) => (cursor === '' ? page(200, 200, 'p2') : page(400, 50))
  })
  long.inbound.receive(reply('ok', '1800000000.001000'))
  await vi.waitFor(() => expect(long.events).toHaveLength(1))
  const context = long.events[0]?.context ?? []
  expect(context[0]).toEqual({
    kind: 'more',
    text: '(earlier messages in this thread are not shown)'
  })
  expect(context.slice(1).map((entry) => entry.text)).toEqual(
    Array.from({ length: 10 }, (_, i) => `m${440 + i}`)
  )
  const endless = harness(async () => passed, {
    linked: true,
    slackGate,
    replies: async (cursor) => page(cursor === '' ? 100 : 300, 200, `${cursor}x`)
  })
  endless.inbound.receive(reply('ok', '1800000000.001000'))
  await vi.waitFor(() => expect(endless.events).toHaveLength(1))
  expect(endless.repliesBodies).toHaveLength(3)
  expect(endless.events[0]?.context).toEqual([
    { kind: 'unreadable', text: '(this thread could not be read)' }
  ])
  expect(endless.events[0]?.contextIncomplete).toBe('unreadable')
})

it('keeps the newest earlier message whole when long ones fill the text budget', async () => {
  const slackGate = openaiGate({
    ...SLACK_GATE_DEFAULT_RULES,
    send: { message: true, earlierMessages: 20, earlierSpeakers: true }
  })
  const messages = [
    ...Array.from({ length: 19 }, (_, i) => ({
      ts: `1800000000.0003${String(i + 10).padStart(2, '0')}`,
      user: 'U0OTHER',
      text: 'x'.repeat(4000)
    })),
    { ts: '1800000000.000800', user: 'U0BOT', text: 'Roll back?' }
  ]
  const h = harness(async () => passed, {
    linked: true,
    slackGate,
    replies: async () => Response.json({ ok: true, messages })
  })
  h.inbound.receive(reply('yes'))
  await vi.waitFor(() => expect(h.events).toHaveLength(1))
  expect(h.events[0]?.context?.at(-1)).toEqual({ kind: 'self', text: 'Roll back?' })
})

it('bounds the read for the gate: a slow Slack, a rate limit and too many at once read as unreadable', async () => {
  vi.useFakeTimers()
  const unreadable = [{ kind: 'unreadable', text: '(this thread could not be read)' }]
  const slackGate = openaiGate()
  let answer: (cursor: string) => Promise<Response> = () => new Promise(() => {})
  const h = harness(async () => passed, { linked: true, slackGate, replies: (c) => answer(c) })
  h.inbound.receive(reply('one', '1800000000.000901'))
  await vi.advanceTimersByTimeAsync(GATE_CONTEXT_BUDGET_MS + 10)
  expect(h.events[0]?.context).toEqual(unreadable)
  // Slack asks to wait 30 s: that reply and the next ones within it skip the read.
  answer = async () => new Response('', { status: 429, headers: { 'retry-after': '30' } })
  h.inbound.receive(reply('two', '1800000000.000902'))
  await vi.advanceTimersByTimeAsync(10)
  h.inbound.receive(reply('three', '1800000000.000903'))
  await vi.advanceTimersByTimeAsync(10)
  expect(h.events.slice(1).map((event) => event.context)).toEqual([unreadable, unreadable])
  expect(h.repliesBodies).toHaveLength(2)
  // Three threads at once: two read, the third goes on without.
  await vi.advanceTimersByTimeAsync(31_000)
  answer = () => new Promise(() => {})
  for (const [i, thread] of [
    '1800000000.000110',
    '1800000000.000120',
    '1800000000.000130'
  ].entries()) {
    h.inbound.receive(
      envelope({
        type: 'message',
        channel_type: 'channel',
        thread_ts: thread,
        ts: `1800000000.00100${i}`,
        text: 'hi'
      })
    )
  }
  await vi.advanceTimersByTimeAsync(10)
  expect(h.events).toHaveLength(4)
  expect(h.events[3]?.context).toEqual(unreadable)
  expect(h.repliesBodies).toHaveLength(4)
  await vi.advanceTimersByTimeAsync(GATE_CONTEXT_BUDGET_MS + 10)
  expect(h.events).toHaveLength(6)
})
