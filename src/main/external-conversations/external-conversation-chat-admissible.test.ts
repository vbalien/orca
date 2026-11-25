import { afterEach, expect, it, vi } from 'vitest'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import { ChatDeliveries, type LinkableChat } from './external-conversation-chat-delivery'
import type { ConversationChat, ConversationChatHost } from './external-conversation-chat'

// The real chat host and journal: a slack-local delivery is asked once more whether its asker may
// still ask at the moment the chat takes it.
const KEY = { source: 'slack-local' as const, externalId: 'T1:C1:1.2' }
const CHAT: LinkableChat = {
  worktreeId: 'home',
  sessionId: SESSION,
  agent: 'codex',
  bot: { kind: 'bot', botId: 'bot-1' }
}
let rig: QueuedMessageTestRig | undefined
afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

/** The host as the seam reads it; `before` runs just before the chat takes the send. */
function chatHost(host: StructuredAgentSessionHost, before: () => void): ConversationChatHost {
  const view: StructuredAgentSessionHost = Object.create(host)
  view.send = async (...args) => {
    before()
    return host.send(...args)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real host is what runtimeChatHost hands the seam.
  const chat = view as unknown as ConversationChat
  return { current: () => chat, ensure: async () => chat, onChanged: () => () => {} }
}

async function sentCount(): Promise<number> {
  return (await (await rig!.host.conversation(SESSION)).journal.reads.sendFingerprints()).length
}

it('refuses a delivery whose asker lost access after it was dispatched, and sends nothing', async () => {
  rig = await createQueuedMessageTestRig()
  let allowed = true
  const outcome = await new ChatDeliveries(vi.fn()).deliver(
    chatHost(rig.host, () => (allowed = false)),
    KEY,
    CHAT,
    {
      text: 'hi',
      deliveryId: 'd-revoked',
      signal: new AbortController().signal,
      admissible: () => allowed
    }
  )
  expect(outcome.outcome).toBe('refused')
  expect(await sentCount()).toBe(0)
})

it('sends a delivery whose asker may still ask', async () => {
  rig = await createQueuedMessageTestRig()
  const outcome = await new ChatDeliveries(vi.fn()).deliver(
    chatHost(rig.host, () => {}),
    KEY,
    CHAT,
    {
      text: 'hi',
      deliveryId: 'd-allowed',
      signal: new AbortController().signal,
      admissible: () => true
    }
  )
  expect(outcome).toEqual({ outcome: 'accepted' })
  expect(await sentCount()).toBe(1)
})
