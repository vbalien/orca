// A chat a channel message opened (`:c`) leaves no trace in Slack until the bot joins its thread: its
// failure line and "needs an answer in Orca" stay in Orca (one an @mention on its way decides waits
// for it), its answer joins the thread, and a chat that is no longer the thread's posts nothing more.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ConversationEvent } from '../external-conversations/external-conversation-events'
import { useBotStateRoot } from '../bots/slack-gate/bot-state-file'
import { SlackLocalParticipation } from './slack-local-participation'
import { SlackLocalReplies } from './slack-local-replies'

const chat = { source: 'slack-local' as const, externalId: 'T1:C1:1800000000.000100:U0BOT:c' }
const ended = (
  fields: Partial<Extract<ConversationEvent, { kind: 'turn-ended' }>>,
  turnId: number
): ConversationEvent => ({
  kind: 'turn-ended',
  conversation: chat,
  worktreeId: 'wt',
  paneKey: 'p',
  turnId,
  stopReason: 'success',
  at: 9,
  origin: 'delivery',
  ...fields
})
const prompt = (promptId: string): ConversationEvent =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture: only the fields the replies read are set.
  ({
    kind: 'prompt',
    conversation: chat,
    prompt: { promptId },
    answered: false
  }) as unknown as ConversationEvent
// ast-grep-ignore: test-no-real-time-wait -- the bot state files go through real fs (a temp dir); a short wait lets the write queue land.
const settled = () => new Promise((resolve) => setTimeout(resolve, 5))

beforeEach(() => useBotStateRoot(mkdtempSync(join(tmpdir(), 'replies-channel-'))))
afterEach(() => useBotStateRoot(null))

let bots = 0
function harness(canPost: () => boolean = () => true) {
  const posted: string[] = []
  const participation = new SlackLocalParticipation(`b${++bots}`, () => true)
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
    participation,
    canPost
  })
  return { replies, posted, participation }
}

it('keeps failure lines and prompts off Slack until the bot joins the thread, and joins it by answering', async () => {
  const h = harness()
  h.replies.observe(ended({ stopReason: 'failure' }, 1))
  h.replies.observe(prompt('p1'))
  // A quiet end (NO_REPLY) carries no words: nothing either.
  h.replies.observe(ended({}, 2))
  await settled()
  expect(h.posted).toEqual([])
  h.replies.observe(ended({ lastAssistantMessage: 'Here is the answer.' }, 3))
  await settled()
  expect(h.posted).toEqual(['Here is the answer.'])
  expect(h.participation.has(chat.externalId)).toBe(true)
  h.replies.observe(prompt('p2'))
  await settled()
  expect(h.posted).toHaveLength(2)
})

it('holds a prompt that comes while an @mention is on its way, and posts it once the mention is taken', async () => {
  const taken = harness()
  const end = taken.participation.mentionStarted(chat.externalId)
  taken.replies.observe(prompt('p1'))
  await settled()
  expect(taken.posted).toEqual([])
  end(true)
  await settled()
  expect(taken.posted).toHaveLength(1)
  const refused = harness()
  const refusedEnd = refused.participation.mentionStarted(chat.externalId)
  refused.replies.observe(prompt('p1'))
  refusedEnd(false)
  await settled()
  expect(refused.posted).toEqual([])
})

it('posts nothing for a chat that is no longer its thread’s', async () => {
  const h = harness(() => false)
  await h.participation.load()
  h.participation.add(chat.externalId)
  h.replies.observe(ended({ lastAssistantMessage: 'late answer' }, 1))
  await settled()
  expect(h.posted).toEqual([])
})

it('stops an answer waiting out a rate limit once another chat took the thread meanwhile', async () => {
  let holds = true
  const calls: string[] = []
  const participation = new SlackLocalParticipation(`b${++bots}`, () => true)
  await participation.load()
  participation.add(chat.externalId)
  const replies = new SlackLocalReplies({
    fetch: async () => {
      calls.push('chat.postMessage')
      // Slack asks to wait; while the answer waits, the thread's link goes to another chat.
      holds = false
      return new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), {
        status: 429,
        headers: { 'retry-after': '1' }
      })
    },
    current: async () => ({
      botToken: 'xoxb-test',
      identity: { teamId: 'T1', botUserId: 'U0BOT' }
    }),
    hostName: () => 'host',
    signal: new AbortController().signal,
    onError: () => {},
    participation,
    canPost: () => holds,
    sleep: async () => {}
  })
  replies.observe(ended({ lastAssistantMessage: 'an answer' }, 1))
  await vi.waitFor(() => expect(calls).toHaveLength(1))
  await settled()
  // The retry checked the thread again first: no second post.
  expect(calls).toHaveLength(1)
})
