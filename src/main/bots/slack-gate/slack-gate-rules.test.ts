// A gate config's rules decide wake or block from its answers; the real decider asks OpenAI (a fake
// fetch here), follows onError for a refused or bad answer, and keeps command gates' stdin as it was.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BotSlackGate, SlackGateEvent } from '../../../shared/bots/bot-slack-gate'
import type { SlackGateRulesConfig } from '../../../shared/bots/slack-gate-rules-config'
import { validateSlackGateRules } from '../../../shared/bots/slack-gate-rules-validate'
import { SlackGateDecider } from './slack-gate'
import { askSlackGateOpenAI, readSlackGateAnswers, type SlackGateAnswer } from './slack-gate-openai'
import { decideSlackGateRules } from './slack-gate-rules'

const predicate = (value: number): SlackGateAnswer => ({ type: 'predicate', value })
const config = (fields: Partial<SlackGateRulesConfig>): SlackGateRulesConfig => ({
  questions: [
    { type: 'predicate', name: 'asks', instructions: 'Asks?' },
    { type: 'predicate', name: 'chat', instructions: 'Chat?' },
    {
      type: 'choice',
      name: 'topic',
      instructions: 'Topic?',
      choices: [{ value: 'deploy' }, { value: 'other' }]
    }
  ],
  rules: [
    { question: 'asks', wakeIf: { atLeast: 0.7 }, unsureFrom: 0.4 },
    { question: 'chat', blockIf: { atLeast: 0.8 } },
    { question: 'topic', wakeIf: { oneOf: ['deploy'] } }
  ],
  ...fields
})
const answers = (asks: number, chat: number, topic: string) => ({
  asks: predicate(asks),
  chat: predicate(chat),
  topic: { type: 'choice' as const, value: topic }
})

describe('decideSlackGateRules', () => {
  it('blocks on any passing block rule, then combines wake rules all or any', () => {
    expect(decideSlackGateRules(config({}), answers(0.9, 0.1, 'deploy'))).toEqual({
      wake: true,
      answers: { asks: 0.9, chat: 0.1, topic: 'deploy' },
      rules: ['pass', 'fail', 'pass'],
      score: 0.9,
      reasonRule: 0
    })
    expect(decideSlackGateRules(config({}), answers(0.9, 0.85, 'deploy')).wake).toBe(false)
    expect(decideSlackGateRules(config({}), answers(0.9, 0.1, 'other')).wake).toBe(false)
    expect(decideSlackGateRules(config({ combine: 'any' }), answers(0.9, 0.1, 'other')).wake).toBe(
      true
    )
    expect(decideSlackGateRules(config({ combine: 'any' }), answers(0.1, 0.1, 'other')).wake).toBe(
      false
    )
    // Only block rules: wake unless one passes.
    const blockOnly = config({ rules: [{ question: 'chat', blockIf: { atMost: 0.2 } }] })
    expect(decideSlackGateRules(blockOnly, answers(0, 0.5, 'x')).wake).toBe(true)
    expect(decideSlackGateRules(blockOnly, answers(0, 0.2, 'x')).wake).toBe(false)
  })

  it('leans an unsure answer the way whenUnsure says, on both sides of the band', () => {
    const unsure = answers(0.5, 0.1, 'deploy')
    expect(decideSlackGateRules(config({}), unsure)).toMatchObject({
      wake: false,
      rules: ['unsure', 'fail', 'pass']
    })
    expect(decideSlackGateRules(config({ whenUnsure: 'wake' }), unsure).wake).toBe(true)
    expect(decideSlackGateRules(config({}), answers(0.4, 0.1, 'deploy')).rules[0]).toBe('unsure')
    expect(decideSlackGateRules(config({}), answers(0.39, 0.1, 'deploy')).rules[0]).toBe('fail')
    const atMost = config({
      rules: [{ question: 'chat', blockIf: { atMost: 0.2 }, unsureFrom: 0.4 }]
    })
    expect(decideSlackGateRules(atMost, answers(0, 0.3, 'x'))).toMatchObject({
      wake: false,
      rules: ['unsure']
    })
    expect(decideSlackGateRules({ ...atMost, whenUnsure: 'wake' }, answers(0, 0.3, 'x')).wake).toBe(
      true
    )
    expect(decideSlackGateRules(atMost, answers(0, 0.41, 'x')).wake).toBe(true)
  })

  it('tells a boolean choice from the same text, from the validator through the answer to the rule', () => {
    const flags: SlackGateRulesConfig = {
      questions: [
        {
          type: 'choice',
          name: 'flag',
          instructions: 'Flag?',
          choices: [{ value: true }, { value: 'true' }, { value: false }]
        }
      ],
      rules: [{ question: 'flag', wakeIf: { oneOf: [false] } }]
    }
    expect(validateSlackGateRules(flags).ok).toBe(true)
    expect(
      validateSlackGateRules({
        ...flags,
        rules: [{ question: 'flag', wakeIf: { oneOf: ['false'] } }]
      })
    ).toMatchObject({ ok: false, issues: [{ code: 'unknown_choice' }] })
    const wakes = (choice: unknown, rule: SlackGateRulesConfig['rules'][number]) => {
      const read = readSlackGateAnswers(flags.questions, {
        answers: [{ type: 'choice', name: 'flag', choice, confidence: 0.9, probabilities: [] }]
      })
      return read.kind === 'answers'
        ? decideSlackGateRules({ ...flags, rules: [rule] }, read.answers).wake
        : null
    }
    expect(wakes(false, flags.rules[0]!)).toBe(true)
    expect(wakes('false', flags.rules[0]!)).toBe(null)
    expect(wakes(true, flags.rules[0]!)).toBe(false)
    const onlyText = { question: 'flag', wakeIf: { oneOf: ['true'] } }
    expect(wakes('true', onlyText)).toBe(true)
    expect(wakes(true, onlyText)).toBe(false)
  })
})

const event: SlackGateEvent = {
  eventId: 'd1',
  case: 'thread_reply',
  teamId: 'T1',
  channelId: 'C1',
  placeKind: 'public_channel',
  from: { userId: 'U1', role: 'member' },
  text: 'secret slack text about the deploy',
  contextIncomplete: 'more'
}
const gate = (openai: SlackGateRulesConfig, onError: 'wake' | 'block' = 'wake'): BotSlackGate => ({
  on: true,
  kind: 'openai',
  appliesTo: ['thread_reply'],
  timeoutSeconds: 5,
  onError,
  openai
})

function decider(body: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body))
  const stdins: string[] = []
  const deps = {
    readKey: async () => 'sk-test-gate-key',
    now: Date.now,
    askOpenAI: (input: Parameters<typeof askSlackGateOpenAI>[0]) =>
      askSlackGateOpenAI({ ...input, fetch }),
    runCommand: ({ stdin }: { stdin: string }) => {
      stdins.push(stdin)
      const outcome = Promise.resolve({ kind: 'exit' as const, code: 0 })
      return { outcome, released: outcome.then(() => undefined) }
    }
  }
  return { decider: new SlackGateDecider(deps), fetch, stdins }
}

const good = [
  { type: 'predicate', name: 'asks', probability: 0.9 },
  { type: 'predicate', name: 'chat', probability: 0.1 },
  {
    type: 'choice',
    name: 'topic',
    choice: 'deploy',
    confidence: 0.8,
    probabilities: [
      { value: 'deploy', probability: 0.8 },
      { value: 'other', probability: 0.2 }
    ]
  }
]

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the decider with an OpenAI gate', () => {
  const rules = config({ whenUnsure: 'block' })

  it('asks every question in one call, decides by the rules, and logs only values', async () => {
    const { decider: woken, fetch } = decider({ model: 'gpt-6-luna', answers: good })
    const bot = { id: 'b1', name: 'Elyang', slackGate: gate(rules) }
    expect(await woken.decide(bot, event)).toMatchObject({
      verdict: 'wake',
      reason: 'passed',
      answers: { asks: 0.9, chat: 0.1, topic: 'deploy' },
      rules: ['pass', 'fail', 'pass']
    })
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))
    expect(body.questions).toEqual(rules.questions)
    expect(body.input[1].content[0].data.earlierMessages).toEqual([
      '(earlier messages in this thread are not shown)'
    ])
    const blocked = decider({
      answers: [good[0], { type: 'predicate', name: 'chat', probability: 0.95 }, good[2]]
    })
    expect(await blocked.decider.decide(bot, event)).toMatchObject({
      verdict: 'block',
      reason: 'blocked'
    })
  })

  it('follows onError when an answer is missing or malformed', async () => {
    for (const onError of ['wake', 'block'] as const) {
      const { decider: broken } = decider({ answers: [good[0]] })
      const bot = { id: 'b1', name: 'Elyang', slackGate: gate(rules, onError) }
      expect(await broken.decide(bot, event)).toMatchObject({ verdict: onError, reason: 'error' })
    }
  })

  it('follows onError without asking when the thread it was told to read could not be read', async () => {
    for (const onError of ['wake', 'block'] as const) {
      const { decider: unread, fetch } = decider({ answers: good })
      const bot = { id: 'b1', name: 'Elyang', slackGate: gate(rules, onError) }
      expect(await unread.decide(bot, { ...event, contextIncomplete: 'unreadable' })).toMatchObject(
        { verdict: onError, reason: 'error' }
      )
      expect(fetch).not.toHaveBeenCalled()
    }
    // A config that sends no earlier messages (left out, or a limit of 0) doesn't need the thread.
    for (const send of [{ message: true }, { message: true, earlierMessages: 0 }]) {
      const { decider: asks, fetch } = decider({ answers: good })
      const noThread = gate({ ...rules, send })
      await asks.decide(
        { id: 'b1', name: 'Elyang', slackGate: noThread },
        { ...event, contextIncomplete: 'unreadable' }
      )
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  })

  it('treats a refusal among good answers as a failed check, and logs only the question names', async () => {
    const logged: unknown[] = []
    vi.spyOn(console, 'info').mockImplementation((...args) => void logged.push(args))
    for (const onError of ['wake', 'block'] as const) {
      const { decider: refusing } = decider({
        answers: [good[0], { type: 'refusal', name: 'chat' }, good[2]]
      })
      const bot = { id: 'b1', name: 'Elyang', slackGate: gate(rules, onError) }
      expect(await refusing.decide(bot, event)).toMatchObject({
        verdict: onError,
        reason: 'error',
        refused: ['chat'],
        error: 'OpenAI declined to answer chat'
      })
    }
    const text = JSON.stringify(logged)
    expect(text).toContain('"refused":["chat"]')
    expect(text).not.toContain('secret slack text')
    expect(text).not.toContain('sk-test-gate-key')
  })

  it('gives a command gate the event without the gate-only completeness flag', async () => {
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
