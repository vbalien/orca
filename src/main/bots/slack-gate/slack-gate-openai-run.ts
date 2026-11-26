// An OpenAI Decisions gate's check: the rules (the editor's saved ones, or ones its rules script writes
// for this message), limits checked before asking and a count reserved for a wake.
import type { BotSlackGateEdit, SlackGateEvent } from '../../../shared/bots/bot-slack-gate'
import {
  SLACK_GATE_LIMIT_MAX_COOLDOWN_MINUTES,
  slackGateLongestCooldown,
  slackGateRulesExtended,
  type SlackGateRule,
  type SlackGateRulesConfig
} from '../../../shared/bots/slack-gate-rules-config'
import type { SlackGateOpenAIOutcome } from './slack-gate-openai'
import { decideSlackGateRules, slackGateRulesAllLimited } from './slack-gate-rules'
import {
  readRulesScriptOutput,
  SLACK_GATE_SCRIPT_MAX_OUTPUT_BYTES
} from './slack-gate-rules-script'
import type {
  SlackGateBot,
  SlackGateDecideOptions,
  SlackGateDeps,
  SlackGateOutcome,
  SlackGateScriptRun
} from './slack-gate-types'
import type { SlackGateBotCounts, SlackGateWakeCounts } from './slack-gate-wake-counts'

function ruleReason(config: SlackGateRulesConfig, index: number | undefined): string | undefined {
  const rule = index === undefined ? undefined : config.rules[index]
  return rule ? (rule.note ? `${rule.question}: ${rule.note}` : rule.question) : undefined
}

/** A message posted in a channel without addressing the bot: the own app's channel messages, and an
 *  Orca Cloud `slack.message` automation event. A failed or unsure check never wakes for one. */
/** How long limited rules stay held after an unreadable counts file: the longest cooldown the gate's
 *  rules can set (a rules script may set any, so the most allowed). */
export function slackGateRecoveryCooldown(
  gate: Extract<BotSlackGateEdit, { kind: 'openai' }>
): number {
  return gate.rulesCommand
    ? SLACK_GATE_LIMIT_MAX_COOLDOWN_MINUTES
    : slackGateLongestCooldown(gate.openai)
}

/** The event as OpenAI is asked about it: a slack.message automation event as the channel message
 *  it is, so the channel questions (which answer false for other cases) judge it. */
export function slackGateOpenAIEvent(event: SlackGateEvent): SlackGateEvent {
  return isChannelMessage(event) ? { ...event, case: 'channel_message' } : event
}

export function isChannelMessage(event: SlackGateEvent): boolean {
  return (
    event.case === 'channel_message' ||
    (event.case === 'trigger' && event.trigger?.event === 'message')
  )
}

/** A command gate's input is the event as it always was: newer gate-only fields stay out. */
export function commandEvent(event: SlackGateEvent): Omit<SlackGateEvent, 'contextIncomplete'> {
  const { contextIncomplete: _gateOnly, ...rest } = event
  return rest
}

/** What a rules script reads on stdin: a command gate's input and this channel's limit counts. */
export function rulesScriptStdin(
  bot: { id: string; name?: string },
  event: SlackGateEvent,
  wakes: Record<string, unknown>
): string {
  return JSON.stringify({ v: 1, botId: bot.id, botName: bot.name, ...commandEvent(event), wakes })
}

export class SlackGateOpenAIRun {
  constructor(
    private readonly deps: SlackGateDeps,
    private readonly counts: SlackGateWakeCounts,
    private readonly scriptRuns: Map<string, SlackGateScriptRun>
  ) {}

  /** An OpenAI gate: its rules (the saved ones, or a rules script's), limits checked before and after. */
  async openai(
    bot: SlackGateBot,
    gate: Extract<BotSlackGateEdit, { kind: 'openai' }>,
    event: SlackGateEvent,
    key: string | null,
    signal: AbortSignal,
    timeoutAt: number,
    run: SlackGateDecideOptions['run']
  ): Promise<SlackGateOutcome> {
    const store = this.counts
    // Read only when a limit or a rules script needs them.
    let loaded: SlackGateBotCounts | null = null
    const counts = async () =>
      (loaded ??= await store.load(bot.id, slackGateRecoveryCooldown(gate)))
    let config = gate.openai
    let rulesFrom: 'saved' | 'script' = 'saved'
    if (gate.rulesCommand) {
      const script = await this.script(
        bot,
        gate.rulesCommand,
        event,
        await counts(),
        signal,
        timeoutAt
      )
      if (script.kind === 'error' || script.kind === 'verdict') {
        return script
      }
      if (script.kind === 'ask') {
        config = script.config
        rulesFrom = 'script'
      }
    }
    const limited = slackGateRulesExtended(config).limits ? await counts() : null
    const rolls = new Map<number, boolean>()
    const limitOpen = (index: number, rule: SlackGateRule) => {
      const limit = rule.limit
      if (!limit) {
        return true
      }
      if (!rolls.has(index)) {
        rolls.set(index, (this.deps.random ?? Math.random)() < (limit.chance ?? 1))
      }
      return (
        rolls.get(index) === true &&
        limited !== null &&
        store.open(limited, event.channelId, rule.question, limit, this.deps.now())
      )
    }
    // Every way to wake is used up: no need to ask.
    if (slackGateRulesAllLimited(config, limitOpen)) {
      return { kind: 'verdict', wake: false, rateLimited: true, rulesFrom }
    }
    const asked = await this.deps
      .askOpenAI({
        config,
        bot: { name: bot.name },
        event: slackGateOpenAIEvent(event),
        key,
        signal,
        opaque: rulesFrom === 'script'
      })
      .catch((): SlackGateOpenAIOutcome => ({
        kind: 'error',
        error: 'OpenAI request failed'
      }))
    if (asked.kind === 'error') {
      return {
        kind: 'error',
        error: asked.error,
        ...(asked.refused ? { refused: asked.refused } : {}),
        rulesFrom
      }
    }
    const verdict = decideSlackGateRules(config, asked.answers, {
      case: isChannelMessage(event) ? 'channel_message' : event.case,
      limitOpen
    })
    const outcome: SlackGateOutcome = {
      kind: 'verdict',
      wake: verdict.wake,
      rules: verdict.rules,
      rulesFrom,
      // A script's question names and choices may carry message text: they stay out of decisions.
      ...(rulesFrom === 'saved' ? { answers: verdict.answers } : {}),
      ...(verdict.score !== undefined ? { score: verdict.score } : {}),
      ...(verdict.rateLimited ? { rateLimited: true as const } : {})
    }
    if (!verdict.wake) {
      return outcome
    }
    const reasonText = ruleReason(config, verdict.reasonRule)
    const reasonRule =
      verdict.reasonRule === undefined ? undefined : config.rules[verdict.reasonRule]
    const reason = reasonText
      ? {
          wakeReason: {
            text: reasonText,
            from: rulesFrom === 'script' ? ('script' as const) : ('rules' as const)
          }
        }
      : {}
    if (!reasonRule?.limit) {
      return { ...outcome, ...reason }
    }
    const reservation = store.reserve(limited ?? (await counts()), {
      channelId: event.channelId,
      question: reasonRule.question,
      at: this.deps.now(),
      ...run
    })
    if (!reservation || !(await reservation.persisted)) {
      return { ...outcome, wake: false, rateLimited: true }
    }
    return { ...outcome, ...reason, reservation }
  }

  /** Runs the gate's rules script for one event; its output is checked like the editor's input. */
  private async script(
    bot: SlackGateBot,
    command: string,
    event: SlackGateEvent,
    counts: SlackGateBotCounts,
    signal: AbortSignal,
    timeoutAt: number
  ): Promise<
    | Extract<SlackGateOutcome, { kind: 'error' }>
    | Extract<SlackGateOutcome, { kind: 'verdict' }>
    | { kind: 'ask'; config: SlackGateRulesConfig }
    | { kind: 'useSaved' }
  > {
    const at = this.deps.now()
    const ran = this.deps.runCommand({
      command,
      stdin: rulesScriptStdin(bot, event, this.counts.channelWakes(counts, event.channelId, at)),
      // A rules script never gets a key: Orca calls OpenAI itself.
      key: null,
      timeoutMs: Math.max(1, timeoutAt - at),
      signal,
      stdoutLimit: SLACK_GATE_SCRIPT_MAX_OUTPUT_BYTES
    })
    const result = await ran.outcome
    const failed = (error: string, extra: { timedOut?: true; exitCode?: number | null } = {}) => {
      this.scriptRuns.set(bot.id, { at, outcome: 'error', error })
      return { kind: 'error' as const, error, rulesFrom: 'script' as const, ...extra }
    }
    // The script's processes are cleaned up before its slot is free again.
    await ran.released
    if (result.kind === 'timeout') {
      return failed('The rules script timed out', { timedOut: true })
    }
    if (result.kind === 'cancelled') {
      return failed('Stopped')
    }
    if (result.kind === 'error') {
      return failed('The rules script could not start')
    }
    if (result.code !== 0) {
      return failed(`The rules script exited with ${result.code}`, { exitCode: result.code })
    }
    if (result.stdoutTooLarge) {
      return failed('The rules script printed too much')
    }
    const answer = readRulesScriptOutput(result.stdout ?? '')
    if (answer.kind === 'error') {
      return failed(answer.error)
    }
    this.scriptRuns.set(bot.id, { at, outcome: answer.kind })
    if (answer.kind === 'verdict') {
      return {
        kind: 'verdict',
        wake: answer.wake,
        rulesFrom: 'script',
        ...(answer.wake && answer.reason
          ? { wakeReason: { text: answer.reason, from: 'script' as const } }
          : {})
      }
    }
    return answer
  }
}
