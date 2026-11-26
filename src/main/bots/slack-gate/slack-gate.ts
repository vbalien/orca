// The Slack wake gate's one decision: a normalized Slack event in, wake or block out. Any Slack
// connector calls it right before an event would wake a bot.
import {
  effectiveSlackGate,
  slackGateApplies,
  type BotSlackGateEdit,
  type SlackGateEvent
} from '../../../shared/bots/bot-slack-gate'
import { slackGateRulesExtended } from '../../../shared/bots/slack-gate-rules-config'
import { readSlackGateKey } from './slack-gate-key'
import { runSlackGateCommand, type SlackGateCommandRun } from './slack-gate-command'
import { askSlackGateOpenAI } from './slack-gate-openai'
import { commandEvent, SlackGateOpenAIRun } from './slack-gate-openai-run'
import { SlackGateSlots, type SlackGateWork } from './slack-gate-slots'
import type {
  SlackGateBot,
  SlackGateDecideOptions,
  SlackGateDeps,
  SlackGateOutcome,
  SlackGateScriptRun,
  SlackWakeDecision
} from './slack-gate-types'
import { SlackGateWakeCounts } from './slack-gate-wake-counts'

export type {
  SlackGateBot,
  SlackGateDecideOptions,
  SlackGateDeps,
  SlackGateScriptRun,
  SlackWakeDecision
} from './slack-gate-types'
export { rulesScriptStdin } from './slack-gate-openai-run'
export { SLACK_GATE_RUNNING_PER_BOT, SLACK_GATE_WAITING_PER_BOT } from './slack-gate-slots'

type Stop = 'cancelled' | 'expired' | 'timeout'

/** The process's wake counts, shared by every Slack connector's gate. */
export const slackGateWakeCounts = new SlackGateWakeCounts({ now: Date.now })

/** Whether a failed check never wakes: a channel message, or rules whose limits Orca can't honor
 *  without an answer (a rules script may return limited rules; saved ones may have them). */
function failsClosed(gate: BotSlackGateEdit, event: SlackGateEvent): boolean {
  return (
    event.case === 'channel_message' ||
    (gate.kind === 'openai' &&
      (gate.rulesCommand !== undefined || slackGateRulesExtended(gate.openai).limits))
  )
}

export class SlackGateDecider {
  private readonly slots = new SlackGateSlots()
  private readonly scriptRuns = new Map<string, SlackGateScriptRun>()
  private readonly openaiRun: SlackGateOpenAIRun

  constructor(private readonly deps: SlackGateDeps) {
    this.openaiRun = new SlackGateOpenAIRun(
      deps,
      deps.counts ?? slackGateWakeCounts,
      this.scriptRuns
    )
  }

  /** What the bot's rules script last did, since this process started. */
  scriptRun(botId: string): SlackGateScriptRun | undefined {
    return this.scriptRuns.get(botId)
  }

  async decide(
    bot: SlackGateBot,
    event: SlackGateEvent,
    options: SlackGateDecideOptions = {}
  ): Promise<SlackWakeDecision> {
    const startedAt = this.deps.now()
    const elapsed = () => Math.max(0, this.deps.now() - startedAt)
    const stored = bot.slackGate
    if (!stored || !slackGateApplies(bot, event)) {
      // A channel message no gate takes never wakes the bot.
      return {
        verdict: event.case === 'channel_message' ? 'block' : 'wake',
        reason: 'not_gated',
        durationMs: 0
      }
    }
    const gate = effectiveSlackGate(stored)
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
    let outcome: SlackGateOutcome | undefined
    try {
      const lane = event.case === 'channel_message' ? 'channel' : 'main'
      outcome = await this.slots.run(bot.id, lane, stop.signal, () =>
        this.run(bot, gate, event, stop.signal, timeoutAt, options.run)
      )
      const why: Stop | null = stopped
      if (why === 'cancelled' || why === 'expired') {
        return this.finish(bot, event, {
          verdict: 'block',
          reason: why,
          durationMs: elapsed()
        })
      }
      // A verdict that lands after the timeout is a failed check: the timeout already decided it.
      if (outcome.kind === 'verdict' && why !== 'timeout') {
        const wake = outcome.wake
        const decision: SlackWakeDecision = {
          verdict: wake ? 'wake' : 'block',
          reason: wake ? 'passed' : outcome.rateLimited ? 'rate_limited' : 'blocked',
          durationMs: elapsed(),
          ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
          ...(outcome.score !== undefined ? { score: outcome.score } : {}),
          ...(outcome.answers ? { answers: outcome.answers } : {}),
          ...(outcome.rules ? { rules: outcome.rules } : {}),
          ...(outcome.rulesFrom ? { rulesFrom: outcome.rulesFrom } : {}),
          ...(wake && outcome.wakeReason ? { wakeReason: outcome.wakeReason } : {}),
          ...(wake && outcome.reservation ? { reservation: outcome.reservation } : {})
        }
        if (wake) {
          outcome = undefined
        }
        return this.finish(bot, event, decision)
      }
      return this.finish(bot, event, {
        verdict: failsClosed(gate, event) ? 'block' : gate.onError,
        reason: 'error',
        durationMs: elapsed(),
        error:
          why === 'timeout' || outcome.kind === 'verdict'
            ? `Timed out after ${gate.timeoutSeconds}s`
            : outcome.error,
        ...(why === 'timeout' || (outcome.kind === 'error' && outcome.timedOut)
          ? { timedOut: true }
          : {}),
        ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
        ...(outcome.kind === 'error' && outcome.refused ? { refused: outcome.refused } : {}),
        ...(outcome.rulesFrom ? { rulesFrom: outcome.rulesFrom } : {})
      })
    } finally {
      timers.forEach(clearTimeout)
      options.signal?.removeEventListener('abort', onCancel)
      // A count reserved for a wake that didn't come out as one goes back.
      if (outcome?.kind === 'verdict') {
        outcome.reservation?.release()
      }
    }
  }

  private async run(
    bot: SlackGateBot,
    gate: BotSlackGateEdit,
    event: SlackGateEvent,
    signal: AbortSignal,
    timeoutAt: number,
    run: SlackGateDecideOptions['run']
  ): ReturnType<SlackGateWork> {
    const key = await this.deps
      .readKey(bot.id, gate.kind === 'command' ? 'command' : 'openai')
      .catch(() => null)
    // Stopped while the key was read: nothing launches.
    if (signal.aborted) {
      const stopped: SlackGateOutcome = { kind: 'error', error: 'Stopped' }
      return { outcome: Promise.resolve(stopped), released: Promise.resolve() }
    }
    if (gate.kind === 'command') {
      const command: SlackGateCommandRun = this.deps.runCommand({
        command: gate.command,
        stdin: JSON.stringify({ v: 1, botId: bot.id, botName: bot.name, ...commandEvent(event) }),
        key,
        timeoutMs: Math.max(1, timeoutAt - this.deps.now()),
        signal
      })
      const outcome = command.outcome.then((result): SlackGateOutcome => {
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
      return { outcome, released: command.released }
    }
    const asked = this.openaiRun.openai(bot, gate, event, key, signal, timeoutAt, run).catch(
      // Never the thrown message: a malformed key can appear in a header error, and errors reach
      // automation history.
      (): SlackGateOutcome => ({ kind: 'error', error: 'OpenAI request failed' })
    )
    return { outcome: asked, released: asked.then(() => undefined) }
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
      ...(decision.rulesFrom ? { rulesFrom: decision.rulesFrom } : {}),
      ...(decision.exitCode !== undefined ? { exitCode: decision.exitCode } : {}),
      ...(decision.score !== undefined && decision.rulesFrom !== 'script'
        ? { score: decision.score }
        : {}),
      ...(decision.answers ? { answers: decision.answers } : {}),
      ...(decision.rules ? { rules: decision.rules } : {}),
      // Our own fixed sentences (status, question names), never a thrown message or a response body.
      ...(bot.slackGate?.kind === 'openai' && decision.error ? { error: decision.error } : {}),
      ...(decision.refused ? { refused: decision.refused } : {})
    })
    return decision
  }
}

const shared = new SlackGateDecider({
  readKey: readSlackGateKey,
  runCommand: runSlackGateCommand,
  askOpenAI: askSlackGateOpenAI,
  now: Date.now,
  counts: slackGateWakeCounts
})

/** Wake or block one Slack event for `bot`. `cancelled` and `expired` never follow onError: callers
 *  treat them as a refusal and an expired delivery. A decision with a `reservation` must be admitted,
 *  committed or released by the caller. */
export function decideSlackWake(
  bot: SlackGateBot,
  event: SlackGateEvent,
  options?: SlackGateDecideOptions
): Promise<SlackWakeDecision> {
  return shared.decide(bot, event, options)
}

/** What the bot's rules script last did (settings page). */
export function slackGateScriptRun(botId: string): SlackGateScriptRun | undefined {
  return shared.scriptRun(botId)
}
