// Limits and reasons on Orca Cloud's Slack path: a start or send keeps a limited rule's count only when
// its delivery was taken (or threw after the gate let it through), and tells the chat the gate's reason;
// an automation event's count stays while its run is made, goes back when it can't be, and a count a
// past run left is settled by that run's record: skipped never woke the bot, anything else may have.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ConnectorDelivery } from '../../shared/connectors/connector-cloud-contract'
import type { AutomationRunEvent } from '../../shared/automation-event-triggers'
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { BotSlackGate } from '../../shared/bots/bot-slack-gate'
import { toStoredSlackGate } from '../../shared/bots/slack-gate-store-form'
import { BotStateFile, useBotStateRoot } from '../bots/slack-gate/bot-state-file'
import type { decideSlackWake } from '../bots/slack-gate/slack-gate'
import { takeSlackGateRun } from '../bots/slack-gate/slack-gate-runs'
import { SlackGateWakeCounts } from '../bots/slack-gate/slack-gate-wake-counts'
import { createConnectorWakeGate, type WakeGateBot } from './connector-wake-gate'

// ast-grep-ignore: test-no-wall-clock -- the shared wake counts and decider run on the real clock (Date.now); the test reads the same clock.
const wallNow = () => Date.now()

let counts: SlackGateWakeCounts
beforeEach(() => {
  useBotStateRoot(mkdtempSync(join(tmpdir(), 'cloud-limits-')))
  counts = new SlackGateWakeCounts({ now: Date.now, warn: () => {} })
})
afterEach(() => useBotStateRoot(null))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture: only the fields the gate reads are set.
const limitedGate = toStoredSlackGate({
  on: true,
  kind: 'openai',
  appliesTo: ['thread_reply', 'trigger'],
  timeoutSeconds: 5,
  onError: 'wake',
  openai: {
    questions: [{ type: 'predicate', name: 'banter', instructions: 'Banter?' }],
    rules: [
      { question: 'banter', wakeIf: { atLeast: 0.9 }, limit: { perDay: 1 }, note: 'join briefly' }
    ]
  }
}) as BotSlackGate
const bot: WakeGateBot = { id: 'b1', name: 'Bot', paused: false, slackGate: limitedGate }

/** A decision that wakes on the limited rule, reserving its count like the real gate. */
const reserving =
  (seen: string[] = []): typeof decideSlackWake =>
  async (_bot, event, options) => {
    seen.push(event.case)
    const loaded = await counts.load('b1', 0)
    if (!counts.open(loaded, event.channelId, 'banter', { perDay: 1 }, wallNow())) {
      return { verdict: 'block', reason: 'rate_limited', durationMs: 1 }
    }
    const reservation = counts.reserve(loaded, {
      channelId: event.channelId,
      question: 'banter',
      at: wallNow(),
      ...options?.run
    })!
    await reservation.persisted
    return {
      verdict: 'wake',
      reason: 'passed',
      durationMs: 1,
      wakeReason: { text: 'banter: join briefly', from: 'rules' },
      reservation
    }
  }

const runs = new Map<string, AutomationRun[]>()
const wakeGate = (decide: typeof decideSlackWake) =>
  createConnectorWakeGate({
    bots: () => [bot],
    botsEnabled: () => true,
    linkedBot: () => 'b1',
    mentionsKnown: () => true,
    heldStart: () => false,
    decide,
    counts,
    runsOf: (ids) => new Map(ids.map((id) => [id, runs.get(id) ?? []]))
  })

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture: only the fields the gate reads are set.
const send: Extract<ConnectorDelivery, { kind: 'send' }> = {
  kind: 'send',
  deliveryId: 'd1',
  expiresAt: wallNow() + 60_000,
  conversation: { source: 'slack', externalId: 'T1:C1:1800000000.000100:UBOT' },
  text: 'ha, nice'
} as Extract<ConnectorDelivery, { kind: 'send' }>
const open = async () =>
  counts.open(await counts.load('b1', 0), 'C1', 'banter', { perDay: 1 }, wallNow())

it('keeps a start or send’s count only when the delivery was taken, and tells the chat why', async () => {
  const gate = wakeGate(reserving())
  const refused = gate.wakeGate(send, [], wallNow() + 30_000)!
  expect(await refused(new AbortController().signal, { botId: 'b1' })).toBeNull()
  expect(refused.note()).toContain('banter: join briefly')
  refused.settled('refused')
  expect(await open()).toBe(true)
  const thrown = gate.wakeGate({ ...send, deliveryId: 'd2' }, [], wallNow() + 30_000)!
  await thrown(new AbortController().signal, { botId: 'b1' })
  // It threw after the gate let it through: it may have woken the bot, so it counts.
  thrown.settled('threw')
  expect(await open()).toBe(false)
})

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture: only the fields the gate reads are set.
const automation = {
  id: 'auto1',
  bot: { botId: 'b1' },
  on: [{ id: 'r1', source: 'slack', event: 'message' }]
} as unknown as Automation
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture: only the fields the gate reads are set.
const trigger = {
  kind: 'trigger',
  deliveryId: 't1',
  expiresAt: wallNow() + 60_000,
  conversation: { source: 'slack', externalId: 'T1:C1:1800000000.000200' },
  automationId: 'auto1',
  triggerId: 'r1',
  botId: 'b1',
  event: { key: 'k1', actorId: 'U1', occurredAt: 1, text: 'hey all' }
} as unknown as Extract<ConnectorDelivery, { kind: 'trigger' }>
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture: only the fields the gate reads are set.
const runEvent = {
  triggerId: 'r1',
  source: 'slack',
  event: 'message',
  key: 'k1',
  occurredAt: 1,
  conversation: trigger.conversation
} as AutomationRunEvent

it('gives an automation event’s count back when its run can’t be made, and settles it by the prompt', async () => {
  const gate = wakeGate(reserving())
  const failing = gate.triggerGate(trigger, runEvent, undefined, () => {})!
  const reserved = await failing.reserve(automation)
  expect(reserved).toMatchObject({ event: runEvent })
  failing.failed?.()
  expect(await open()).toBe(true)
  // Made and started: the prompt has the reason, and the count is kept once the prompt was taken.
  const starting = gate.triggerGate(
    { ...trigger, deliveryId: 't2' },
    runEvent,
    undefined,
    () => {}
  )!
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture: only the fields the gate reads are set.
  const started = (await starting.reserve(automation)) as { runId: string }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture: only the fields the gate reads are set.
  starting.created({ id: started.runId } as AutomationRun)
  const run = takeSlackGateRun(started.runId)
  expect(run.note).toContain('banter: join briefly')
  run.started()
  expect(await open()).toBe(false)
})

it('settles a count a past run left by that run’s record: skipped goes back, dispatched stays', async () => {
  // The last process reserved for two runs and stopped before settling them.
  const before = new SlackGateWakeCounts({ now: Date.now, warn: () => {} })
  const loaded = await before.load('b1', 0)
  for (const runId of ['skipped-run', 'dispatched-run']) {
    const reservation = before.reserve(loaded, {
      channelId: `C-${runId}`,
      question: 'banter',
      at: wallNow(),
      automationId: 'auto1',
      runId
    })!
    reservation.creating = false
    await reservation.persisted
  }
  runs.set('auto1', [
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture: only the fields the gate reads are set.
    { id: 'skipped-run', status: 'skipped_unavailable' } as AutomationRun,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture: only the fields the gate reads are set.
    { id: 'dispatched-run', status: 'dispatched' } as AutomationRun
  ])
  const gate = wakeGate(reserving())
  // The next event asks the gate, which settles what the last process left first.
  await gate
    .triggerGate({ ...trigger, deliveryId: 't3' }, runEvent, undefined, () => {})!
    .reserve(automation)
  const after = await counts.load('b1', 0)
  expect(counts.open(after, 'C-skipped-run', 'banter', { perDay: 1 }, wallNow())).toBe(true)
  expect(counts.open(after, 'C-dispatched-run', 'banter', { perDay: 1 }, wallNow())).toBe(false)
})

it('holds limited rules for the gate’s longest cooldown when an automation event finds the counts file unreadable', async () => {
  const file = new BotStateFile('bot-slack-gate-wakes', 'b1')
  mkdirSync(join(file.path, '..'), { recursive: true })
  writeFileSync(file.path, 'not json')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture: only the fields the gate reads are set.
  const weekly = toStoredSlackGate({
    on: true,
    kind: 'openai',
    appliesTo: ['trigger'],
    timeoutSeconds: 5,
    onError: 'wake',
    openai: {
      questions: [{ type: 'predicate', name: 'banter', instructions: 'Banter?' }],
      rules: [{ question: 'banter', wakeIf: { atLeast: 0.9 }, limit: { cooldownMinutes: 10_080 } }]
    }
  }) as BotSlackGate
  const gate = createConnectorWakeGate({
    bots: () => [{ ...bot, slackGate: weekly }],
    botsEnabled: () => true,
    linkedBot: () => 'b1',
    mentionsKnown: () => true,
    heldStart: () => false,
    decide: async () => ({ verdict: 'block', reason: 'blocked', durationMs: 1 }),
    counts,
    runsOf: () => new Map()
  })
  await gate
    .triggerGate({ ...trigger, deliveryId: 't9' }, runEvent, undefined, () => {})!
    .reserve(automation)
  const { heldUntil } = await counts.pendingStatus('b1')
  expect(typeof heldUntil).toBe('number')
  expect(Number(heldUntil)).toBeGreaterThanOrEqual(wallNow() + 10_079 * 60_000)
})
