// The gate's channel-message and newer-rules boundaries: a channel message never wakes unchecked,
// on a failed check or on an unsure answer; a rules script never gets the key, and its failure never
// wakes; a used-up limit never asks OpenAI; and what a script made up never reaches a log.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BotSlackGate, SlackGateEvent } from '../../../shared/bots/bot-slack-gate'
import type { SlackGateRulesConfig } from '../../../shared/bots/slack-gate-rules-config'
import { useBotStateRoot } from './bot-state-file'
import { SlackGateDecider, type SlackGateDeps } from './slack-gate'
import { runSlackGateCommand, type SlackGateCommandOutcome } from './slack-gate-command'
import type { SlackGateAnswer } from './slack-gate-openai'
import { SlackGateWakeCounts } from './slack-gate-wake-counts'

const asks: SlackGateRulesConfig = {
  questions: [{ type: 'predicate', name: 'asks', instructions: 'Asks?' }],
  rules: [{ question: 'asks', wakeIf: { atLeast: 0.7 }, unsureFrom: 0.3 }],
  whenUnsure: 'wake'
}
const gate = (fields: Partial<Extract<BotSlackGate, { kind: 'openai' }>> = {}): BotSlackGate => ({
  on: true,
  kind: 'openai',
  openai: asks,
  appliesTo: ['thread_reply'],
  channelMessages: { channels: ['C1'] },
  timeoutSeconds: 5,
  onError: 'wake',
  ...fields
})
const channel = (fields: Partial<SlackGateEvent> = {}): SlackGateEvent => ({
  eventId: 'e1',
  case: 'channel_message',
  teamId: 'T1',
  channelId: 'C1',
  placeKind: 'public_channel',
  from: { userId: 'U1' },
  text: 'hello',
  ...fields
})
const predicate = (value: number): SlackGateAnswer => ({ type: 'predicate', value })

let counts: SlackGateWakeCounts
beforeEach(() => {
  useBotStateRoot(mkdtempSync(join(tmpdir(), 'gate-channel-')))
  counts = new SlackGateWakeCounts({ now: Date.now, warn: () => {} })
})
afterEach(() => {
  useBotStateRoot(null)
  vi.restoreAllMocks()
})

function decider(fields: Partial<SlackGateDeps> = {}) {
  const asked: { config: SlackGateRulesConfig; opaque?: boolean }[] = []
  const scripts: { stdin: string; key: string | null }[] = []
  const deps: SlackGateDeps = {
    readKey: async () => 'sk-test',
    now: Date.now,
    counts,
    askOpenAI: async (input) => {
      asked.push({ config: input.config, ...(input.opaque ? { opaque: true } : {}) })
      return { kind: 'answers', answers: { asks: predicate(0.9) } }
    },
    runCommand: () => {
      throw new Error('no script in this test')
    },
    ...fields
  }
  return { decider: new SlackGateDecider(deps), asked, scripts }
}
const bot = (slackGate: BotSlackGate) => ({ id: 'b1', name: 'Bot', slackGate })

it('never wakes for a channel message unchecked, on a failed check or on an unsure answer', async () => {
  const { decider: d } = decider()
  // Not in the gate's channels, or the gate off: not taken, and not woken.
  for (const slackGate of [gate({ channelMessages: { channels: ['C2'] } }), gate({ on: false })]) {
    expect(await d.decide(bot(slackGate), channel())).toMatchObject({
      verdict: 'block',
      reason: 'not_gated'
    })
  }
  // A failed check blocks it whatever onError says; a thread reply follows onError.
  const failing = decider({
    askOpenAI: async () => ({ kind: 'error', error: 'OpenAI answered 503' })
  })
  expect(await failing.decider.decide(bot(gate()), channel())).toMatchObject({
    verdict: 'block',
    reason: 'error'
  })
  expect(
    await failing.decider.decide(bot(gate()), channel({ case: 'thread_reply' }))
  ).toMatchObject({ verdict: 'wake', reason: 'error' })
  // Unsure (0.3 to 0.7) wakes a thread reply under whenUnsure: wake, never a channel message.
  const unsure = decider({
    askOpenAI: async () => ({ kind: 'answers', answers: { asks: predicate(0.5) } })
  })
  expect((await unsure.decider.decide(bot(gate()), channel())).verdict).toBe('block')
  expect(
    (await unsure.decider.decide(bot(gate()), channel({ case: 'thread_reply' }))).verdict
  ).toBe('wake')
})

function script(stdout: string, outcome: Partial<SlackGateCommandOutcome> = {}) {
  const runs: { stdin: string; key: string | null; stdoutLimit?: number }[] = []
  return {
    runs,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a fake runner: the decider reads only these fields of a command run.
    runCommand: ((input: { stdin: string; key: string | null; stdoutLimit?: number }) => {
      runs.push(input)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a fake runner: the decider reads only these fields of a command run.
      const result = Promise.resolve({
        kind: 'exit',
        code: 0,
        stdout,
        ...outcome
      } as SlackGateCommandOutcome)
      return { outcome: result, released: result.then(() => undefined) }
    }) as unknown as SlackGateDeps['runCommand']
  }
}

it('runs the rules script without the key, asks the rules it prints, and logs nothing it made up', async () => {
  const marker = 'Zephyr_secret_marker'
  const printed = JSON.stringify({
    ask: {
      questions: [
        {
          type: 'choice',
          name: marker,
          instructions: 'Which?',
          choices: [{ value: `v_${marker}` }, { value: 'other' }]
        }
      ],
      rules: [{ question: marker, wakeIf: { oneOf: [`v_${marker}`] }, note: 'asked: answer it' }]
    }
  })
  const run = script(printed)
  const logs: unknown[] = []
  vi.spyOn(console, 'info').mockImplementation((...args) => void logs.push(args))
  const { decider: d, asked } = decider({
    runCommand: run.runCommand,
    askOpenAI: async (input) => {
      asked.push({ config: input.config, ...(input.opaque ? { opaque: true } : {}) })
      return { kind: 'answers', answers: { [marker]: { type: 'choice', value: `v_${marker}` } } }
    }
  })
  const decision = await d.decide(bot(gate({ rulesCommand: 'node rules.mjs' })), channel())
  expect(decision).toMatchObject({ verdict: 'wake', rulesFrom: 'script' })
  expect(decision.wakeReason).toEqual({ text: `${marker}: asked: answer it`, from: 'script' })
  expect(run.runs[0]?.key).toBeNull()
  expect(JSON.parse(run.runs[0]!.stdin)).toMatchObject({
    v: 1,
    case: 'channel_message',
    channelId: 'C1'
  })
  expect(asked).toEqual([{ config: JSON.parse(printed).ask, opaque: true }])
  expect(JSON.stringify(logs)).not.toContain(marker)
  expect(JSON.stringify({ ...decision, wakeReason: undefined })).not.toContain(marker)
})

it('never wakes when the rules script fails, whatever onError says', async () => {
  for (const run of [
    script('not json'),
    script('{"wake": true}', { code: 1 }),
    script('', { stdoutTooLarge: true }),
    script(JSON.stringify({ ask: { questions: [], rules: [] } })),
    script('{"wake": "yes"}')
  ]) {
    const { decider: d, asked } = decider({ runCommand: run.runCommand })
    for (const event of [channel(), channel({ case: 'thread_reply' })]) {
      expect(await d.decide(bot(gate({ rulesCommand: 'node rules.mjs' })), event)).toMatchObject({
        verdict: 'block',
        reason: 'error',
        rulesFrom: 'script'
      })
    }
    expect(asked).toEqual([])
  }
  // A script that decides itself, or defers to the saved rules.
  const itself = decider({
    runCommand: script('{"wake": true, "reason": "asked by name"}').runCommand
  })
  expect(await itself.decider.decide(bot(gate({ rulesCommand: 'x' })), channel())).toMatchObject({
    verdict: 'wake',
    wakeReason: { text: 'asked by name', from: 'script' }
  })
  expect(itself.asked).toEqual([])
  const saved = decider({ runCommand: script('{"useSaved": true}').runCommand })
  expect(await saved.decider.decide(bot(gate({ rulesCommand: 'x' })), channel())).toMatchObject({
    verdict: 'wake',
    rulesFrom: 'saved'
  })
  expect(saved.asked).toEqual([{ config: asks }])
})

const limited: SlackGateRulesConfig = {
  questions: [
    { type: 'predicate', name: 'asks', instructions: 'Asks?' },
    { type: 'predicate', name: 'banter', instructions: 'Banter?' }
  ],
  rules: [
    { question: 'asks', wakeIf: { atLeast: 0.9 } },
    { question: 'banter', wakeIf: { atLeast: 0.9 }, limit: { perDay: 1 }, note: 'join briefly' }
  ],
  combine: 'any'
}

it('wakes on a limited rule once a day, counts only the rule the wake rests on, and asks nothing once used up', async () => {
  let answers: Record<string, SlackGateAnswer> = { asks: predicate(0.1), banter: predicate(0.95) }
  const { decider: d, asked } = decider({
    askOpenAI: async (input) => {
      asked.push({ config: input.config })
      return { kind: 'answers', answers }
    }
  })
  const limitedGate = gate({ openai: limited })
  const first = await d.decide(bot(limitedGate), channel())
  expect(first).toMatchObject({ verdict: 'wake', wakeReason: { text: 'banter: join briefly' } })
  first.reservation!.admit(Date.now())
  first.reservation!.commit(Date.now())
  // Banter is used up for today; a message that asks the bot still wakes it, and counts nothing.
  answers = { asks: predicate(0.95), banter: predicate(0.95) }
  const second = await d.decide(bot(limitedGate), channel({ eventId: 'e2' }))
  expect(second).toMatchObject({ verdict: 'wake', wakeReason: { text: 'asks' } })
  expect(second.reservation).toBeUndefined()
  answers = { asks: predicate(0.1), banter: predicate(0.95) }
  expect(await d.decide(bot(limitedGate), channel({ eventId: 'e3' }))).toMatchObject({
    verdict: 'block',
    reason: 'rate_limited'
  })
  // When every way to wake is limited and used up, OpenAI is not asked at all.
  const onlyBanter = gate({
    openai: { ...limited, questions: [limited.questions[1]!], rules: [limited.rules[1]!] }
  })
  const before = asked.length
  expect(await d.decide(bot(onlyBanter), channel({ eventId: 'e4' }))).toMatchObject({
    verdict: 'block',
    reason: 'rate_limited'
  })
  expect(asked.length).toBe(before)
})

it('never wakes on a failed check when the rules have a limit, and gives a late verdict’s count back', async () => {
  const failing = decider({
    askOpenAI: async () => ({ kind: 'error', error: 'OpenAI answered 503' })
  })
  expect(
    await failing.decider.decide(bot(gate({ openai: limited })), channel({ case: 'thread_reply' }))
  ).toMatchObject({ verdict: 'block', reason: 'error' })
  // A verdict that comes after the timeout is a failed check, and its reservation goes back.
  vi.useFakeTimers()
  let answer: (value: {
    kind: 'answers'
    answers: Record<string, SlackGateAnswer>
  }) => void = () => {}
  const slow = decider({
    askOpenAI: () => new Promise((resolve) => (answer = resolve))
  })
  const deciding = slow.decider.decide(bot(gate({ openai: limited, timeoutSeconds: 1 })), channel())
  await vi.advanceTimersByTimeAsync(1500)
  answer({ kind: 'answers', answers: { asks: predicate(0.1), banter: predicate(0.95) } })
  expect(await deciding).toMatchObject({ verdict: 'block' })
  vi.useRealTimers()
  const loaded = await counts.load('b1', 0)
  expect(counts.open(loaded, 'C1', 'banter', { perDay: 1 }, Date.now())).toBe(true)
})

it('asks OpenAI with the saved key and runs a rules script without one', async () => {
  const keys: (string | null)[] = []
  const run = script('{"useSaved":true}')
  const { decider: d } = decider({
    askOpenAI: async (input) => {
      keys.push(input.key)
      return { kind: 'answers', answers: { asks: predicate(0.9) } }
    },
    runCommand: run.runCommand
  })
  expect((await d.decide(bot(gate()), channel())).verdict).toBe('wake')
  expect((await d.decide(bot(gate({ rulesCommand: 'rules' })), channel())).verdict).toBe('wake')
  expect(keys).toEqual(['sk-test', 'sk-test'])
  expect(run.runs.map((entry) => entry.key)).toEqual([null])
})

it('treats an Orca Cloud slack.message event like a channel message: a failed or unsure check never wakes', async () => {
  const message = channel({
    case: 'trigger',
    trigger: { automationId: 'a1', triggerId: 'r1', event: 'message' }
  })
  const triggers = gate({ appliesTo: ['trigger'], channelMessages: undefined })
  // OpenAI is asked about it as a channel message, so the channel questions judge it.
  const cases: string[] = []
  const asking = decider({
    askOpenAI: async (input) => {
      cases.push(input.event.case)
      return { kind: 'answers', answers: { asks: predicate(0.9) } }
    }
  })
  expect((await asking.decider.decide(bot(triggers), message)).verdict).toBe('wake')
  expect(cases).toEqual(['channel_message'])
  const failing = decider({
    askOpenAI: async () => ({ kind: 'error', error: 'OpenAI answered 503' })
  })
  expect(await failing.decider.decide(bot(triggers), message)).toMatchObject({
    verdict: 'block',
    reason: 'error'
  })
  const unsure = decider({
    askOpenAI: async () => ({ kind: 'answers', answers: { asks: predicate(0.5) } })
  })
  expect((await unsure.decider.decide(bot(triggers), message)).verdict).toBe('block')
  // Another automation event still follows onError.
  const reaction = channel({
    case: 'trigger',
    trigger: { automationId: 'a1', triggerId: 'r1', event: 'reaction_added' }
  })
  expect((await failing.decider.decide(bot(triggers), reaction)).verdict).toBe('wake')
})

it('tells before any read when every way to wake is used up, never rolling chance', async () => {
  const random = vi.fn(() => 0)
  const { decider: d } = decider({ random })
  const onlyBanter = gate({
    openai: { ...limited, questions: [limited.questions[1]!], rules: [limited.rules[1]!] }
  })
  expect(await d.limitsClosed(bot(onlyBanter), channel())).toBe(false)
  const loaded = await counts.load('b1', 0)
  const reservation = counts.reserve(loaded, {
    channelId: 'C1',
    question: 'banter',
    at: Date.now()
  })!
  await reservation.persisted
  reservation.admit(Date.now())
  reservation.commit(Date.now())
  expect(await d.limitsClosed(bot(onlyBanter), channel())).toBe(true)
  // Another rule without a limit can still wake, and a rules script's rules aren't known yet.
  expect(await d.limitsClosed(bot(gate({ openai: limited })), channel())).toBe(false)
  expect(await d.limitsClosed(bot(gate({ openai: limited, rulesCommand: 'r' })), channel())).toBe(
    false
  )
  expect(random).not.toHaveBeenCalled()
})

it('gives back the count of a verdict that came after the gate gave up on it', async () => {
  vi.useFakeTimers()
  let answer: (value: {
    kind: 'answers'
    answers: Record<string, SlackGateAnswer>
  }) => void = () => {}
  // A runner that ignores its stop: the gate gives up two seconds after the timeout.
  const slow = decider({ askOpenAI: () => new Promise((resolve) => (answer = resolve)) })
  const deciding = slow.decider.decide(bot(gate({ openai: limited, timeoutSeconds: 1 })), channel())
  await vi.advanceTimersByTimeAsync(3500)
  expect(await deciding).toMatchObject({ verdict: 'block', reason: 'error' })
  answer({ kind: 'answers', answers: { asks: predicate(0.1), banter: predicate(0.95) } })
  vi.useRealTimers()
  await vi.waitFor(async () => {
    const loaded = await counts.load('b1', 0)
    expect((await counts.pendingStatus('b1')).pending).toBe(0)
    expect(counts.open(loaded, 'C1', 'banter', { perDay: 1 }, Date.now())).toBe(true)
  })
})

it('rolls chance once per event and rule, before asking, and reserves nothing when it says no', async () => {
  const rolls = [0.7, 0.2]
  const random = vi.fn(() => rolls.shift() ?? 0)
  const answers: Record<string, SlackGateAnswer> = { banter: predicate(0.95) }
  const { decider: d, asked } = decider({
    random,
    askOpenAI: async (input) => {
      asked.push({ config: input.config })
      return { kind: 'answers', answers }
    }
  })
  const sometimes = gate({
    openai: {
      ...limited,
      questions: [limited.questions[1]!],
      rules: [{ question: 'banter', wakeIf: { atLeast: 0.9 }, limit: { chance: 0.5 } }]
    }
  })
  // 0.7 is past one in two: the only way to wake is closed, so OpenAI isn't asked.
  expect(await d.decide(bot(sometimes), channel())).toMatchObject({
    verdict: 'block',
    reason: 'rate_limited'
  })
  expect(asked).toHaveLength(0)
  expect((await counts.pendingStatus('b1')).pending).toBe(0)
  // 0.2 lets it through: asked once, and the same roll decides after the answer (no second roll).
  const woke = await d.decide(bot(sometimes), channel({ eventId: 'e2' }))
  expect(woke).toMatchObject({ verdict: 'wake' })
  expect(asked).toHaveLength(1)
  expect(random).toHaveBeenCalledTimes(2)
  woke.reservation!.release()
})

// The real runner runs commands through /bin/sh; Windows has its own (unsupported) answer.
it.skipIf(process.platform === 'win32')(
  'takes a rules script’s output up to 64 KiB, and fails the check past it, with the real runner',
  async () => {
    // Valid JSON padded with spaces: only its size differs.
    const printing = (spaces: number) =>
      `printf '{"useSaved":true}'; head -c ${spaces} /dev/zero | tr '\\0' ' '`
    const { decider: d } = decider({ runCommand: runSlackGateCommand })
    const under = await d.decide(bot(gate({ rulesCommand: printing(64 * 1024 - 100) })), channel())
    expect(under).toMatchObject({ verdict: 'wake', rulesFrom: 'saved' })
    const over = await d.decide(
      bot(gate({ rulesCommand: printing(64 * 1024 + 100) })),
      channel({ eventId: 'e2' })
    )
    expect(over).toMatchObject({
      verdict: 'block',
      reason: 'error',
      error: 'The rules script printed too much'
    })
  }
)

it('queues Orca Cloud slack.message events with channel messages, so they never hold up a mention', async () => {
  const waiting = new Map<string, () => void>()
  const { decider: d } = decider({
    askOpenAI: (input) =>
      new Promise((resolve) =>
        waiting.set(input.event.eventId, () =>
          resolve({ kind: 'answers', answers: { asks: predicate(0.9) } })
        )
      )
  })
  const triggers = gate({ appliesTo: ['trigger', 'mention'], channelMessages: undefined })
  const message = (eventId: string) =>
    channel({
      eventId,
      case: 'trigger',
      trigger: { automationId: 'a', triggerId: 'r', event: 'message' }
    })
  const first = d.decide(bot(triggers), message('t1'))
  const second = d.decide(bot(triggers), message('t2'))
  const mention = d.decide(bot(triggers), channel({ eventId: 'm', case: 'mention' }))
  // One channel check at a time; the mention runs beside it, not behind the second.
  await vi.waitFor(() => expect([...waiting.keys()].sort()).toEqual(['m', 't1']))
  for (const id of ['m', 't1']) {
    waiting.get(id)!()
  }
  await vi.waitFor(() => expect(waiting.has('t2')).toBe(true))
  waiting.get('t2')!()
  expect((await Promise.all([first, second, mention])).map((d) => d.verdict)).toEqual([
    'wake',
    'wake',
    'wake'
  ])
})
