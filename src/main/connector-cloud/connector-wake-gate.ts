// Orca Cloud's Slack deliveries in front of the Slack wake gate: each start, send and automation
// event is turned into the gate's event and decided in its conversation's lane, before any chat.
import { randomUUID } from 'node:crypto'
import type { ConnectorDelivery } from '../../shared/connectors/connector-cloud-contract'
import type { AutomationRunEvent } from '../../shared/automation-event-triggers'
import type { Bot } from '../../shared/bot-types'
import { slackGateApplies, type SlackGateEvent } from '../../shared/bots/bot-slack-gate'
import type { AutomationPrecheckResult } from '../../shared/automations/history/automation-run'
import type { EventStartGate } from '../automations/automation-trigger-runs'
import { decideSlackWake, type SlackWakeDecision } from '../bots/slack-gate/slack-gate'
import { refusalOf } from '../external-conversations/external-conversation-chain'
import {
  refused,
  type ConversationKey
} from '../external-conversations/external-conversation-types'
import type { ConversationAdmission } from '../external-conversations/external-conversation-host'
import {
  slackGateCaseOf,
  slackGateEventOf,
  slackPlace,
  TextBudget,
  type GateCase,
  type StartOrSend
} from './connector-wake-gate-event'
import { placeLaunchTarget } from './connector-places'

type Send = Extract<ConnectorDelivery, { kind: 'send' }>
type Trigger = Extract<ConnectorDelivery, { kind: 'trigger' }>

/** What the gate reads of a bot. */
export type WakeGateBot = Pick<Bot, 'id' | 'name' | 'paused' | 'slackGate'>

export type ConnectorWakeGateDeps = {
  bots: () => readonly WakeGateBot[]
  botsEnabled: () => boolean
  /** The bot a conversation is linked to now; null for no link or a link without a bot. */
  linkedBot: (key: ConversationKey) => string | null
  /** Whether the cloud marks a reply that @mentions the bot. */
  mentionsKnown: () => boolean
  /** Whether a start of this conversation was held by its gate (its receipt still kept). */
  heldStart: (key: ConversationKey) => boolean
  decide?: typeof decideSlackWake
  now?: () => number
}

function caseKey(entry: GateCase): string {
  return `${entry.case}:${entry.mentionUnknown ? '?' : ''}`
}

function precheckResult(
  decision: SlackWakeDecision,
  kind: string,
  at: number
): AutomationPrecheckResult {
  return {
    command: `Slack wake gate (${kind})`,
    exitCode: decision.exitCode ?? null,
    timedOut: decision.timedOut === true,
    durationMs: decision.durationMs,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    error: decision.error ?? null,
    startedAt: at,
    completedAt: at + decision.durationMs
  }
}

export function createConnectorWakeGate(deps: ConnectorWakeGateDeps) {
  const decide = deps.decide ?? decideSlackWake
  const now = deps.now ?? Date.now
  const live = (botId: string): WakeGateBot | null => {
    const bot = deps.bots().find((entry) => entry.id === botId)
    return bot && !bot.paused && deps.botsEnabled() ? bot : null
  }
  const anyGateOn = (bots: readonly WakeGateBot[]) => bots.some((bot) => bot.slackGate?.on)
  // The bot a start or send belongs to as this poll is dispatched, if it is known yet.
  const dispatchBot = (
    delivery: StartOrSend,
    bots: readonly WakeGateBot[]
  ): WakeGateBot | null | 'unknown' => {
    const botId =
      delivery.kind === 'start'
        ? placeLaunchTarget(delivery.placeId)?.botId
        : deps.linkedBot(delivery.conversation)
    if (botId) {
      return bots.find((bot) => bot.id === botId) ?? null
    }
    return delivery.kind === 'send' ? 'unknown' : null
  }

  /** The lane admission for a Slack start or send; undefined when no gate can apply to it. */
  function wakeGate(
    delivery: StartOrSend,
    later: readonly Send[],
    deadlineAt: number
  ): ConversationAdmission | undefined {
    if (delivery.conversation.source !== 'slack' || (delivery.kind === 'send' && delivery.resume)) {
      return undefined
    }
    const bots = deps.bots()
    const snapshot = dispatchBot(delivery, bots)
    const event = slackGateEventOf(delivery, later, deps.mentionsKnown())
    // Only an unlinked send needs a look in the lane without a gate: its start may have been held.
    if (snapshot !== 'unknown' && !(snapshot && slackGateApplies(snapshot, event))) {
      return undefined
    }
    return async (signal, link) => {
      if (delivery.kind === 'send' && link === null) {
        // Server behavior not verified: the contract says the cloud then frees the thread and
        // starts a new chat, whose start this gate decides again.
        return deps.heldStart(delivery.conversation) ? refused('chat_gone') : null
      }
      const botId =
        link?.botId ??
        (delivery.kind === 'start' ? placeLaunchTarget(delivery.placeId)?.botId : undefined)
      if (!botId || !live(botId)) {
        return null
      }
      const settings = snapshot !== 'unknown' && snapshot?.id === botId ? snapshot : live(botId)
      if (!settings || !slackGateApplies(settings, event)) {
        return null
      }
      if (now() >= deadlineAt) {
        return refused('delivery_expired')
      }
      const decision = await decide(settings, event, { signal, deadlineAt })
      if (signal.aborted) {
        return refused(refusalOf(signal))
      }
      if (decision.reason === 'expired' || now() >= deadlineAt) {
        return refused('delivery_expired')
      }
      return decision.verdict === 'wake' ? null : { outcome: 'accepted', held: true }
    }
  }

  /** Whether `next` must not ride `head`'s turn: a gate could judge their cases apart. */
  function wakeGateApart(head: StartOrSend, next: Send): boolean {
    if (head.conversation.source !== 'slack') {
      return false
    }
    const bots = deps.bots()
    const snapshot = dispatchBot(head, bots)
    const gated = snapshot === 'unknown' ? anyGateOn(bots) : Boolean(snapshot?.slackGate?.on)
    const known = deps.mentionsKnown()
    return gated && caseKey(slackGateCaseOf(head, known)) !== caseKey(slackGateCaseOf(next, known))
  }

  /** Whether a carried automation of this bot must wait for its own trigger gate. */
  function gatesTrigger(botId: string): boolean {
    const bot = deps.bots().find((entry) => entry.id === botId)
    return Boolean(bot && slackGateApplies(bot, { case: 'trigger' }))
  }

  /** The start gate a Slack automation event passes; undefined when its bot gates no triggers. */
  function triggerGate(
    delivery: Trigger,
    event: AutomationRunEvent,
    deadlineAt: number | undefined,
    onExpired: () => void
  ): EventStartGate | undefined {
    if (delivery.conversation.source !== 'slack' || event.source !== 'slack') {
      return undefined
    }
    const bot = deps.bots().find((entry) => entry.id === delivery.botId)
    if (!bot || !slackGateApplies(bot, { case: 'trigger' })) {
      return undefined
    }
    const expired = () => {
      const passed = deadlineAt !== undefined && now() >= deadlineAt
      if (passed) {
        onExpired()
      }
      return passed
    }
    const place = slackPlace(event.conversation?.externalId ?? delivery.conversation.externalId)
    const budget = new TextBudget()
    const gateEvent: SlackGateEvent = {
      eventId: delivery.deliveryId,
      case: 'trigger',
      teamId: place.teamId,
      channelId: place.channelId,
      placeKind: place.channelId.startsWith('D') ? 'direct_message' : 'channel',
      ...(place.threadTs ? { threadTs: place.threadTs } : {}),
      from: { userId: event.actorId ?? '', ...(event.actor ? { name: event.actor } : {}) },
      text: budget.take(event.text ?? ''),
      trigger: {
        automationId: delivery.automationId,
        triggerId: event.triggerId,
        event: event.event
      },
      ...(budget.cut ? { truncated: true as const } : {})
    }
    return {
      expired,
      created: () => {},
      reserve: async () => {
        if (expired()) {
          return { refused: true }
        }
        const startedAt = now()
        const decision = await decide(
          bot,
          gateEvent,
          deadlineAt === undefined ? {} : { deadlineAt }
        )
        if (decision.reason === 'expired' || decision.reason === 'cancelled' || expired()) {
          if (decision.reason !== 'cancelled') {
            onExpired()
          }
          return { refused: true }
        }
        if (decision.verdict === 'wake') {
          return { event, runId: randomUUID() }
        }
        return {
          skipped: {
            error:
              decision.reason === 'error'
                ? `Slack wake gate failed and blocked this event: ${decision.error ?? 'error'}`
                : 'Slack wake gate blocked this event.',
            precheckResult: precheckResult(decision, bot.slackGate?.kind ?? 'gate', startedAt)
          }
        }
      }
    }
  }

  return { wakeGate, wakeGateApart, gatesTrigger, triggerGate }
}
