// An allowed start through the real seam and a real chat host: it links its thread, and another
// person's reply queued behind it is decided on that link and reaches the same chat.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type {
  ConnectorConversation,
  ConnectorDelivery
} from '../../shared/connectors/connector-cloud-contract'
import { DeliveryReceipts } from '../external-conversations/external-conversation-delivery-receipts'
import type { ConversationChat } from '../external-conversations/external-conversation-chat'
import type { ExternalConversationHost } from '../external-conversations/external-conversation-host'
import { findLink } from '../external-conversations/external-conversation-links'
import { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import type { decideSlackWake } from '../bots/slack-gate/slack-gate'
import { dispatchDelivery, type DispatchMachine } from './connector-deliveries'
import { createConnectorWakeGate } from './connector-wake-gate'

const THREAD: ConnectorConversation = {
  source: 'slack',
  externalId: 'T1:C1:1800000000.000500:U0BOT'
}
const asker = (
  userId: string,
  ts: string
): NonNullable<Extract<ConnectorDelivery, { kind: 'send' }>['asker']> => ({
  userId,
  role: 'member',
  place: { kind: 'public_channel', id: 'C1' },
  text: `from ${userId}`,
  context: [],
  messageRef: `slack:T1:C1:1800000000.000500:${ts}`
})

let orchestration: OrchestrationDb
let rig: QueuedMessageTestRig | undefined
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-wake-gate-allowed-'))
  orchestration = new OrchestrationDb(join(testState.dir, 'orchestration.db'))
})
afterEach(async () => {
  await rig?.dispose()
  rig = undefined
  orchestration.close()
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

it('links an allowed start, and decides the next reply on that link before it reaches the chat', async () => {
  rig = await createQueuedMessageTestRig({})
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
  const worktreeId = folderWorkspaceKey(folder.id)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real host is what runtimeChatHost hands the seam.
  const chat = rig.host as unknown as ConversationChat
  const host: ExternalConversationHost = {
    chat: { current: () => chat, ensure: async () => chat, onChanged: () => () => {} },
    bots: {
      refusal: () => null,
      open: async () => ({ worktreeId, sessionId: SESSION, agent: 'codex' }),
      workLinks: async () => []
    }
  }
  const receipts = new DeliveryReceipts(() => orchestration)
  const seam = new ExternalConversationSeam({
    store,
    receipts,
    onWorkspaceRemoved: () => () => {},
    readHookRow: () => null,
    onAgentPaneChange: () => () => {}
  })
  const decide = vi.fn<typeof decideSlackWake>(async () => ({
    verdict: 'wake',
    reason: 'passed',
    durationMs: 1
  }))
  const gate = createConnectorWakeGate({
    bots: () => [
      {
        id: 'bot1',
        name: 'Reviewer',
        paused: false,
        slackGate: {
          on: true,
          kind: 'command',
          command: 'check',
          appliesTo: ['mention', 'thread_reply'],
          timeoutSeconds: 5,
          onError: 'block'
        }
      }
    ],
    botsEnabled: () => true,
    linkedBot: (key) => findLink(store, key)?.link.bot?.botId ?? null,
    mentionsKnown: () => true,
    heldStart: (key) => receipts.heldStart(key),
    decide
  })
  const machine: DispatchMachine = { runTrigger: async () => false, wakeGate: gate.wakeGate }
  const deliver = (raw: unknown) => dispatchDelivery(seam, host, machine, raw, () => 60_000)?.done

  const started = deliver({
    kind: 'start',
    deliveryId: 's1',
    expiresAt: 1_900_000_000_000,
    conversation: THREAD,
    agent: 'codex',
    placeId: Buffer.from(JSON.stringify(['bot', 'bot1'])).toString('base64url'),
    prompt: 'from U1',
    asker: asker('U1', '1800000000.000500')
  })
  // Another person's reply, dispatched while the start is still in its lane.
  const replied = deliver({
    kind: 'send',
    deliveryId: 'd1',
    expiresAt: 1_900_000_000_000,
    conversation: THREAD,
    text: 'from U2',
    asker: asker('U2', '1800000000.000600')
  })
  expect(await started).toMatchObject({ outcome: 'accepted' })
  expect(await replied).toMatchObject({ outcome: 'accepted' })
  expect(findLink(store, THREAD)?.link.sessionId).toBe(SESSION)
  expect(decide).toHaveBeenCalledTimes(2)
  expect(decide.mock.calls[1]?.[1]).toMatchObject({ case: 'thread_reply', text: 'from U2' })
  expect(receipts.heldStart(THREAD)).toBe(false)
})
