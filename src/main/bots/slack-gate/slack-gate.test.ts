import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  slackGateApplies,
  slackGateCommandChanged,
  type BotSlackGate,
  type SlackGateEvent
} from '../../../shared/bots/bot-slack-gate'
import { SlackGateDecider, SLACK_GATE_WAITING_PER_BOT, type SlackGateDeps } from './slack-gate'
import type { SlackGateCommandOutcome } from './slack-gate-command'

const command = (
  fields: Partial<Extract<BotSlackGate, { kind: 'command' }>> = {}
): BotSlackGate => ({
  on: true,
  kind: 'command',
  command: 'check',
  appliesTo: ['thread_reply'],
  timeoutSeconds: 5,
  onError: 'wake',
  ...fields
})

const event = (fields: Partial<SlackGateEvent> = {}): SlackGateEvent => ({
  eventId: 'd1',
  case: 'thread_reply',
  teamId: 'T1',
  channelId: 'C1',
  placeKind: 'public_channel',
  from: { userId: 'U1' },
  text: 'hello',
  ...fields
})

/** A command run the test settles by hand; `stopped` resolves when the decider stops it. */
function heldRun() {
  let settle: (outcome: SlackGateCommandOutcome) => void = () => {}
  const outcome = new Promise<SlackGateCommandOutcome>((resolve) => (settle = resolve))
  return { outcome, settle }
}

function decider(runs: ReturnType<typeof heldRun>[], fields: Partial<SlackGateDeps> = {}) {
  const started: AbortSignal[] = []
  const deps: SlackGateDeps = {
    readKey: async () => null,
    now: Date.now,
    askJev: async () => ({ kind: 'error', error: 'unused' }),
    runCommand: ({ signal }) => {
      started.push(signal)
      const run = runs.shift() ?? heldRun()
      signal.addEventListener('abort', () => run.settle({ kind: 'cancelled' }))
      return { outcome: run.outcome, released: run.outcome.then(() => undefined) }
    },
    ...fields
  }
  return { decider: new SlackGateDecider(deps), started }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('slackGateApplies', () => {
  it('applies to a selected case, to any message riding the turn, and conservatively to unknown mentions', () => {
    const bot = { slackGate: command({ appliesTo: ['mention'] }) }
    expect(slackGateApplies(bot, { case: 'thread_reply' })).toBe(false)
    expect(slackGateApplies(bot, { case: 'thread_reply', mentionUnknown: true })).toBe(true)
    expect(
      slackGateApplies(bot, { case: 'thread_reply', later: [{ case: 'mention', text: 'x' }] })
    ).toBe(true)
    expect(slackGateApplies({ slackGate: command({ on: false }) }, { case: 'thread_reply' })).toBe(
      false
    )
  })

  it('treats a cleared or replaced command as a command change, other edits not', () => {
    expect(slackGateCommandChanged(command(), command({ timeoutSeconds: 9 }))).toBe(false)
    expect(slackGateCommandChanged(command(), command({ command: 'other' }))).toBe(true)
    expect(slackGateCommandChanged(command(), null)).toBe(true)
    expect(slackGateCommandChanged(undefined, undefined)).toBe(false)
  })
})

describe('SlackGateDecider', () => {
  it('maps exit 0 to wake, 1 to block, and anything else through onError', async () => {
    const bot = (onError: 'wake' | 'block') => ({
      id: 'b',
      name: 'B',
      slackGate: command({ onError })
    })
    for (const [code, onError, verdict, reason] of [
      [0, 'block', 'wake', 'passed'],
      [1, 'wake', 'block', 'blocked'],
      [2, 'wake', 'wake', 'error'],
      [2, 'block', 'block', 'error']
    ] as const) {
      const run = heldRun()
      const { decider: gate } = decider([run])
      const decided = gate.decide(bot(onError), event())
      run.settle({ kind: 'exit', code })
      expect(await decided).toMatchObject({ verdict, reason })
    }
  })

  it('treats the gate timeout as an error (onError) but the delivery deadline as expired', async () => {
    vi.useFakeTimers()
    const bot = { id: 'b', name: 'B', slackGate: command({ timeoutSeconds: 1, onError: 'wake' }) }
    const timedOut = decider([]).decider.decide(bot, event(), { deadlineAt: Date.now() + 60_000 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await timedOut).toMatchObject({ verdict: 'wake', reason: 'error', timedOut: true })

    const expired = decider([]).decider.decide(bot, event(), { deadlineAt: Date.now() + 500 })
    await vi.advanceTimersByTimeAsync(500)
    expect(await expired).toMatchObject({ reason: 'expired' })
  })

  it('reports a Stop as cancelled, never through onError', async () => {
    const stop = new AbortController()
    const bot = { id: 'b', name: 'B', slackGate: command({ onError: 'wake' }) }
    const decided = decider([]).decider.decide(bot, event(), { signal: stop.signal })
    stop.abort('conversation_cancelled')
    expect(await decided).toMatchObject({ verdict: 'block', reason: 'cancelled' })
  })

  it('runs two checks per bot, queues a bounded number, and expires a queued check without launching it', async () => {
    vi.useFakeTimers()
    const bot = { id: 'b', name: 'B', slackGate: command({ timeoutSeconds: 20 }) }
    const first = heldRun()
    const second = heldRun()
    const { decider: gate, started } = decider([first, second])
    const running = [gate.decide(bot, event()), gate.decide(bot, event())]
    const queued = Array.from({ length: SLACK_GATE_WAITING_PER_BOT }, () =>
      gate.decide(bot, event(), { deadlineAt: Date.now() + 1_000 })
    )
    const overflow = await gate.decide(bot, event())
    expect(overflow).toMatchObject({ reason: 'error' })
    await vi.advanceTimersByTimeAsync(1_000)
    for (const decision of await Promise.all(queued)) {
      expect(decision.reason).toBe('expired')
    }
    expect(started).toHaveLength(2)
    first.settle({ kind: 'exit', code: 0 })
    second.settle({ kind: 'exit', code: 1 })
    expect((await Promise.all(running)).map((decision) => decision.verdict)).toEqual([
      'wake',
      'block'
    ])
  })

  it('hands a freed slot straight to a waiter, so the bot never runs more than two checks', async () => {
    let active = 0
    let most = 0
    const settles: ((code: number) => void)[] = []
    const gate = new SlackGateDecider({
      readKey: async () => null,
      now: Date.now,
      askJev: async () => ({ kind: 'error', error: 'unused' }),
      runCommand: () => {
        active += 1
        most = Math.max(most, active)
        const outcome = new Promise<SlackGateCommandOutcome>((resolve) =>
          settles.push((code) => resolve({ kind: 'exit', code }))
        )
        const released = outcome.then(() => {
          active -= 1
        })
        return { outcome, released }
      }
    })
    const bot = { id: 'b', name: 'B', slackGate: command({ timeoutSeconds: 20 }) }
    const first = [gate.decide(bot, event()), gate.decide(bot, event()), gate.decide(bot, event())]
    await vi.waitFor(() => expect(settles).toHaveLength(2))
    // Both running checks end together while one waits; two more arrive right after.
    settles[0]?.(0)
    settles[1]?.(0)
    await Promise.all(first.slice(0, 2))
    const more = [gate.decide(bot, event()), gate.decide(bot, event())]
    await vi.waitFor(() => expect(settles.length).toBeGreaterThanOrEqual(3))
    for (let i = 2; i < 5; i++) {
      await vi.waitFor(() => expect(settles.length).toBeGreaterThan(i))
      settles[i]?.(0)
    }
    await Promise.all([...first, ...more])
    expect(most).toBe(2)
  })

  it('bounds a stalled key read by the timeout and never launches once the key arrives late', async () => {
    vi.useFakeTimers()
    let keyArrives: (key: string | null) => void = () => {}
    const key = new Promise<string | null>((resolve) => (keyArrives = resolve))
    const { decider: gate, started } = decider([], { readKey: () => key })
    const bot = { id: 'b', name: 'B', slackGate: command({ timeoutSeconds: 1, onError: 'block' }) }
    const decided = gate.decide(bot, event())
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await decided).toMatchObject({ verdict: 'block', reason: 'error', timedOut: true })
    keyArrives('k1')
    await vi.advanceTimersByTimeAsync(10)
    expect(started).toHaveLength(0)
  })

  it('never carries a request error into the decision, which can reach automation history', async () => {
    const jev: BotSlackGate = {
      on: true,
      kind: 'jev',
      appliesTo: ['thread_reply'],
      timeoutSeconds: 5,
      onError: 'block',
      jev: { question: 'q', threshold: 0.5 }
    }
    const { decider: gate } = decider([], {
      readKey: async () => 'sk-secret',
      askJev: async () => {
        throw new TypeError('Invalid header value: Bearer sk-secret')
      }
    })
    const decided = await gate.decide({ id: 'b', name: 'B', slackGate: jev }, event())
    expect(decided).toMatchObject({ verdict: 'block', reason: 'error' })
    expect(JSON.stringify(decided)).not.toContain('sk-secret')
  })

  it('never runs a gate that does not apply', async () => {
    const { decider: gate, started } = decider([])
    const bot = { id: 'b', name: 'B', slackGate: command({ appliesTo: ['dm'] }) }
    expect(await gate.decide(bot, event())).toMatchObject({ verdict: 'wake', reason: 'not_gated' })
    expect(started).toHaveLength(0)
  })
})
