// What a bot's own Slack app lets in: only mentions, DMs and replies in its own threads, only from
// people on its Who can ask, once each, and nothing the wake gate blocks.
import { expect, it } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import { readLocalSlackEvent } from './slack-local-events'
import { SlackLocalInbound, type LocalSlackWakeGate } from './slack-local-inbound'

const identity = { teamId: 'T1', botUserId: 'U0BOT', appId: 'A1' }
let nextEvent = 0
const envelope = (event: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'event_callback',
  team_id: 'T1',
  api_app_id: 'A1',
  event_id: `Ev${++nextEvent}`,
  event: { user: 'U0OWNER', channel: 'C1', ts: '1800000000.000200', ...event },
  ...extra
})

it('reads mentions, DMs and thread replies, and nothing else', () => {
  const read = (event: Record<string, unknown>, extra?: Record<string, unknown>) =>
    readLocalSlackEvent(envelope(event, extra), identity)
  expect(read({ type: 'app_mention', text: '<@U0BOT> fix the build' })).toMatchObject({
    case: 'mention',
    text: 'fix the build',
    threadTs: '1800000000.000200',
    inThread: false,
    mentioned: true
  })
  expect(
    read({ type: 'message', channel_type: 'im', channel: 'D1', text: 'hi\nthere' })
  ).toMatchObject({ case: 'dm', text: 'hi\nthere' })
  expect(
    read({ type: 'message', channel_type: 'channel', thread_ts: '1800000000.000100', text: 'ok' })
  ).toMatchObject({ case: 'thread_reply', threadTs: '1800000000.000100', inThread: true })
  // Not ours: a top-level channel message, the app's own post, another bot, an edit, a group DM,
  // another workspace or app.
  expect(read({ type: 'message', channel_type: 'channel', text: 'x' })).toBeNull()
  expect(read({ type: 'app_mention', user: 'U0BOT', text: 'x' })).toBeNull()
  expect(read({ type: 'app_mention', bot_id: 'B1', text: 'x' })).toBeNull()
  expect(read({ type: 'message', channel_type: 'im', subtype: 'message_changed' })).toBeNull()
  expect(read({ type: 'message', channel_type: 'mpim', text: 'x' })).toBeNull()
  expect(read({ type: 'app_mention', text: 'x' }, { team_id: 'T2' })).toBeNull()
  expect(read({ type: 'app_mention', text: 'x' }, { api_app_id: 'A2' })).toBeNull()
})

function harness(gate: LocalSlackWakeGate = async () => 'wake', linkedToBot: string | null = null) {
  const calls: { kind: 'start' | 'send'; text: string; role?: string }[] = []
  const admissible: (() => boolean)[] = []
  const bot: { members: unknown[] } & Record<string, unknown> = {
    id: 'b1',
    agent: 'claude',
    members: [{ id: 'U0MEMBER', name: 'm', source: 'slack-local', workspaceId: 'T1' }],
    slackConnection: { mode: 'local', teamId: 'T1', botUserId: 'U0BOT', ownerUserId: 'U0OWNER' }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the calls this path makes.
  const seam = {
    linkedChat: (_key: unknown, botId?: string) =>
      linkedToBot && (!botId || botId === linkedToBot)
        ? { worktreeId: 'wt', sessionId: 's' }
        : null,
    start: async (
      _host: unknown,
      _key: unknown,
      _id: string,
      input: { prompt: string; asker: { role: string }; admissible: () => boolean }
    ) => {
      calls.push({ kind: 'start', text: input.prompt, role: input.asker.role })
      admissible.push(input.admissible)
      return { conversation: _key, initial: { outcome: 'accepted' } }
    },
    send: async (_host: unknown, _key: unknown, _id: string, message: { text: string }) => {
      calls.push({ kind: 'send', text: message.text })
      return { outcome: 'accepted' }
    }
  } as unknown as ExternalConversationSeam
  const inbound = new SlackLocalInbound({
    identity,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test bot record with the fields the inbound path reads.
    bot: () => bot as unknown as Bot,
    seam: () => seam,
    host: () => ({}),
    reads: {
      thread: async () => ({ messages: [], complete: true }),
      userName: async () => undefined
    },
    wakeGate: gate,
    signal: new AbortController().signal
  })
  return { inbound, calls, admissible, revoke: () => (bot.members = []) }
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

it('admits only Who can ask, once per message, and nothing the gate blocks', async () => {
  const { inbound, calls } = harness()
  inbound.receive(envelope({ type: 'app_mention', text: '<@U0BOT> hello' }))
  // The same message again as a message event, and a stranger's mention: neither goes.
  inbound.receive(
    envelope({ type: 'message', channel_type: 'im', channel: 'C1', text: '<@U0BOT> hello' })
  )
  inbound.receive(
    envelope({ type: 'app_mention', user: 'U0STRANGER', ts: '1800000000.000300', text: 'hi' })
  )
  inbound.receive(
    envelope({ type: 'app_mention', user: 'U0MEMBER', ts: '1800000000.000400', text: 'yo' })
  )
  await settled()
  expect(calls).toEqual([
    { kind: 'start', text: 'hello', role: 'owner' },
    { kind: 'start', text: 'yo', role: 'member' }
  ])

  const blocked = harness(async () => 'block')
  blocked.inbound.receive(envelope({ type: 'app_mention', text: '<@U0BOT> hello' }))
  const failing = harness(async () => {
    throw new Error('gate down')
  })
  failing.inbound.receive(envelope({ type: 'app_mention', text: '<@U0BOT> hello' }))
  await settled()
  expect([...blocked.calls, ...failing.calls]).toEqual([])
})

it('continues its own thread, and leaves another bot’s or an unasked thread alone', async () => {
  const reply = {
    type: 'message',
    channel_type: 'channel',
    thread_ts: '1800000000.000100',
    text: 'more'
  }
  const own = harness(undefined, 'b1')
  own.inbound.receive(envelope(reply))
  const other = harness(undefined, 'b2')
  other.inbound.receive(envelope(reply))
  const none = harness()
  none.inbound.receive(envelope(reply))
  await settled()
  expect(own.calls).toEqual([{ kind: 'send', text: 'more' }])
  expect([...other.calls, ...none.calls]).toEqual([])
})

it('drops a request whose asker lost access while the gate decided', async () => {
  let release: (verdict: 'wake') => void = () => {}
  const h = harness(() => new Promise((resolve) => (release = resolve)))
  h.inbound.receive(envelope({ type: 'app_mention', user: 'U0MEMBER', text: '<@U0BOT> deploy' }))
  await settled()
  h.revoke()
  release('wake')
  await settled()
  expect(h.calls).toEqual([])
})

it('asks again when the chat takes it, and wakes once for a mention however its events arrive', async () => {
  const h = harness()
  h.inbound.receive(envelope({ type: 'app_mention', user: 'U0MEMBER', text: '<@U0BOT> go' }))
  await settled()
  expect(h.admissible.map((check) => check())).toEqual([true])
  h.revoke()
  expect(h.admissible.map((check) => check())).toEqual([false])

  // In its own thread, the message event and app_mention of one mention: the gate sees a mention.
  const cases: string[] = []
  const linked = harness(async (input) => {
    cases.push(input.case)
    return input.case === 'mention' ? 'wake' : 'block'
  }, 'b1')
  const thread = { channel_type: 'channel', thread_ts: '1800000000.000100', text: '<@U0BOT> again' }
  linked.inbound.receive(envelope({ type: 'message', ...thread }))
  linked.inbound.receive(envelope({ type: 'app_mention', ...thread }))
  await settled()
  expect(cases).toEqual(['mention'])
  expect(linked.calls).toEqual([{ kind: 'send', text: 'again' }])
})
