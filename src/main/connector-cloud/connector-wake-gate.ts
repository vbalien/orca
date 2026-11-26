// Orca Cloud's Slack deliveries in front of the Slack wake gate: each start, send and automation
// event is turned into the gate's event and decided in its conversation's lane, before any chat.
import { randomUUID } from 'node:crypto'
import type { ConnectorDelivery } from '../../shared/connectors/connector-cloud-contract'
import type { AutomationRunEvent } from '../../shared/automation-event-triggers'
import type { Bot } from '../../shared/bot-types'
import { slackGateApplies, type SlackGateEvent } from '../../shared/bots/bot-slack-gate'
import type { EventStartGate } from '../automations/automation-trigger-runs'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import {
  decideSlackWake,
  slackGateWakeCounts,
  type SlackWakeDecision
} from '../bots/slack-gate/slack-gate'
import { holdSlackGateRun, slackGateReasonNote } from '../bots/slack-gate/slack-gate-runs'
import type { SlackGateWakeCounts } from '../bots/slack-gate/slack-gate-wake-counts'
import type { ConversationAdmission } from '../external-conversations/external-conversation-host'
import { refusalOf } from '../external-conversations/external-conversation-chain'
import {
  refused,
  type ConversationKey
} from '../external-conversations/external-conversation-types'
import {
  slackGateCaseOf,
  slackGateEventOf,
  slackPlace,
  TextBudget,
  type GateCase,
  type StartOrSend
} from './connector-wake-gate-event'
import { placeLaunchTarget } from './connector-places'
import { precheckResult, settleTriggerCounts } from './connector-wake-gate-trigger-counts'

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
  /** Automation runs by automation, for settling a limited rule's count by what its run did. */
  runsOf?: (automationIds: readonly string[]) => Map<string, readonly AutomationRun[]>
  counts?: SlackGateWakeCounts
}

/** A start or send's wake gate admission, with what it found: the reason it lets the message go on,
 *  and `settled` to keep or give back a limited rule's count by how the delivery went. */
export type GatedAdmission = ConversationAdmission & {
  note: () => string | undefined
  /** `outcome`: the delivery's, or 'threw'. */
  settled: (outcome: string) => void
}

function caseKey(entry: GateCase): string {
  return `${entry.case}:${entry.mentionUnknown ? '?' : ''}`
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
  ): GatedAdmission | undefined {
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
    let passed: {
      reason?: SlackWakeDecision['wakeReason']
      reservation?: SlackWakeDecision['reservation']
      at: number
    } | null = null
    const admission = async (signal: AbortSignal, link: { botId?: string } | null) => {
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
        decision.reservation?.release()
        return refused(refusalOf(signal))
      }
      if (decision.reason === 'expired' || now() >= deadlineAt) {
        decision.reservation?.release()
        return refused('delivery_expired')
      }
      if (decision.verdict !== 'wake') {
        decision.reservation?.release()
        return { outcome: 'accepted' as const, held: true as const }
      }
      // Let through: from here a limited rule's count waits on the delivery's result.
      const at = now()
      decision.reservation?.admit(at)
      passed = {
        at,
        ...(decision.wakeReason ? { reason: decision.wakeReason } : {}),
        ...(decision.reservation ? { reservation: decision.reservation } : {})
      }
      return null
    }
    return Object.assign(admission, {
      note: () => (passed?.reason ? slackGateReasonNote(passed.reason) : undefined),
      settled: (outcome: string) => {
        const reservation = passed?.reservation
        if (!reservation || !passed) {
          return
        }
        // Thrown or unknown after the gate let it through: it may have woken the bot, so it counts.
        if (outcome === 'accepted' || outcome === 'unknown' || outcome === 'threw') {
          reservation.commit(passed.at)
        } else {
          reservation.release()
        }
      }
    })
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

  /** Whether a start or send's carried automations must come on their own, through the trigger
   *  gate: one wire inTurn flag can't leave out a single entry, so if any Slack automation's bot
   *  gates triggers, none rides the turn. `sourceOf` resolves an entry's source from its rule. */
  function defersCarried<Entry extends { botId: string }>(
    entries: readonly Entry[],
    sourceOf: (entry: Entry) => string | undefined
  ): boolean {
    return entries.some((entry) => {
      const bot = deps.bots().find((candidate) => candidate.id === entry.botId)
      return (
        Boolean(bot && slackGateApplies(bot, { case: 'trigger' })) && sourceOf(entry) === 'slack'
      )
    })
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
    let reservation: SlackWakeDecision['reservation']
    return {
      expired,
      created: (run) => {
        if (reservation) {
          reservation.creating = false
        }
        void run
      },
      failed: () => reservation?.release(),
      reserve: async () => {
        if (expired()) {
          return { refused: true }
        }
        await settleTriggerCounts(
          { runsOf: deps.runsOf, counts: deps.counts ?? slackGateWakeCounts, now },
          bot
        )
        const startedAt = now()
        const runId = randomUUID()
        const decision = await decide(bot, gateEvent, {
          ...(deadlineAt === undefined ? {} : { deadlineAt }),
          run: { automationId: delivery.automationId, runId }
        })
        if (decision.reason === 'expired' || decision.reason === 'cancelled' || expired()) {
          decision.reservation?.release()
          if (decision.reason !== 'cancelled') {
            onExpired()
          }
          return { refused: true }
        }
        if (decision.verdict === 'wake') {
          reservation = decision.reservation
          // The reason (rules' or script's, either may quote the message) lives in memory until the
          // run's prompt is made, never in its record.
          const reason = decision.wakeReason
          holdSlackGateRun(runId, {
            automationId: delivery.automationId,
            ...(reason ? { note: slackGateReasonNote(reason) } : {}),
            ...(reservation ? { reservation } : {})
          })
          return { event, runId }
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

  return { wakeGate, wakeGateApart, defersCarried, triggerGate }
}
