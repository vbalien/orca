// A cloud delivery as the Slack wake gate reads it: which case it is, and its normalized event.
import type { ConnectorDelivery } from '../../shared/connectors/connector-cloud-contract'
import type { ConnectorAsker } from '../../shared/connector-asker-contract'
import type { SlackGateCase, SlackGateEvent } from '../../shared/bots/bot-slack-gate'

export type StartOrSend = Extract<ConnectorDelivery, { kind: 'start' | 'send' }>
type Send = Extract<ConnectorDelivery, { kind: 'send' }>
export type GateCase = { case: SlackGateCase; mentionUnknown?: true }

// The texts a gate reads, together; a longer message is cut and the event says so.
const MAX_GATE_TEXT_CHARS = 64 * 1024

/** `T:C:ts:UBOT` for a thread, `T:D…` for a DM. */
export function slackPlace(externalId: string): {
  teamId: string
  channelId: string
  threadTs?: string
} {
  const [teamId = '', channelId = '', threadTs] = externalId.split(':')
  return {
    teamId,
    channelId,
    ...(threadTs && /^\d+(?:\.\d+)?$/.test(threadTs) ? { threadTs } : {})
  }
}

function messageTsOf(asker: ConnectorAsker | undefined): string | undefined {
  const ts = asker?.messageRef?.split(':').at(-1)
  return ts && /^\d+(?:\.\d+)?$/.test(ts) ? ts : undefined
}

function isDm(delivery: StartOrSend): boolean {
  return delivery.asker
    ? delivery.asker.place.kind === 'direct_message'
    : slackPlace(delivery.conversation.externalId).channelId.startsWith('D')
}

/** Which of the gate's cases a delivery is, from its own fields only. */
export function slackGateCaseOf(delivery: StartOrSend, mentionsKnown: boolean): GateCase {
  if (isDm(delivery)) {
    return { case: 'dm' }
  }
  if (delivery.kind === 'start') {
    // A start carries no mention mark: only the thread's root message is surely a fresh mention.
    const { threadTs } = slackPlace(delivery.conversation.externalId)
    const messageTs = messageTsOf(delivery.asker)
    return threadTs && messageTs === threadTs
      ? { case: 'mention' }
      : { case: messageTs ? 'thread_reply' : 'mention', mentionUnknown: true }
  }
  if (delivery.mentioned || delivery.bareMention) {
    return { case: 'mention' }
  }
  return mentionsKnown ? { case: 'thread_reply' } : { case: 'thread_reply', mentionUnknown: true }
}

export class TextBudget {
  private left = MAX_GATE_TEXT_CHARS
  cut = false
  take(text: string): string {
    const kept = text.slice(0, Math.max(0, this.left))
    this.left -= kept.length
    this.cut ||= kept.length < text.length
    return kept
  }
}

function askerText(delivery: StartOrSend): string {
  return delivery.asker?.text ?? (delivery.kind === 'start' ? delivery.prompt : delivery.text)
}

export function slackGateEventOf(
  delivery: StartOrSend,
  later: readonly Send[],
  mentionsKnown: boolean
): SlackGateEvent {
  const { asker } = delivery
  const place = slackPlace(delivery.conversation.externalId)
  const budget = new TextBudget()
  const text = budget.take(askerText(delivery))
  const earlierOwn = asker?.earlierOwn
  const ownTexts = earlierOwn?.messages.map((message) => budget.take(message.text))
  const laterEntries = later.map((next) => ({
    ...slackGateCaseOf(next, mentionsKnown),
    text: budget.take(askerText(next))
  }))
  const context = (asker?.context ?? []).flatMap((item) =>
    'text' in item
      ? [
          {
            kind: item.kind,
            ...('userId' in item ? { userId: item.userId } : {}),
            ...('name' in item && item.name ? { name: item.name } : {}),
            text: budget.take(item.text)
          }
        ]
      : []
  )
  const messageTs = messageTsOf(asker)
  const incomplete = asker?.context.find(
    (item) => item.kind === 'unreadable' || item.kind === 'more'
  )?.kind
  return {
    eventId: delivery.deliveryId,
    ...slackGateCaseOf(delivery, mentionsKnown),
    teamId: place.teamId,
    channelId: asker?.place.id ?? place.channelId,
    placeKind:
      asker && asker.place.kind !== 'issue' && asker.place.kind !== 'pull_request'
        ? asker.place.kind
        : isDm(delivery)
          ? 'direct_message'
          : 'channel',
    ...(place.threadTs ? { threadTs: place.threadTs } : {}),
    ...(messageTs ? { messageTs } : {}),
    from: {
      userId: asker?.userId ?? '',
      ...(asker?.name ? { name: asker.name } : {}),
      ...(asker ? { role: asker.role } : {}),
      ...(asker?.app ? { app: true } : {}),
      ...(asker?.via ? { viaBot: asker.via.name } : {})
    },
    text,
    ...(laterEntries.length ? { later: laterEntries } : {}),
    ...(earlierOwn && ownTexts
      ? {
          earlierOwn: {
            texts: ownTexts,
            ...(earlierOwn.more ||
            earlierOwn.messages.some(
              (message) => message.cut || message.filesMore || message.shared
            )
              ? { incomplete: true as const }
              : {})
          }
        }
      : {}),
    ...(delivery.kind === 'send' && delivery.mentioned ? { mentioned: true } : {}),
    ...(context.length ? { context } : {}),
    ...(budget.cut ? { truncated: true as const } : {}),
    ...(incomplete === 'more' || incomplete === 'unreadable'
      ? { contextIncomplete: incomplete }
      : {})
  }
}
