// A Jev config's rules decide wake or block from its answers; the real decider asks TypeSafe (a fake
// fetch here), follows onError for a bad answer, and keeps command gates' stdin exactly as it was.
import { describe, expect, it, vi } from 'vitest'
import type { BotSlackGate, SlackGateEvent } from '../../../shared/bots/bot-slack-gate'
import type {
  SlackGateJevConfig,
  StoredSlackGateJev
} from '../../../shared/bots/slack-gate-jev-config'
import { SlackGateDecider } from './slack-gate'
import { askSlackGateJev, type SlackGateJevAnswer } from './slack-gate-jev'
import { decideSlackGateJevRules } from './slack-gate-jev-rules'

const noul = (value: number): SlackGateJevAnswer => ({ type: 'noul', value })
const config = (fields: Partial<SlackGateJevConfig>): SlackGateJevConfig => ({
  questions: {
    asks: { type: 'noul' },
    chat: { type: 'noul' },
    topic: { type: 'choice', criteria: { deploy: 'D', other: 'O' } }
  },
  rules: [
    { question: 'asks', wakeIf: { atLeast: 0.7 }, unsureFrom: 0.4 },
    { question: 'chat', blockIf: { atLeast: 0.8 } },
    { question: 'topic', wakeIf: { oneOf: ['deploy'] } }
  ],
  ...fields
})
const answers = (asks: number, chat: number, topic: string) => ({
  asks: noul(asks),
  chat: noul(chat),
  topic: { type: 'choice' as const, value: topic }
})

describe('decideSlackGateJevRules', () => {
  it('blocks on any passing block rule, then combines wake rules all or any', () => {
    expect(decideSlackGateJevRules(config({}), answers(0.9, 0.1, 'deploy'))).toEqual({
      wake: true,
      answers: { asks: 0.9, chat: 0.1, topic: 'deploy' },
      rules: ['pass', 'fail', 'pass'],
      score: 0.9
    })
    expect(decideSlackGateJevRules(config({}), answers(0.9, 0.85, 'deploy')).wake).toBe(false)
    expect(decideSlackGateJevRules(config({}), answers(0.9, 0.1, 'other')).wake).toBe(false)
    expect(
      decideSlackGateJevRules(config({ combine: 'any' }), answers(0.9, 0.1, 'other')).wake
    ).toBe(true)
    expect(
      decideSlackGateJevRules(config({ combine: 'any' }), answers(0.1, 0.1, 'other')).wake
    ).toBe(false)
    // Only block rules: wake unless one passes.
    const blockOnly = config({ rules: [{ question: 'chat', blockIf: { atMost: 0.2 } }] })
    expect(decideSlackGateJevRules(blockOnly, answers(0, 0.5, 'x')).wake).toBe(true)
    expect(decideSlackGateJevRules(blockOnly, answers(0, 0.2, 'x')).wake).toBe(false)
  })

  it('leans an unsure answer the way whenUnsure says, on both sides of the band', () => {
    const unsure = answers(0.5, 0.1, 'deploy')
    expect(decideSlackGateJevRules(config({}), unsure)).toMatchObject({
      wake: false,
      rules: ['unsure', 'fail', 'pass']
    })
    expect(decideSlackGateJevRules(config({ whenUnsure: 'wake' }), unsure).wake).toBe(true)
    expect(decideSlackGateJevRules(config({}), answers(0.4, 0.1, 'deploy')).rules[0]).toBe('unsure')
    expect(decideSlackGateJevRules(config({}), answers(0.39, 0.1, 'deploy')).rules[0]).toBe('fail')
    const atMost = config({
      rules: [{ question: 'chat', blockIf: { atMost: 0.2 }, unsureFrom: 0.4 }]
    })
    expect(decideSlackGateJevRules(atMost, answers(0, 0.3, 'x'))).toMatchObject({
      wake: false,
      rules: ['unsure']
    })
    expect(
      decideSlackGateJevRules({ ...atMost, whenUnsure: 'wake' }, answers(0, 0.3, 'x')).wake
    ).toBe(true)
    expect(decideSlackGateJevRules(atMost, answers(0, 0.41, 'x')).wake).toBe(true)
  })
})

const event: SlackGateEvent = {
  eventId: 'd1',
  case: 'thread_reply',
  teamId: 'T1',
  channelId: 'C1',
  placeKind: 'public_channel',
  from: { userId: 'U1', role: 'member' },
  text: 'deploy?',
  contextIncomplete: 'unreadable'
}
const gate = (jev: StoredSlackGateJev, onError: 'wake' | 'block' = 'wake'): BotSlackGate => ({
  on: true,
  kind: 'jev',
  appliesTo: ['thread_reply'],
  timeoutSeconds: 5,
  onError,
  jev
})

function decider(body: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body))
  const stdins: string[] = []
  const deps = {
    readKey: async () => 'k1',
    now: Date.now,
    askJev: (input: Parameters<typeof askSlackGateJev>[0]) => askSlackGateJev({ ...input, fetch }),
    runCommand: ({ stdin }: { stdin: string }) => {
      stdins.push(stdin)
      const outcome = Promise.resolve({ kind: 'exit' as const, code: 0 })
      return { outcome, released: outcome.then(() => undefined) }
    }
  }
  return { decider: new SlackGateDecider(deps), fetch, stdins }
}

describe('the decider with a Jev config', () => {
  const rules = config({ whenUnsure: 'block' })

  it('asks every question in one call, decides by the rules, and logs only values', async () => {
    const good = {
      answers: {
        asks: { type: 'noul', noul: 0.9 },
        chat: { type: 'noul', noul: 0.1 },
        topic: {
          type: 'choice',
          choice: 'deploy',
          confidence: 0.8,
          probabilities: { deploy: 0.8, other: 0.2 }
        }
      }
    }
    const { decider: woken, fetch } = decider(good)
    const bot = { id: 'b1', name: 'Elyang', slackGate: gate(rules) }
    expect(await woken.decide(bot, event)).toMatchObject({
      verdict: 'wake',
      reason: 'passed',
      answers: { asks: 0.9, chat: 0.1, topic: 'deploy' },
      rules: ['pass', 'fail', 'pass']
    })
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))
    expect(body.questions).toEqual(rules.questions)
    expect(body.state.earlierMessages).toEqual(['(this thread could not be read)'])
    const blocked = decider({ answers: { ...good.answers, chat: { type: 'noul', noul: 0.95 } } })
    expect(await blocked.decider.decide(bot, event)).toMatchObject({
      verdict: 'block',
      reason: 'blocked'
    })
  })

  it('follows onError when an answer is missing or malformed', async () => {
    for (const onError of ['wake', 'block'] as const) {
      const { decider: broken } = decider({ answers: { asks: { type: 'noul', noul: 0.9 } } })
      const bot = { id: 'b1', name: 'Elyang', slackGate: gate(rules, onError) }
      expect(await broken.decide(bot, event)).toMatchObject({ verdict: onError, reason: 'error' })
    }
  })

  it('gives a command gate the event without the Jev-only completeness flag', async () => {
    const { decider: commands, stdins } = decider({})
    const command: BotSlackGate = {
      on: true,
      kind: 'command',
      appliesTo: ['thread_reply'],
      timeoutSeconds: 5,
      onError: 'wake',
      command: 'check'
    }
    await commands.decide({ id: 'b1', name: 'Elyang', slackGate: command }, event)
    const { contextIncomplete: _flag, ...withoutFlag } = event
    expect(stdins).toEqual([
      JSON.stringify({ v: 1, botId: 'b1', botName: 'Elyang', ...withoutFlag })
    ])
  })
})
