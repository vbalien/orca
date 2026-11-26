// A Slack automation event whose delivery runs out of time in its automation's lane or during its
// wake gate: nothing launches, nothing is written, and the cloud is told it expired.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ConnectorDelivery } from '../../shared/connectors/connector-cloud-contract'
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { PersistedState } from '../../shared/orca-profiles/persisted-state-types'
import { createAutomationRun } from '../persistence/scheduling-automations/automation-run-operations'
import {
  runForEvent,
  type AutomationTriggerRunContext
} from '../automations/automation-trigger-runs'
import type { decideSlackWake } from '../bots/slack-gate/slack-gate'
import { ConnectorDeliveryAcks } from './connector-delivery-acks'
import { runTriggerDelivery } from './connector-triggers'
import { createConnectorWakeGate } from './connector-wake-gate'
import { fakeMachine, fakeSeam } from './fake-connector-seam.test-fixture'

const NOW = 1_800_000_000_000
beforeEach(() => {
  // Only the clock is fixed; the lane's promises and the acks' sender run for real.
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: admission reads only these automation fields.
const automation = {
  id: 'a1',
  name: 'Triage',
  enabled: true,
  createdAt: 0,
  missedRunGraceMinutes: 60,
  workspaceId: 'w1',
  bot: { botId: 'bot1' },
  on: [{ id: 'r1', source: 'slack', event: 'message' }]
} as unknown as Automation
const bots = [
  {
    id: 'bot1',
    name: 'B',
    paused: false,
    slackGate: {
      on: true,
      kind: 'command' as const,
      appliesTo: ['trigger' as const],
      timeoutSeconds: 5,
      onError: 'wake' as const,
      command: 'should-the-bot-run'
    }
  }
]
const trigger: Extract<ConnectorDelivery, { kind: 'trigger' }> = {
  kind: 'trigger',
  deliveryId: 'tr1',
  expiresAt: 1_900_000_000_000,
  conversation: { source: 'slack', externalId: 'T1:C1:1800000000.000100' },
  automationId: 'a1',
  triggerId: 'r1',
  botId: 'bot1',
  event: { key: 'k1', actorId: 'U1', occurredAt: NOW, text: 'private words' }
}

/** The automation's lane holds the event until `release`; its runs are the real run rows. */
function automationLane() {
  const state: { automationRuns?: AutomationRun[] } = { automationRuns: [] }
  const operations = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: run creation reads only automationRuns.
    state: state as PersistedState,
    flush: () => {},
    recordManualRun: () => {},
    getWorkspaceDisplayName: () => null
  }
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  const launched = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: event admission calls only these members.
  const ctx = {
    store: {
      listAutomations: () => [automation],
      listAutomationRuns: () => state.automationRuns ?? [],
      getLatestAutomationOccurrence: () => null
    },
    runs: {
      createRun: async (
        ...args: Parameters<typeof createAutomationRun> extends [unknown, ...infer R] ? R : never
      ) => createAutomationRun(operations, ...args),
      repeatSkip: async () => null,
      foldEvent: async () => null
    },
    wakeGateDelayMs: 0,
    inLane: async (_id: string, operation: () => Promise<unknown>) => {
      await held
      return operation()
    },
    describeRefusal: async () => null,
    resolveTarget: () => ({ ok: true }),
    dispatch: launched,
    launch: launched,
    once: null
  } as unknown as AutomationTriggerRunContext
  return { ctx, release, launched, runs: () => state.automationRuns ?? [] }
}

/** Orca's trigger path as the connector installs it, its acks sent to `sent`. */
function connector(decide: typeof decideSlackWake) {
  const lane = automationLane()
  const wakeGate = createConnectorWakeGate({
    bots: () => bots,
    botsEnabled: () => true,
    linkedBot: () => null,
    mentionsKnown: () => true,
    heldStart: () => false,
    decide
  })
  const sent: unknown[] = []
  const acks = new ConnectorDeliveryAcks({
    seam: fakeSeam().seam,
    host: {},
    machine: {
      ...fakeMachine(() => null),
      runTrigger: async (delivery, deadlineAt) => {
        let expired = false
        const ran = await runTriggerDelivery(
          {
            automations: [automation],
            bots,
            webhook: () => false,
            run: (id, event) =>
              runForEvent(
                lane.ctx,
                id,
                event,
                wakeGate.triggerGate(delivery, event, deadlineAt, () => (expired = true))
              )
          },
          delivery
        )
        return expired ? 'expired' : ran
      }
    },
    send: async (batch) => {
      sent.push(...batch)
      return null
    },
    helloRev: () => 1,
    random: () => 0,
    signal: new AbortController().signal
  })
  return { ...lane, acks, sent }
}

it('expires an event whose deadline passes while it waits in its automation lane', async () => {
  const decide = vi.fn<typeof decideSlackWake>()
  const { acks, sent, release, runs, launched } = connector(decide)
  acks.deliverAll([trigger], () => 60_000)
  vi.setSystemTime(NOW + 60_000)
  release()
  await vi.waitFor(() => expect(sent).toHaveLength(1))
  expect(sent).toEqual([{ deliveryId: 'tr1', step: 'done', result: { outcome: 'expired' } }])
  expect(decide).not.toHaveBeenCalled()
  expect(runs()).toEqual([])
  expect(launched).not.toHaveBeenCalled()
})

it('expires an event whose deadline passes while its gate decides', async () => {
  const decide = vi.fn<typeof decideSlackWake>(async () => {
    vi.setSystemTime(NOW + 60_000)
    return { verdict: 'block', reason: 'blocked', durationMs: 60_000 }
  })
  const { acks, sent, release, runs, launched } = connector(decide)
  acks.deliverAll([trigger], () => 60_000)
  release()
  await vi.waitFor(() => expect(sent).toHaveLength(1))
  expect(sent).toEqual([{ deliveryId: 'tr1', step: 'done', result: { outcome: 'expired' } }])
  expect(decide).toHaveBeenCalledTimes(1)
  expect(runs()).toEqual([])
  expect(launched).not.toHaveBeenCalled()
})
