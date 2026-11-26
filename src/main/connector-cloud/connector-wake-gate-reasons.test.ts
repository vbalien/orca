// Orca Cloud's Slack path end to end through the real code: a start or send goes through
// connector-deliveries' dispatch, the conversation seam and its delivery to the chat, which gets the
// gate's reason with Orca's note, and a limited rule's count is settled by what the chat did (kept
// when taken or when it threw after admission, back when refused). An automation event's run gets the
// reason and the channel-message note in its prompt through the real bot-automation dispatcher, and
// its count goes back when the session refuses it.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { ConnectorDelivery } from '../../shared/connectors/connector-cloud-contract'
import type { AutomationRunEvent } from '../../shared/automation-event-triggers'
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { Bot } from '../../shared/bot-types'
import type { BotSlackGate } from '../../shared/bots/bot-slack-gate'
import { toStoredSlackGate } from '../../shared/bots/slack-gate-store-form'
import { createBotAutomationDispatcher } from '../automations/bot-automation-launch'
import { useBotStateRoot } from '../bots/slack-gate/bot-state-file'
import type { decideSlackWake } from '../bots/slack-gate/slack-gate'
import { SlackGateWakeCounts } from '../bots/slack-gate/slack-gate-wake-counts'
import { ChatDeliveries } from '../external-conversations/external-conversation-chat-delivery'
import { DeliveryReceipts } from '../external-conversations/external-conversation-delivery-receipts'
import type { ExternalConversationHost } from '../external-conversations/external-conversation-host'
import { findLink, writeLink } from '../external-conversations/external-conversation-links'
import { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { dispatchDelivery, type DispatchMachine } from './connector-deliveries'
import { createConnectorWakeGate, type WakeGateBot } from './connector-wake-gate'

// ast-grep-ignore: test-no-wall-clock -- the wake counts here run on the real clock; the test reads the same clock.
const wallNow = () => Date.now()

const THREAD = { source: 'slack' as const, externalId: 'T1:C1:1800000000.000100:U0BOT' }

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a stored gate, as the save RPC keeps it.
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

let counts: SlackGateWakeCounts
let orchestration: OrchestrationDb
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'cloud-reasons-'))
  useBotStateRoot(testState.dir)
  orchestration = new OrchestrationDb(join(testState.dir, 'orchestration.db'))
  counts = new SlackGateWakeCounts({ now: Date.now, warn: () => {} })
})
afterEach(async () => {
  vi.restoreAllMocks()
  useBotStateRoot(null)
  orchestration.close()
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

/** Wakes on the limited rule while it is open, reserving its count as the real gate does. */
const reserving: typeof decideSlackWake = async (_bot, event, options) => {
  const loaded = await counts.load('b1', 0)
  if (!counts.open(loaded, event.channelId, 'banter', { perDay: 1 }, wallNow())) {
    return { verdict: 'block', reason: 'rate_limited', durationMs: 1 }
  }
  const reservation = counts.reserve(loaded, {
    channelId: event.channelId,
    question: 'banter',
    at: wallNow(),
    ...options?.run
  })
  if (!reservation || !(await reservation.persisted)) {
    return { verdict: 'block', reason: 'rate_limited', durationMs: 1 }
  }
  return {
    verdict: 'wake',
    reason: 'passed',
    durationMs: 1,
    wakeReason: { text: 'banter: join briefly', from: 'rules' },
    reservation
  }
}
const open = async () =>
  counts.open(await counts.load('b1', 0), 'C1', 'banter', { perDay: 1 }, wallNow())

/** A bot home with THREAD linked to b1's chat, the real seam, and dispatch with the wake gate. */
async function cloud() {
  const store = createStore()
  const group = store.createProjectGroup({
    name: 'Bots',
    parentPath: testState.dir,
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'manual'
  })
  const folder = store.createFolderWorkspace({
    projectGroupId: group.id,
    folderPath: testState.dir
  })
  writeLink(
    store,
    { worktreeId: folderWorkspaceKey(folder.id), sshHostId: null },
    {
      ...THREAD,
      sessionId: 'session-b1',
      agent: 'claude',
      paneKey: 'pane-1',
      bot: { kind: 'bot', botId: 'b1' },
      createdAt: 1
    }
  )
  await store.flushPendingOrThrowAsync()
  const receipts = new DeliveryReceipts(() => orchestration)
  const seam = new ExternalConversationSeam({
    store,
    receipts,
    onWorkspaceRemoved: () => () => {},
    readHookRow: () => null,
    onAgentPaneChange: () => () => {}
  })
  const host: ExternalConversationHost = {
    bots: {
      refusal: () => null,
      open: async () => {
        throw new Error('the thread is linked')
      },
      workLinks: async () => []
    }
  }
  const gate = createConnectorWakeGate({
    bots: () => [bot],
    botsEnabled: () => true,
    linkedBot: (key) => findLink(store, key)?.link.bot?.botId ?? null,
    mentionsKnown: () => true,
    heldStart: (key) => receipts.heldStart(key),
    decide: reserving,
    counts
  })
  const machine: DispatchMachine = { runTrigger: async () => false, wakeGate: gate.wakeGate }
  let n = 0
  const send = () =>
    dispatchDelivery(
      seam,
      host,
      machine,
      {
        kind: 'send',
        deliveryId: `d${++n}`,
        expiresAt: wallNow() + 60_000,
        conversation: THREAD,
        text: 'ha, nice',
        asker: {
          userId: 'U1',
          role: 'member',
          place: { kind: 'public_channel', id: 'C1' },
          text: 'ha, nice',
          context: [],
          messageRef: `slack:T1:C1:1800000000.00020${n}:1800000000.000100`
        }
      } satisfies Extract<ConnectorDelivery, { kind: 'send' }>,
      () => 60_000
    )?.done
  return { send }
}

it('tells the chat the gate’s reason, and settles the count by what the chat did', async () => {
  const notes: (string | undefined)[] = []
  const chat = vi.spyOn(ChatDeliveries.prototype, 'deliver')
  const { send } = await cloud()
  // Refused by the chat: nothing woke, the count goes back.
  chat.mockImplementationOnce(async (_chats, _key, _chat, message) => {
    notes.push(message.note)
    return { outcome: 'refused', reason: 'agent_not_reachable' }
  })
  await send()
  expect(notes[0]).toContain('banter: join briefly')
  expect(await open()).toBe(true)
  // Threw after the gate let it through: it may have woken the bot, so it counts.
  chat.mockImplementationOnce(async () => {
    throw new Error('lost on the way')
  })
  await send()
  expect(await open()).toBe(false)
})

it('puts the reason and the channel-message note in an automation run’s prompt, and gives the count back when the session refuses it', async () => {
  const gate = createConnectorWakeGate({
    bots: () => [bot],
    botsEnabled: () => true,
    linkedBot: () => 'b1',
    mentionsKnown: () => true,
    heldStart: () => false,
    decide: reserving,
    counts,
    runsOf: () => new Map()
  })
  const conversation = { source: 'slack' as const, externalId: 'T1:C1:1800000000.000300' }
  const runEvent: AutomationRunEvent = {
    triggerId: 'r1',
    source: 'slack',
    event: 'message',
    key: 'k1',
    occurredAt: 1,
    conversation
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fields the gate and the dispatcher read.
  const automation = {
    id: 'auto1',
    name: 'Watch the channel',
    prompt: 'Help if it is yours.',
    bot: { botId: 'b1', resultsTo: 'chat' },
    on: [{ id: 'r1', source: 'slack', event: 'message' }]
  } as unknown as Automation
  const event = (deliveryId: string) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fields the gate reads of a trigger.
    ({
      kind: 'trigger',
      deliveryId,
      expiresAt: wallNow() + 60_000,
      conversation,
      automationId: 'auto1',
      triggerId: 'r1',
      botId: 'b1',
      event: { key: deliveryId, actorId: 'U1', occurredAt: 1, text: 'anyone up for lunch?' }
    }) as unknown as Extract<ConnectorDelivery, { kind: 'trigger' }>
  const reserveRun = async (deliveryId: string) => {
    const admitted = gate.triggerGate(event(deliveryId), runEvent, undefined, () => {})!
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a passed event answers its run id.
    const { runId } = (await admitted.reserve(automation)) as { runId: string }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fields the dispatcher reads of a run.
    const run = { id: runId, trigger: 'event', event: runEvent, title: 'Lunch' } as AutomationRun
    admitted.created(run)
    return run
  }
  const prompts: string[] = []
  const refuse = { now: false }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bot's fields the dispatcher reads.
  const target = { bot: { ...bot, members: [] } as unknown as Bot, runsIn: 'chat' as const }
  const dispatch = createBotAutomationDispatcher(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the bot's Chat is used here.
    {
      sendToChat: async (_bot: Bot, text: string) => {
        prompts.push(text)
        if (refuse.now) {
          throw new Error('the session refused the prompt')
        }
        return { sessionId: 'chat-1' }
      }
    } as unknown as Parameters<typeof createBotAutomationDispatcher>[0],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no turn is watched to its end here.
    {
      watch: async () => ({ dispose: () => {}, ended: new Promise(() => {}) }),
      deliver: async () => ({}),
      couldNotStart: () => {}
    } as unknown as Parameters<typeof createBotAutomationDispatcher>[1]
  )
  refuse.now = true
  await expect(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launcher's input as the run service gives it.
    dispatch({ automation, run: await reserveRun('t1'), target } as never)
  ).rejects.toThrow('refused')
  expect(prompts[0]).toContain('banter: join briefly')
  expect(prompts[0]).toContain('was not addressed to you')
  // The session refused it: no turn began, so the next event may wake.
  expect(await open()).toBe(true)
})
