// What a delivery's dispatch hands the wake gate: its deadline, and the host its lane asks first.
import {
  CONNECTOR_CLIENT_LIMITS,
  type ConnectorDelivery,
  type ConnectorDeliveryResult
} from '../../shared/connectors/connector-cloud-contract'
import type { ExternalConversationHost } from '../external-conversations/external-conversation-host'
import type { ConnectorMachine } from './connector-machine'

type Send = Extract<ConnectorDelivery, { kind: 'send' }>

/** When a delivery's wake gate must have its answer, on this machine's clock. */
export function gateDeadline(
  delivery: { expiresAt: number },
  msLeft: (expiresAt: number) => number
): number {
  return Date.now() + msLeft(delivery.expiresAt) - CONNECTOR_CLIENT_LIMITS.minDeadlineLeftMs
}

export function triggerResult(ran: boolean | 'expired'): ConnectorDeliveryResult {
  if (ran === 'expired') {
    return { outcome: 'expired' }
  }
  return ran ? { outcome: 'accepted' } : { outcome: 'refused', reason: 'automation_not_listening' }
}

/** The host a start or send is delivered through: one that asks its wake gate first, if any, and
 *  `settle`, which the dispatch calls with the delivery's result (a limited rule's count). */
export function gatedHost(
  machine: Pick<ConnectorMachine, 'wakeGate'>,
  host: ExternalConversationHost,
  delivery: ConnectorDelivery,
  later: readonly Send[],
  msLeft: (expiresAt: number) => number
): ExternalConversationHost & {
  settle: <T extends { outcome: string }>(deliver: () => Promise<T>) => Promise<T>
} {
  const admit =
    delivery.kind === 'start' || delivery.kind === 'send'
      ? machine.wakeGate?.(delivery, later, gateDeadline(delivery, msLeft))
      : undefined
  const settle = async <T extends { outcome: string }>(deliver: () => Promise<T>): Promise<T> => {
    try {
      const result = await deliver()
      admit?.settled?.(result.outcome)
      return result
    } catch (error) {
      admit?.settled?.('threw')
      throw error
    }
  }
  return admit
    ? { ...host, admit, ...(admit.note ? { admitNote: admit.note } : {}), settle }
    : { ...host, settle }
}

/** A send that waits before going on (its muted thread's unmute) keeps the wake gate admission and
 *  the carried-automation deferral its dispatch saw, so a settings change meanwhile doesn't change
 *  them; which automations still apply, and their instructions, are read when it goes on. */
export function gateSnapshot<
  Machine extends Pick<ConnectorMachine, 'wakeGate' | 'turnAutomations'> &
    Partial<Pick<ConnectorMachine, 'wakeGateDefers'>>
>(
  machine: Machine,
  delivery: Send,
  later: readonly Send[],
  msLeft: (expiresAt: number) => number
): Machine {
  const admit = machine.wakeGate?.(delivery, later, gateDeadline(delivery, msLeft))
  const deferred = machine.wakeGateDefers?.([
    ...(delivery.automations ?? []),
    ...later.flatMap((next) => next.automations ?? [])
  ])
  return {
    ...machine,
    wakeGate: () => admit,
    turnAutomations: (entries) => machine.turnAutomations?.(entries, deferred) ?? null
  }
}
