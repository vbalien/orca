// The Slack wake gate for a bot's own Slack app: the message as the gate reads it, and the gate's
// decision read fail-closed. Runs after Who can ask, before any turn starts or anything is posted.
import type { Bot } from '../../shared/bot-types'
import type { SlackGateEvent } from '../../shared/bots/bot-slack-gate'
import type { ConnectorAsker } from '../../shared/connector-asker-contract'
import { decideSlackWake } from '../bots/slack-gate/slack-gate'
import { TextBudget } from '../connector-cloud/connector-wake-gate-event'
import type { LocalSlackMessage } from './slack-local-events'

/** Decides whether a message wakes the bot; anything but 'wake' posts nothing and starts nothing. */
export type LocalSlackWakeGate = (
  bot: Bot,
  event: SlackGateEvent,
  options: { signal: AbortSignal; deadlineAt: number }
) => Promise<'wake' | 'block'>

// Context markers carry text so every gate kind sees them; Jev reads only texts.
const MARKER_TEXT = {
  more: '(earlier messages in this thread are not shown)',
  unreadable: '(this thread could not be read)'
} as const

/** The local message as the gate reads it. `historyUnknown`: a bare mention in a thread whose
 *  earlier messages weren't read whole, so what they asked before is unknown, not nothing.
 *  `truncated`: inbound already cut a text. */
export function localSlackGateEvent(input: {
  message: LocalSlackMessage
  asker: ConnectorAsker
  historyUnknown: boolean
  truncated: boolean
}): SlackGateEvent {
  const { message, asker } = input
  const budget = new TextBudget()
  const text = budget.take(asker.text)
  const earlierOwn = asker.earlierOwn
    ? {
        texts: asker.earlierOwn.messages.map((entry) => budget.take(entry.text)),
        ...(asker.earlierOwn.more || asker.earlierOwn.messages.some((entry) => entry.cut)
          ? { incomplete: true as const }
          : {})
      }
    : input.historyUnknown
      ? { texts: [], incomplete: true as const }
      : null
  const context = asker.context.map((item) =>
    'text' in item
      ? {
          kind: item.kind,
          ...('userId' in item && item.userId ? { userId: item.userId } : {}),
          text: budget.take(item.text)
        }
      : { kind: item.kind, text: budget.take(MARKER_TEXT[item.kind]) }
  )
  return {
    eventId: message.eventId,
    case: message.case,
    teamId: message.teamId,
    channelId: message.channelId,
    placeKind: placeOf(asker),
    threadTs: message.threadTs,
    messageTs: message.ts,
    from: { userId: message.userId, role: asker.role, ...(asker.name ? { name: asker.name } : {}) },
    text,
    mentioned: message.mentioned,
    ...(earlierOwn ? { earlierOwn } : {}),
    ...(context.length > 0 ? { context } : {}),
    ...(input.truncated || budget.cut ? { truncated: true as const } : {})
  }
}

function placeOf(asker: ConnectorAsker): SlackGateEvent['placeKind'] {
  const kind = asker.place.kind
  return kind === 'issue' || kind === 'pull_request' ? 'channel' : kind
}

/** The gate's decision: wake only on a real wake; cancelled, expired or a throw is a block. */
export function localSlackWakeGate(decide = decideSlackWake): LocalSlackWakeGate {
  return async (bot, event, options) => {
    try {
      const decision = await decide(bot, event, options)
      return decision.verdict === 'wake' &&
        decision.reason !== 'cancelled' &&
        decision.reason !== 'expired'
        ? 'wake'
        : 'block'
    } catch {
      return 'block'
    }
  }
}
