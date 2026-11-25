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

/** The host a start or send is delivered through: one that asks its wake gate first, if any. */
export function gatedHost(
  machine: Pick<ConnectorMachine, 'wakeGate'>,
  host: ExternalConversationHost,
  delivery: ConnectorDelivery,
  later: readonly Send[],
  msLeft: (expiresAt: number) => number
): ExternalConversationHost {
  if (delivery.kind !== 'start' && delivery.kind !== 'send') {
    return host
  }
  const admit = machine.wakeGate?.(delivery, later, gateDeadline(delivery, msLeft))
  return admit ? { ...host, admit } : host
}
