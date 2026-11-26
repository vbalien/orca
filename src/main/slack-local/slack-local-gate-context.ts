// What an OpenAI wake gate sees of a running chat's thread: the messages right before a reply, read for the
// gate alone (the chat already has its thread, and command gates get what they always got). Bounded: a few
// at a time per app, a short time budget, and none while Slack asks to wait; any shortfall is a marker.
import type { Bot } from '../../shared/bot-types'
import {
  effectiveSlackGate,
  slackGateApplies,
  type SlackGateCase,
  type SlackGateEvent
} from '../../shared/bots/bot-slack-gate'
import { slackGateEarlierLimit } from '../../shared/bots/slack-gate-rules-config'
import type { LocalSlackMessage } from './slack-local-events'
import type { LocalSlackThreadMessage } from './slack-local-reads'
import { SlackApiError } from './slack-web-api'

export type GateContextItem = NonNullable<SlackGateEvent['context']>[number]

export type SlackLocalRecentThread = (
  channelId: string,
  threadTs: string,
  beforeTs: string,
  signal: AbortSignal
) => Promise<{ messages: LocalSlackThreadMessage[]; complete: boolean }>

export const GATE_CONTEXT_READS_AT_ONCE = 2
export const GATE_CONTEXT_BUDGET_MS = 3_000
const DEFAULT_LIMIT = 20

/** How many earlier messages the bot's gate would send for this message; 0 when it reads none. A gate
 *  with a rules script reads the most, since the script decides what goes. */
export function gateContextWanted(
  bot: Bot,
  message: Pick<LocalSlackMessage, 'inThread' | 'channelId'> & { case: SlackGateCase }
): number {
  const gate = bot.slackGate ? effectiveSlackGate(bot.slackGate) : null
  if (
    gate?.kind !== 'openai' ||
    !message.inThread ||
    !slackGateApplies(bot, { case: message.case, channelId: message.channelId })
  ) {
    return 0
  }
  return gate.rulesCommand
    ? DEFAULT_LIMIT
    : Math.min(slackGateEarlierLimit(gate.openai), DEFAULT_LIMIT)
}

/** When Slack asked this app to wait; shared by every read lane of one connection. */
export type SlackReadPause = { until: number }

export class SlackLocalGateContext {
  private reading = 0

  constructor(
    private readonly deps: {
      recentThread: SlackLocalRecentThread
      botUserId: string
      signal: AbortSignal
      now?: () => number
      /** Reads at once in this lane (default 2). */
      atOnce?: number
      pause?: SlackReadPause
    }
  ) {}

  private readonly ownPause: SlackReadPause = { until: 0 }
  private get pause(): SlackReadPause {
    return this.deps.pause ?? this.ownPause
  }

  /** Runs one bounded read in this lane: null when the lane is full, Slack asked to wait, the budget
   *  ran out or the read failed. */
  async bounded<T>(
    read: (signal: AbortSignal) => Promise<T>,
    budgetMs = GATE_CONTEXT_BUDGET_MS
  ): Promise<T | null> {
    const now = this.deps.now?.() ?? Date.now()
    if (
      budgetMs <= 0 ||
      this.reading >= (this.deps.atOnce ?? GATE_CONTEXT_READS_AT_ONCE) ||
      now < this.pause.until
    ) {
      return null
    }
    this.reading += 1
    const budget = new AbortController()
    const timer = setTimeout(() => budget.abort(), Math.min(budgetMs, GATE_CONTEXT_BUDGET_MS))
    timer.unref?.()
    const stopped = new Promise<null>((resolve) =>
      budget.signal.addEventListener('abort', () => resolve(null), { once: true })
    )
    try {
      return await Promise.race([read(AbortSignal.any([this.deps.signal, budget.signal])), stopped])
    } catch (error) {
      if (error instanceof SlackApiError && error.retryAfterMs !== undefined) {
        this.pause.until = (this.deps.now?.() ?? Date.now()) + error.retryAfterMs
      }
      return null
    } finally {
      clearTimeout(timer)
      budget.abort()
      this.reading -= 1
    }
  }

  /** The last `limit` messages before this one, oldest first; `self` marks the bot's own. */
  async read(
    message: LocalSlackMessage,
    limit: number,
    budgetMs = GATE_CONTEXT_BUDGET_MS
  ): Promise<GateContextItem[]> {
    const now = this.deps.now?.() ?? Date.now()
    if (
      budgetMs <= 0 ||
      this.reading >= (this.deps.atOnce ?? GATE_CONTEXT_READS_AT_ONCE) ||
      now < this.pause.until
    ) {
      return [{ kind: 'unreadable', text: '' }]
    }
    this.reading += 1
    const budget = new AbortController()
    // A plain timer, not AbortSignal.timeout: it goes with the read, and tests can drive it.
    const timer = setTimeout(() => budget.abort(), Math.min(budgetMs, GATE_CONTEXT_BUDGET_MS))
    timer.unref?.()
    const stopped = new Promise<null>((resolve) =>
      budget.signal.addEventListener('abort', () => resolve(null), { once: true })
    )
    try {
      const read = await Promise.race([
        this.deps.recentThread(
          message.channelId,
          message.threadTs,
          message.ts,
          AbortSignal.any([this.deps.signal, budget.signal])
        ),
        stopped
      ])
      if (!read) {
        return [{ kind: 'unreadable', text: '' }]
      }
      // Past the pages it may read, the newest messages are missing: as good as unreadable.
      if (!read.complete) {
        return [{ kind: 'unreadable', text: '' }]
      }
      const before = read.messages.filter((entry) => Number(entry.ts) < Number(message.ts))
      const kept = before
        .slice(-limit)
        .map((entry): GateContextItem =>
          entry.userId === this.deps.botUserId
            ? { kind: 'self', text: entry.text }
            : entry.botId
              ? { kind: 'bot', text: entry.text }
              : { kind: 'earlier', text: entry.text }
        )
      return before.length > kept.length ? [{ kind: 'more', text: '' }, ...kept] : kept
    } catch (error) {
      if (error instanceof SlackApiError && error.retryAfterMs !== undefined) {
        this.pause.until = (this.deps.now?.() ?? Date.now()) + error.retryAfterMs
      }
      return [{ kind: 'unreadable', text: '' }]
    } finally {
      clearTimeout(timer)
      budget.abort()
      this.reading -= 1
    }
  }
}
