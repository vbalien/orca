// A bot's own Slack app's threads never reach Orca Cloud: whatever of theirs comes to the cloud
// connector's event pipeline leaves nothing in any request it sends, while Orca Cloud's own go on.
import { expect, it } from 'vitest'
import { cloudConversation } from '../../shared/connectors/connector-cloud-contract'
import type { ConversationEvent } from '../external-conversations/external-conversation-events'
import { pollClientHarness, settle } from '../connector-cloud/connector-poll-client.test-fixture'
import { replyEventsOf } from '../connector-cloud/connector-reply-outbox'

const h = pollClientHarness()
const SECRET = 'the launch codes are 1234'
const local = { source: 'slack-local', externalId: 'T9:C9:1800000000.000100:U0OWN' } as const
const pane = { conversation: local, worktreeId: 'wt', paneKey: 'tab:local' }

it('sends Orca Cloud nothing of a local thread, and its own threads as before', async () => {
  const { client, emit } = h.startClient()
  await settle()
  const events: ConversationEvent[] = [
    { kind: 'linked', ...pane, agent: 'claude' },
    { kind: 'turn-started', ...pane, at: 5, deliveryId: 'slack-local:T9:C9:1800000000.000100' },
    { kind: 'activity', ...pane, turnId: 5, text: `Reading ${SECRET}` },
    {
      kind: 'prompt',
      ...pane,
      prompt: { kind: 'question', promptId: 'p1', question: SECRET, options: [] }
    },
    { kind: 'workers', ...pane, running: true },
    {
      kind: 'turn-ended',
      ...pane,
      turnId: 5,
      stopReason: 'success',
      at: 9,
      origin: 'delivery',
      lastAssistantMessage: SECRET
    },
    { kind: 'unlinked', ...pane }
  ]
  events.forEach(emit)
  emit({
    kind: 'turn-ended',
    conversation: { source: 'slack', externalId: 'T1:C1:1800000000.000100:U0BOT' },
    worktreeId: 'wt',
    paneKey: 'tab:cloud',
    turnId: 77,
    stopReason: 'success',
    at: 9
  })
  await settle(30_000)
  const sent = JSON.stringify(h.fake.requests.map((request) => request.body))
  expect(sent).not.toContain('slack-local')
  expect(sent).not.toContain(local.externalId)
  expect(sent).not.toContain(SECRET)
  expect(h.fake.events).toContainEqual(expect.objectContaining({ kind: 'turn-ended', turnId: 77 }))
  client.stop()
})

it('names no local thread as a cloud conversation, so no outbox row of one becomes a reply', () => {
  expect(cloudConversation(local)).toBeNull()
  const row = {
    account: 'ada',
    deliveryId: 'd1',
    conversation: local,
    fill: { answerDeliveryId: 'd1', outcome: 'answered' as const, prose: SECRET, filledAt: 1 }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields replyEventsOf reads.
  expect(replyEventsOf([row as unknown as Parameters<typeof replyEventsOf>[0][number]])).toEqual([])
})
