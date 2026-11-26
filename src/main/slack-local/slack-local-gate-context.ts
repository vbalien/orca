// What an OpenAI wake gate sees of a running chat's thread: the messages right before a reply, read for the
// gate alone (the chat already has its thread, and command gates get what they always got). Bounded: a few
// at a time per app, a short time budget, and none while Slack asks to wait; any shortfall is a marker.
import type { Bot } from '../../shared/bot-types'
import { slackGateApplies, type SlackGateEvent } from '../../shared/bots/bot-slack-gate'
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

/** How many earlier messages the bot's gate would send for this message; 0 when it reads none. */
export function gateContextWanted(bot: Bot, message: LocalSlackMessage): number {
  const gate = bot.slackGate
  if (
    gate?.kind !== 'openai' ||
    !message.inThread ||
    !slackGateApplies(bot, { case: message.case })
  ) {
    return 0
  }
  return Math.min(slackGateEarlierLimit(gate.openai), DEFAULT_LIMIT)
}

export class SlackLocalGateContext {
  private reading = 0
  private pausedUntil = 0

  constructor(
    private readonly deps: {
      recentThread: SlackLocalRecentThread
      botUserId: string
      signal: AbortSignal
      now?: () => number
    }
  ) {}

  /** The last `limit` messages before this one, oldest first; `self` marks the bot's own. */
  async read(message: LocalSlackMessage, limit: number): Promise<GateContextItem[]> {
    const now = this.deps.now?.() ?? Date.now()
    if (this.reading >= GATE_CONTEXT_READS_AT_ONCE || now < this.pausedUntil) {
      return [{ kind: 'unreadable', text: '' }]
    }
    this.reading += 1
    const budget = new AbortController()
    // A plain timer, not AbortSignal.timeout: it goes with the read, and tests can drive it.
    const timer = setTimeout(() => budget.abort(), GATE_CONTEXT_BUDGET_MS)
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
        this.pausedUntil = (this.deps.now?.() ?? Date.now()) + error.retryAfterMs
      }
      return [{ kind: 'unreadable', text: '' }]
    } finally {
      clearTimeout(timer)
      budget.abort()
      this.reading -= 1
    }
  }
}
