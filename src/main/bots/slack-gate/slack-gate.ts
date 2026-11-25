// The Slack wake gate's one decision: a normalized Slack event in, wake or block out. Any Slack
// connector calls it right before an event would wake a bot.
import {
  slackGateApplies,
  type BotSlackGate,
  type SlackGateEvent
} from '../../../shared/bots/bot-slack-gate'
import type { Bot } from '../../../shared/bot-types'
import { readSlackGateKey } from './slack-gate-key'
import { runSlackGateCommand, type SlackGateCommandRun } from './slack-gate-command'
import { askSlackGateJev, type SlackGateJevOutcome } from './slack-gate-jev'

export type SlackWakeDecision = {
  verdict: 'wake' | 'block'
  reason: 'not_gated' | 'passed' | 'blocked' | 'error' | 'cancelled' | 'expired'
  durationMs: number
  exitCode?: number | null
  timedOut?: boolean
  score?: number
  error?: string
}

export type SlackGateBot = Pick<Bot, 'id' | 'name' | 'slackGate'>

export type SlackGateDeps = {
  readKey: (botId: string) => Promise<string | null>
  runCommand: typeof runSlackGateCommand
  askJev: typeof askSlackGateJev
  now: () => number
}

export const SLACK_GATE_RUNNING_PER_BOT = 2
export const SLACK_GATE_WAITING_PER_BOT = 16
// A runner that ignores its stop gets this long before the decision goes on without it.
const STOP_GRACE_MS = 2_000

type Stop = 'cancelled' | 'expired' | 'timeout'
type Outcome =
  | { kind: 'verdict'; wake: boolean; exitCode?: number | null; score?: number }
  | { kind: 'error'; error: string; exitCode?: number | null; timedOut?: true }

class BotSlots {
  running = 0
  readonly waiting: (() => void)[] = []
}

export class SlackGateDecider {
  private readonly slots = new Map<string, BotSlots>()

  constructor(private readonly deps: SlackGateDeps) {}

  async decide(
    bot: SlackGateBot,
    event: SlackGateEvent,
    options: { signal?: AbortSignal; deadlineAt?: number } = {}
  ): Promise<SlackWakeDecision> {
    const startedAt = this.deps.now()
    const elapsed = () => Math.max(0, this.deps.now() - startedAt)
    const gate = bot.slackGate
    if (!gate || !slackGateApplies(bot, event)) {
      return { verdict: 'wake', reason: 'not_gated', durationMs: 0 }
    }
    if (options.signal?.aborted) {
      return this.finish(bot, event, { verdict: 'block', reason: 'cancelled', durationMs: 0 })
    }
    if (options.deadlineAt !== undefined && startedAt >= options.deadlineAt) {
      return this.finish(bot, event, { verdict: 'block', reason: 'expired', durationMs: 0 })
    }
    const stop = new AbortController()
    let stopped: Stop | null = null
    const stopWith = (why: Stop) => {
      if (!stopped) {
        stopped = why
        stop.abort(why)
      }
    }
    const timers: ReturnType<typeof setTimeout>[] = []
    const after = (ms: number, why: Stop) => {
      const timer = setTimeout(() => stopWith(why), Math.max(0, ms))
      timer.unref?.()
      timers.push(timer)
    }
    const timeoutAt = startedAt + gate.timeoutSeconds * 1000
    after(timeoutAt - startedAt, 'timeout')
    if (options.deadlineAt !== undefined) {
      after(options.deadlineAt - startedAt, 'expired')
    }
    const onCancel = () => stopWith('cancelled')
    options.signal?.addEventListener('abort', onCancel, { once: true })
    try {
      const outcome = await this.withSlot(bot.id, stop.signal, () =>
        this.run(bot, gate, event, stop.signal, timeoutAt)
      )
      const why: Stop | null = stopped
      if (why === 'cancelled' || why === 'expired') {
        return this.finish(bot, event, {
          verdict: 'block',
          reason: why,
          durationMs: elapsed()
        })
      }
      if (outcome.kind === 'verdict') {
        return this.finish(bot, event, {
          verdict: outcome.wake ? 'wake' : 'block',
          reason: outcome.wake ? 'passed' : 'blocked',
          durationMs: elapsed(),
          ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
          ...(outcome.score !== undefined ? { score: outcome.score } : {})
        })
      }
      return this.finish(bot, event, {
        verdict: gate.onError,
        reason: 'error',
        durationMs: elapsed(),
        error: why === 'timeout' ? `Timed out after ${gate.timeoutSeconds}s` : outcome.error,
        ...(why === 'timeout' || outcome.timedOut ? { timedOut: true } : {}),
        ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {})
      })
    } finally {
      timers.forEach(clearTimeout)
      options.signal?.removeEventListener('abort', onCancel)
    }
  }

  private async run(
    bot: SlackGateBot,
    gate: BotSlackGate,
    event: SlackGateEvent,
    signal: AbortSignal,
    timeoutAt: number
  ): Promise<{ outcome: Promise<Outcome>; released: Promise<void> }> {
    const key = await this.deps.readKey(bot.id).catch(() => null)
    if (gate.kind === 'command') {
      const run: SlackGateCommandRun = this.deps.runCommand({
        command: gate.command,
        stdin: JSON.stringify({ v: 1, botId: bot.id, botName: bot.name, ...event }),
        key,
        timeoutMs: Math.max(1, timeoutAt - this.deps.now()),
        signal
      })
      const outcome = run.outcome.then((result): Outcome => {
        switch (result.kind) {
          case 'exit':
            return result.code === 0 || result.code === 1
              ? { kind: 'verdict', wake: result.code === 0, exitCode: result.code }
              : { kind: 'error', error: `Exited with ${result.code}`, exitCode: result.code }
          case 'timeout':
            return { kind: 'error', error: 'Timed out', timedOut: true }
          case 'cancelled':
            return { kind: 'error', error: 'Stopped' }
          case 'error':
            return { kind: 'error', error: result.error }
        }
      })
      return { outcome, released: run.released }
    }
    const asked = this.deps
      .askJev({ jev: gate.jev, event, key, signal })
      .catch((error: unknown): SlackGateJevOutcome => ({
        kind: 'error',
        error: error instanceof Error ? error.message : 'TypeSafe request failed'
      }))
    const outcome = asked.then((result): Outcome =>
      result.kind === 'score'
        ? { kind: 'verdict', wake: result.noul >= gate.jev.threshold, score: result.noul }
        : { kind: 'error', error: result.error }
    )
    return { outcome, released: asked.then(() => undefined) }
  }

  /** Runs `work` in one of the bot's slots, held until its `released` settles. */
  private async withSlot(
    botId: string,
    signal: AbortSignal,
    work: () => Promise<{ outcome: Promise<Outcome>; released: Promise<void> }>
  ): Promise<Outcome> {
    const slots = this.slots.get(botId) ?? new BotSlots()
    this.slots.set(botId, slots)
    if (slots.running >= SLACK_GATE_RUNNING_PER_BOT) {
      if (slots.waiting.length >= SLACK_GATE_WAITING_PER_BOT) {
        return { kind: 'error', error: 'Too many gate checks are waiting for this bot' }
      }
      const admitted = await new Promise<boolean>((resolve) => {
        const ready = () => {
          signal.removeEventListener('abort', give)
          resolve(true)
        }
        const give = () => {
          const at = slots.waiting.indexOf(ready)
          if (at !== -1) {
            slots.waiting.splice(at, 1)
          }
          resolve(false)
        }
        slots.waiting.push(ready)
        signal.addEventListener('abort', give, { once: true })
      })
      if (!admitted) {
        return { kind: 'error', error: 'Stopped while waiting' }
      }
    }
    slots.running += 1
    let started: { outcome: Promise<Outcome>; released: Promise<void> }
    try {
      started = await work()
    } catch (error) {
      this.free(botId, slots)
      return { kind: 'error', error: error instanceof Error ? error.message : 'failed' }
    }
    void started.released.catch(() => undefined).then(() => this.free(botId, slots))
    // The runner stops on `signal`; this only bounds one that ignores it.
    const giveUp = new Promise<Outcome>((resolve) => {
      const onAbort = () => {
        const timer = setTimeout(
          () => resolve({ kind: 'error', error: 'Did not stop in time' }),
          STOP_GRACE_MS
        )
        timer.unref?.()
      }
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
    return await Promise.race([started.outcome, giveUp])
  }

  private free(botId: string, slots: BotSlots): void {
    slots.running -= 1
    const next = slots.waiting.shift()
    if (next) {
      next()
    } else if (slots.running === 0) {
      this.slots.delete(botId)
    }
  }

  private finish(
    bot: SlackGateBot,
    event: SlackGateEvent,
    decision: SlackWakeDecision
  ): SlackWakeDecision {
    console.info('[slack-gate]', {
      botId: bot.id,
      eventId: event.eventId,
      case: event.case,
      verdict: decision.verdict,
      reason: decision.reason,
      durationMs: decision.durationMs,
      ...(decision.exitCode !== undefined ? { exitCode: decision.exitCode } : {}),
      ...(decision.score !== undefined ? { score: decision.score } : {})
    })
    return decision
  }
}

const shared = new SlackGateDecider({
  readKey: readSlackGateKey,
  runCommand: runSlackGateCommand,
  askJev: askSlackGateJev,
  now: Date.now
})

/** Wake or block one Slack event for `bot`. `cancelled` and `expired` never follow onError: callers
 *  treat them as a refusal and an expired delivery. */
export function decideSlackWake(
  bot: SlackGateBot,
  event: SlackGateEvent,
  options?: { signal?: AbortSignal; deadlineAt?: number }
): Promise<SlackWakeDecision> {
  return shared.decide(bot, event, options)
}
