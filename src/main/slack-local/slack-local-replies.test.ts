// A final answer posts once: a part goes again only when Slack surely didn't take it, never after
// the bot's app changed, and never with this computer's paths in it.
import { expect, it } from 'vitest'
import type { ConversationEvent } from '../external-conversations/external-conversation-events'
import { SlackLocalReplies, splitAnswer } from './slack-local-replies'

const key = { source: 'slack-local' as const, externalId: 'T1:C1:1800000000.000100:U0BOT' }
const ended = (text: string, turnId = 5): ConversationEvent => ({
  kind: 'turn-ended',
  conversation: key,
  worktreeId: 'wt',
  paneKey: 'p',
  turnId,
  stopReason: 'success',
  at: 9,
  origin: 'delivery',
  lastAssistantMessage: text
})

type Answer = { status: number; body?: unknown; throws?: { code: string } }

function harness(answers: Answer[]) {
  const posted: string[] = []
  const errors: string[] = []
  const waits: number[] = []
  let identity = { teamId: 'T1', botUserId: 'U0BOT' }
  let release: (() => void) | null = null
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = new URLSearchParams(String(init?.body))
    const answer = answers.shift() ?? { status: 200, body: { ok: true } }
    if (answer.throws) {
      throw Object.assign(new TypeError('fetch failed'), { cause: answer.throws })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a fake fetch error carrying a node cause code.
    if (answer.status === 200 && (answer.body as { ok?: boolean }).ok) {
      posted.push(body.get('markdown_text') ?? body.get('text') ?? '')
    }
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status,
      headers: answer.status === 429 ? { 'retry-after': '120' } : {}
    })
  }
  const replies = new SlackLocalReplies({
    fetch,
    current: () => ({ botToken: 'xoxb-test', identity }),
    hostName: () => 'host',
    signal: new AbortController().signal,
    onError: (code) => errors.push(code),
    sleep: (ms) => {
      waits.push(ms)
      return new Promise((resolve) => (release = () => resolve()))
    }
  })
  return {
    replies,
    posted,
    errors,
    waits,
    resume: () => release?.(),
    switchApp: () => (identity = { teamId: 'T2', botUserId: 'U0OTHER' })
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

it('posts each part once, waits out a rate limit, and never resends an uncertain post', async () => {
  const long = ['a', 'b', 'c'].map((letter) => letter.repeat(11_000)).join('\n')
  expect(splitAnswer(long)).toHaveLength(3)
  const h = harness([
    { status: 200, body: { ok: true } },
    { status: 429 },
    { status: 200, body: { ok: true } },
    { status: 0, throws: { code: 'ECONNRESET' } }
  ])
  h.replies.observe(ended(long))
  await flush()
  expect(h.waits).toEqual([120_000])
  h.resume()
  await flush()
  await flush()
  expect(h.posted.map((part) => part[0])).toEqual(['a', 'b'])
  expect(h.errors).toEqual(['reply_uncertain'])
  // The same end told again posts nothing more.
  h.replies.observe(ended(long))
  await flush()
  expect(h.posted).toHaveLength(2)
})

it('drops what is left once the bot’s app changed, and redacts this computer’s paths', async () => {
  const h = harness([{ status: 200, body: { ok: true } }, { status: 429 }])
  h.replies.observe(ended(`${'a'.repeat(11_000)}\n${'b'.repeat(11_000)}`))
  await flush()
  h.switchApp()
  h.resume()
  await flush()
  expect(h.posted).toHaveLength(1)
  expect(h.errors).toEqual(['identity_changed'])

  const paths = harness([])
  paths.replies.observe(ended('Saved to /home/alice/secret/plan.md', 6))
  await flush()
  expect(paths.posted).toHaveLength(1)
  expect(paths.posted[0]).not.toContain('/home/alice')
})
