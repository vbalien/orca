// Automation events and the Slack wake gate: a carried automation is left to the trigger gate, a
// blocked trigger is skipped without its words, and an expired one is answered expired.
import { describe, expect, it, vi } from 'vitest'
import type { ConnectorDelivery } from '../../shared/connectors/connector-cloud-contract'
import type { AutomationRunEvent } from '../../shared/automation-event-triggers'
import type { Automation } from '../../shared/automations/automation-definition'
import type { BotSlackGate } from '../../shared/bots/bot-slack-gate'
import type { decideSlackWake, SlackWakeDecision } from '../bots/slack-gate/slack-gate'
import { dispatchDelivery, type DispatchMachine } from './connector-deliveries'
import { triggerRunEvent } from './connector-triggers'
import { createConnectorWakeGate, type WakeGateBot } from './connector-wake-gate'
import { fakeSeam } from './fake-connector-seam.test-fixture'

type Trigger = Extract<ConnectorDelivery, { kind: 'trigger' }>

const gate = (appliesTo: BotSlackGate['appliesTo']): BotSlackGate => ({
  on: true,
  kind: 'command',
  appliesTo,
  timeoutSeconds: 5,
  onError: 'wake',
  command: 'should-the-bot-run'
})
const bots: WakeGateBot[] = [
  { id: 'slackBot', name: 'S', paused: false, slackGate: gate(['trigger']) },
  { id: 'linearBot', name: 'L', paused: false, slackGate: gate(['trigger']) },
  { id: 'plainBot', name: 'P', paused: false, slackGate: gate(['thread_reply']) }
]
const rule = (id: string, botId: string, source: 'slack' | 'linear') =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: triggerRunEvent reads only id, bot and on.
  ({
    id,
    bot: { botId },
    on: [{ id: `${id}-rule`, source, event: 'message' }]
  }) as unknown as Automation
const automations = [
  rule('slackAuto', 'slackBot', 'slack'),
  rule('linearAuto', 'linearBot', 'linear'),
  rule('plainAuto', 'plainBot', 'slack')
]
const entry = (automationId: string, botId: string) => ({
  automationId,
  triggerId: `${automationId}-rule`,
  botId,
  event: { key: `k-${automationId}`, actorId: 'U1', occurredAt: 1 }
})
const sourceOf = (item: ReturnType<typeof entry>) =>
  triggerRunEvent(automations, bots, item)?.source

const decision = (fields: Partial<SlackWakeDecision>): SlackWakeDecision => ({
  verdict: 'block',
  reason: 'blocked',
  durationMs: 3,
  ...fields
})
const wakeGate = (decide: typeof decideSlackWake) =>
  createConnectorWakeGate({
    bots: () => bots,
    botsEnabled: () => true,
    linkedBot: () => null,
    mentionsKnown: () => true,
    heldStart: () => false,
    decide
  })

const trigger: Trigger = {
  kind: 'trigger',
  deliveryId: 'tr1',
  expiresAt: 1_900_000_000_000,
  conversation: { source: 'slack', externalId: 'T1:C1:1800000000.000100' },
  automationId: 'slackAuto',
  triggerId: 'slackAuto-rule',
  botId: 'slackBot',
  event: { key: 'k1', actorId: 'U1', occurredAt: 1, text: 'private words' }
}
const runEvent: AutomationRunEvent = {
  triggerId: 'slackAuto-rule',
  source: 'slack',
  event: 'message',
  key: 'k1',
  occurredAt: 1,
  actorId: 'U1',
  text: 'private words'
}

describe('carried automations', () => {
  it('leave the whole turn list to the trigger gate when a Slack one is gated, Linear alone never', () => {
    const gated = wakeGate(vi.fn<typeof decideSlackWake>())
    expect(gated.defersCarried([entry('slackAuto', 'slackBot')], sourceOf)).toBe(true)
    expect(
      gated.defersCarried(
        [entry('linearAuto', 'linearBot'), entry('slackAuto', 'slackBot')],
        sourceOf
      )
    ).toBe(true)
    expect(gated.defersCarried([entry('linearAuto', 'linearBot')], sourceOf)).toBe(false)
    expect(gated.defersCarried([entry('plainAuto', 'plainBot')], sourceOf)).toBe(false)
  })
})

describe('a send that waits on its muted thread', () => {
  it('keeps the wake gate its dispatch saw when it goes on', async () => {
    const { seam, calls } = fakeSeam()
    const admitted = vi.fn(async () => null)
    const wakeGate = vi.fn<NonNullable<DispatchMachine['wakeGate']>>(() => admitted)
    let decide: (step: 'send') => void = () => {}
    const decided = new Promise<'send'>((resolve) => (decide = resolve))
    // At dispatch the carried automation is left to its trigger gate; asked again after the wait it
    // would ride the turn, as if the gate had been turned off meanwhile.
    const wakeGateDefers = vi
      .fn<(entries: readonly unknown[]) => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValue(false)
    // Which automations apply, and their instructions, are still read when the send goes on.
    const turnAutomations = vi.fn<NonNullable<DispatchMachine['turnAutomations']>>(
      (_entries, deferred) =>
        deferred ? null : { note: 'run the automation in this turn', record: async () => {} }
    )
    const machine: DispatchMachine = {
      runTrigger: async () => false,
      wakeGate,
      turnAutomations,
      threadMute: () => ({ decided })
    }
    Object.assign(machine, { wakeGateDefers })
    const send: Extract<ConnectorDelivery, { kind: 'send' }> = {
      kind: 'send',
      deliveryId: 'd1',
      expiresAt: 1_900_000_000_000,
      conversation: { source: 'slack', externalId: 'T1:C1:1800000000.000100:U0BOT' },
      text: 'hi',
      automations: [
        {
          automationId: 'slackAuto',
          triggerId: 'slackAuto-rule',
          botId: 'slackBot',
          event: { key: 'k-carried', actorId: 'U1', occurredAt: 1 }
        }
      ]
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake seam never reads its host.
    const host = {} as Parameters<typeof dispatchDelivery>[1]
    const dispatched = dispatchDelivery(seam, host, machine, send, () => 60_000)
    expect(wakeGate).toHaveBeenCalledTimes(1)
    decide('send')
    await dispatched?.done
    // Not asked again at redispatch: the admission handed to the seam is the dispatch-time one.
    expect(wakeGate).toHaveBeenCalledTimes(1)
    expect(calls.send.mock.calls[0]?.[0]).toMatchObject({ admit: admitted })
    expect(wakeGateDefers).toHaveBeenCalledTimes(1)
    expect(turnAutomations).toHaveBeenCalledWith(expect.any(Array), true)
    expect(calls.send.mock.lastCall).not.toContainEqual(
      expect.objectContaining({ note: expect.anything() })
    )
  })
})

describe('the trigger gate', () => {
  it('skips a blocked event with a precheck-shaped record that holds no words', async () => {
    const decide = vi.fn<typeof decideSlackWake>(async () => decision({ exitCode: 1 }))
    const start = wakeGate(decide).triggerGate(trigger, runEvent, undefined, () => {})
    const reserved = await start?.reserve(rule('slackAuto', 'slackBot', 'slack'))
    expect(reserved).toMatchObject({
      skipped: {
        error: 'Slack wake gate blocked this event.',
        precheckResult: {
          command: 'Slack wake gate (command)',
          stdout: '',
          stderr: '',
          exitCode: 1
        }
      }
    })
    expect(JSON.stringify(reserved)).not.toContain('private words')
    expect(decide.mock.calls[0]?.[1]).toMatchObject({ case: 'trigger', text: 'private words' })
  })

  it('wakes on a pass, and reports expiry without a run', async () => {
    const pass = wakeGate(async () => decision({ verdict: 'wake', reason: 'passed' }))
    expect(
      await pass
        .triggerGate(trigger, runEvent, undefined, () => {})
        ?.reserve(rule('a', 'b', 'slack'))
    ).toMatchObject({ event: runEvent })
    const onExpired = vi.fn()
    const late = wakeGate(async () => decision({ reason: 'expired' }))
    expect(
      await late
        .triggerGate(trigger, runEvent, undefined, onExpired)
        ?.reserve(rule('a', 'b', 'slack'))
    ).toEqual({ refused: true })
    expect(onExpired).toHaveBeenCalled()
  })

  it('leaves Linear and ungated bots alone', () => {
    const gated = wakeGate(vi.fn<typeof decideSlackWake>())
    expect(
      gated.triggerGate({ ...trigger, botId: 'plainBot' }, runEvent, undefined, () => {})
    ).toBeUndefined()
    expect(
      gated.triggerGate(trigger, { ...runEvent, source: 'linear' }, undefined, () => {})
    ).toBeUndefined()
  })

  it('answers an expired trigger delivery expired', async () => {
    const { seam } = fakeSeam()
    const machine: DispatchMachine = { runTrigger: async () => 'expired' }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a trigger never reads its host.
    const host = {} as Parameters<typeof dispatchDelivery>[1]
    const dispatched = dispatchDelivery(seam, host, machine, trigger, () => 60_000)
    expect(await dispatched?.done).toEqual({ outcome: 'expired' })
  })
})
