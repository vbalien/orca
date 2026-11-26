// Channel messages on a bot's own Slack app: taken only in the channels its gate checks them in, before
// any read or check; a thread the bot never joined stays a channel-message thread (its own `:c` chat)
// until the bot posts there or is mentioned there; a busy channel never pushes out a mention; and a
// limited rule's count is kept only when the chat took the message.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import type { BotSlackGate } from '../../shared/bots/bot-slack-gate'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import { useBotStateRoot } from '../bots/slack-gate/bot-state-file'
import { SlackGateWakeCounts } from '../bots/slack-gate/slack-gate-wake-counts'
import { SlackLocalInbound } from './slack-local-inbound'
import { SlackLocalParticipation } from './slack-local-participation'
import { SlackLocalReplies } from './slack-local-replies'
import type { ConversationEvent } from '../external-conversations/external-conversation-events'
import type { LocalSlackWakeGate } from './slack-local-wake-gate'

// ast-grep-ignore: test-no-wall-clock -- the participation and wake-count files these harnesses use run on the real clock.
const wallNow = () => Date.now()

const identity = { teamId: 'T1', botUserId: 'U0BOT', appId: 'A1' }
let nextEvent = 0
const message = (event: Record<string, unknown>) => ({
  type: 'event_callback',
  team_id: 'T1',
  api_app_id: 'A1',
  event_id: `Ev${++nextEvent}`,
  event: {
    type: 'message',
    channel_type: 'channel',
    user: 'U0OWNER',
    channel: 'C1',
    ts: `1800000000.${String(100 + nextEvent).padStart(6, '0')}`,
    text: 'anyone know where the notes are?',
    ...event
  }
})
const gate: BotSlackGate = {
  on: true,
  kind: 'command',
  command: 'check',
  appliesTo: ['thread_reply'],
  channelMessages: { channels: ['C1'] },
  timeoutSeconds: 5,
  onError: 'wake'
}
// ast-grep-ignore: test-no-real-time-wait -- the bot state files go through real fs (a temp dir); a short wait lets the write queue land.
const settled = () => new Promise((resolve) => setTimeout(resolve, 5))

beforeEach(() => useBotStateRoot(mkdtempSync(join(tmpdir(), 'inbound-channel-'))))
afterEach(() => useBotStateRoot(null))

function harness(
  options: {
    links?: string[]
    gate?: LocalSlackWakeGate
    outcome?: string
    now?: () => number
    /** Runs after the chat admitted the message, before it answers. */
    afterAdmit?: () => void
    limitsClosed?: boolean
    /** A send answers only once this settles. */
    sendWaits?: Promise<void>
  } = {}
) {
  const links = new Set(options.links ?? [])
  const calls: { kind: 'start' | 'send'; key: string; note?: string }[] = []
  const decided: string[] = []
  const reads: string[] = []
  const bot = {
    id: 'b1',
    agent: 'claude',
    members: [],
    slackConnection: { mode: 'local', teamId: 'T1', botUserId: 'U0BOT', ownerUserId: 'U0OWNER' },
    slackGate: gate
  }
  const admit = (input: { admissible: () => boolean }) => input.admissible()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the calls this path makes.
  const seam = {
    linkedChat: (key: { externalId: string }) =>
      links.has(key.externalId) ? { worktreeId: 'wt', sessionId: 's' } : null,
    goneChats: { release: (key: { externalId: string }) => links.delete(key.externalId) },
    start: async (
      _h: unknown,
      key: { externalId: string },
      _id: string,
      input: { note?: string; admissible: () => boolean }
    ) => {
      calls.push({
        kind: 'start',
        key: key.externalId,
        ...(input.note ? { note: input.note } : {})
      })
      admit(input)
      options.afterAdmit?.()
      links.add(key.externalId)
      return { conversation: key, initial: { outcome: options.outcome ?? 'accepted' } }
    },
    send: async (
      _h: unknown,
      key: { externalId: string },
      _id: string,
      input: { note?: string; admissible: () => boolean }
    ) => {
      calls.push({ kind: 'send', key: key.externalId, ...(input.note ? { note: input.note } : {}) })
      admit(input)
      await options.sendWaits
      return { outcome: options.outcome ?? 'accepted' }
    }
  } as unknown as ExternalConversationSeam
  const participation = new SlackLocalParticipation('b1', (id) => links.has(id))
  const inbound = new SlackLocalInbound({
    identity,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test bot record with the fields the inbound path reads.
    bot: () => bot as unknown as Bot,
    seam: () => seam,
    host: () => ({}),
    reads: {
      thread: async (_channel, threadTs) => {
        reads.push(threadTs)
        return { messages: [], complete: true }
      },
      userName: async () => {
        reads.push('name')
        return undefined
      }
    },
    wakeGate:
      options.gate ??
      (async (_bot, event) => {
        decided.push(event.case)
        return { verdict: 'wake' }
      }),
    signal: new AbortController().signal,
    participation,
    ...(options.now ? { now: options.now } : {}),
    limitsClosed: async () => options.limitsClosed ?? false
  })
  return { inbound, calls, decided, reads, links, participation, bot }
}

it('takes a channel message only where the gate checks them: elsewhere it reads and checks nothing', async () => {
  const h = harness()
  h.inbound.receive(message({ channel: 'C9' }))
  h.inbound.receive(message({ user: 'U0STRANGER' }))
  h.inbound.receive(message({ text: '' }))
  await settled()
  expect([h.calls, h.decided, h.reads]).toEqual([[], [], []])
  h.inbound.receive(message({}))
  await settled()
  expect(h.decided).toEqual(['channel_message'])
  expect(h.calls).toHaveLength(1)
  // It opens a chat of its own kind in the message's own thread, told it wasn't asked.
  expect(h.calls[0]!.key).toMatch(/^T1:C1:1800000000\.\d+:U0BOT:c$/)
  expect(h.calls[0]!.note).toContain('NO_REPLY')
  // Its gate off: nothing more is taken.
  h.bot.slackGate = { ...gate, on: false }
  h.inbound.receive(message({ ts: '1800000001.000100' }))
  await settled()
  expect(h.decided).toEqual(['channel_message'])
})

it('keeps a thread the bot never joined a channel-message thread, until it posts or is mentioned there', async () => {
  const root = '1800000000.000050'
  const chat = `T1:C1:${root}:U0BOT:c`
  const h = harness({ links: [chat] })
  h.inbound.receive(message({ thread_ts: root, text: 'more chatter' }))
  await settled()
  expect(h.decided).toEqual(['channel_message'])
  expect(h.calls).toEqual([expect.objectContaining({ kind: 'send', key: chat })])
  // A mention there joins it: the next reply is a reply in the bot's thread.
  h.inbound.receive(message({ thread_ts: root, text: '<@U0BOT> please look' }))
  await settled()
  h.inbound.receive(message({ thread_ts: root, text: 'and this too' }))
  await settled()
  expect(h.decided).toEqual(['channel_message', 'mention', 'thread_reply'])
  // Channel messages off for that channel now: a joined thread's replies still go on.
  h.bot.slackGate = { ...gate, channelMessages: { channels: ['C2'] } }
  h.inbound.receive(message({ thread_ts: root, text: 'one more' }))
  await settled()
  expect(h.calls.at(-1)).toMatchObject({ kind: 'send', key: chat })
  // A reply in a thread the bot has no chat in is a channel message too (it never joined it).
  const other = harness()
  other.inbound.receive(message({ thread_ts: '1800000000.000060', text: 'unrelated' }))
  await settled()
  expect(other.decided).toEqual(['channel_message'])
})

it('keeps the ordinary chat when a thread has both, and lets the channel-message one go', async () => {
  const root = '1800000000.000070'
  const h = harness({ links: [`T1:C1:${root}:U0BOT`, `T1:C1:${root}:U0BOT:c`] })
  h.inbound.receive(message({ thread_ts: root, text: 'go on' }))
  await settled()
  expect(h.calls).toEqual([{ kind: 'send', key: `T1:C1:${root}:U0BOT` }])
  expect(h.links.has(`T1:C1:${root}:U0BOT:c`)).toBe(false)
})

it('never lets a burst of channel messages push out a mention or its follow-up replies', async () => {
  let release: () => void = () => {}
  const hold = new Promise<void>((resolve) => (release = resolve))
  const seen: string[] = []
  const h = harness({
    gate: async (_bot, event) => {
      seen.push(event.case)
      if (event.case === 'channel_message') {
        await hold
      }
      return { verdict: event.case === 'channel_message' ? 'block' : 'wake' }
    }
  })
  for (let i = 0; i < 40; i++) {
    h.inbound.receive(message({ ts: `1800000002.${String(100 + i).padStart(6, '0')}` }))
  }
  h.inbound.receive(message({ type: 'app_mention', ts: '1800000003.000100', text: '<@U0BOT> hi' }))
  await settled()
  // At most 20 channel messages wait (the rest are dropped); the mention went through at once.
  expect(seen.filter((entry) => entry === 'mention')).toHaveLength(1)
  release()
  await settled()
  expect(seen.filter((entry) => entry === 'channel_message').length).toBeLessThanOrEqual(20)
})

it('keeps a limited rule’s count only when the chat took the message', async () => {
  const counts = new SlackGateWakeCounts({ now: Date.now, warn: () => {} })
  const loaded = await counts.load('b1', 0)
  const withCount = (): LocalSlackWakeGate => async () => {
    const reservation = counts.reserve(loaded, {
      channelId: 'C1',
      question: 'banter',
      at: wallNow()
    })!
    await reservation.persisted
    return {
      verdict: 'wake',
      reservation,
      wakeReason: { text: 'banter: join briefly', from: 'rules' }
    }
  }
  const refused = harness({ gate: withCount(), outcome: 'refused' })
  refused.inbound.receive(message({}))
  await settled()
  expect(counts.open(loaded, 'C1', 'banter', { perDay: 1 }, wallNow())).toBe(true)
  const taken = harness({ gate: withCount() })
  taken.inbound.receive(message({}))
  await settled()
  expect(taken.calls[0]!.note).toContain('banter: join briefly')
  expect(counts.open(loaded, 'C1', 'banter', { perDay: 1 }, wallNow())).toBe(false)
})

it('counts a limited wake on the day the chat took it, however late its answer comes', async () => {
  const counts = new SlackGateWakeCounts({ now: Date.now, warn: () => {} })
  const loaded = await counts.load('b1', 0)
  // The chat takes it a second before local midnight and answers after.
  let clock = new Date(2026, 10, 26, 23, 59, 59).getTime()
  const nextDay = new Date(2026, 10, 27, 0, 0, 1).getTime()
  const gate: LocalSlackWakeGate = async () => {
    const reservation = counts.reserve(loaded, { channelId: 'C1', question: 'banter', at: clock })!
    await reservation.persisted
    return { verdict: 'wake', reservation }
  }
  const late = harness({ gate, now: () => clock, afterAdmit: () => (clock = nextDay) })
  late.inbound.receive(message({}))
  await settled()
  expect(late.calls).toHaveLength(1)
  expect(counts.open(loaded, 'C1', 'banter', { perDay: 1 }, nextDay)).toBe(true)
  expect(counts.open(loaded, 'C1', 'banter', { perDay: 1 }, nextDay - 3000)).toBe(false)
})

it('reads and asks nothing when the gate’s limits already rule the message out', async () => {
  const closed = harness({ limitsClosed: true })
  closed.inbound.receive(message({}))
  await settled()
  expect(closed.reads).toEqual([])
  expect(closed.decided).toEqual([])
  expect(closed.calls).toEqual([])
})

it('holds "needs an answer in Orca" while an @mention into a thread the bot never joined is on its way', async () => {
  const thread = '1800000000.000001'
  const quiet = `T1:C1:${thread}:U0BOT:c`
  for (const [outcome, posts] of [
    ['accepted', 1],
    ['refused', 0]
  ] as const) {
    // Each its own bot state: the first run's join is not the second's.
    useBotStateRoot(mkdtempSync(join(tmpdir(), 'inbound-mention-')))
    let answer: () => void = () => {}
    const h = harness({
      links: [quiet],
      outcome,
      sendWaits: new Promise<void>((resolve) => (answer = resolve))
    })
    const posted: string[] = []
    const replies = new SlackLocalReplies({
      fetch: async (_url, init) => {
        posted.push(new URLSearchParams(String(init?.body)).get('markdown_text') ?? '')
        return Response.json({ ok: true })
      },
      current: async () => ({
        botToken: 'xoxb-test',
        identity: { teamId: 'T1', botUserId: 'U0BOT' }
      }),
      hostName: () => 'host',
      signal: new AbortController().signal,
      onError: () => {},
      participation: h.participation,
      canPost: () => true
    })
    h.inbound.receive(
      message({ type: 'app_mention', text: '<@U0BOT> are you there?', thread_ts: thread })
    )
    await settled()
    expect(h.calls).toMatchObject([{ kind: 'send', key: quiet }])
    // The chat asks for an answer in Orca while the mention is still being taken.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fields the replies read of a prompt.
    replies.observe({
      kind: 'prompt',
      conversation: { source: 'slack-local', externalId: quiet },
      worktreeId: 'wt',
      paneKey: 'p',
      prompt: { promptId: 'p1' },
      answered: false
    } as unknown as ConversationEvent)
    await settled()
    expect(posted).toEqual([])
    answer()
    await vi.waitFor(() => expect(posted).toHaveLength(posts))
    await settled()
    expect(posted).toHaveLength(posts)
  }
})
