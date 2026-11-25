// A bot's own Slack app's threads and Orca Cloud's are told apart by audience: neither side's events,
// mirror state or delivery marks reach the other, and an Orca account reset leaves local turns whole.
import { expect, it, vi } from 'vitest'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { chatPaneKey, type ChatNews, type ConversationChatHost } from './external-conversation-chat'
import { ChatDeliveries } from './external-conversation-chat-delivery'
import type { EndedChatTurn } from './external-conversation-ended-turn'
import {
  ConversationEvents,
  type ConversationEvent,
  type ConversationEventsDeps,
  type ConversationSnapshot
} from './external-conversation-events'
import type { ExternalConversationLinkStore } from './external-conversation-links'
import { ExternalConversationSeam } from './external-conversation-seam'
import { SlackLocalReplies } from '../slack-local/slack-local-replies'

const ANSWER = 'The deploy is green.'
import { isLocalSlackConversation } from '../../shared/connectors/local-slack-conversation'

const cloudLink: ExternalConversationLink = {
  source: 'slack',
  externalId: 'T1:C1:1800000000.000100:U0BOT',
  sessionId: 'chat-cloud',
  agent: 'claude',
  paneKey: chatPaneKey('chat-cloud'),
  bot: { kind: 'bot', botId: 'cloud-bot' },
  createdAt: 1
}
const localLink: ExternalConversationLink = {
  source: 'slack-local',
  externalId: 'T2:C2:1800000000.000200:U0OWN',
  sessionId: 'chat-local',
  agent: 'claude',
  paneKey: chatPaneKey('chat-local'),
  bot: { kind: 'bot', botId: 'local-bot' },
  createdAt: 1
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the link readers use only these members.
const store = {
  getRepos: () => [],
  getAllWorktreeMeta: () => ({ wt: { externalConversations: [cloudLink, localLink] } }),
  getFolderWorkspaces: () => []
} as unknown as ExternalConversationLinkStore

function audience(local: boolean, deliveries: ChatDeliveries, mirrorTurn?: () => null) {
  let news: ((news: ChatNews) => void) | null = null
  const seen: (ConversationEvent | ConversationSnapshot)[] = []
  const deps: ConversationEventsDeps = {
    store,
    readHookRow: () => null,
    onAgentPaneChange: () => () => {},
    pendingPrompt: () => null,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test bot needs only the fields the events read.
    promptStanding: () => 'unknown' as never,
    onChatNews: (listener) => {
      news = listener
      return () => {
        news = null
      }
    },
    chatTurnOrigin: (sessionId, turnAt) => deliveries.origin(sessionId, turnAt),
    chatTurnDelivered: (sessionId) => deliveries.pending(sessionId),
    chatTurnDelivery: (sessionId, turnAt) => deliveries.started(sessionId, turnAt),
    chatTurnWaiting: (sessionId) => deliveries.waiting(sessionId),
    runningTurnReported: () => false,
    workLinks: async () => [],
    workerActivities: async () => null,
    promptsAudience: () => false,
    turnOpener: () => null,
    setTimer: () => ({ cancel: () => {} }),
    now: () => 10,
    audience: (link) => isLocalSlackConversation(link) === local,
    ...(mirrorTurn ? { mirrorTurn } : {})
  }
  const events = new ConversationEvents(deps)
  events.watch((event) => seen.push(event))
  return {
    events,
    seen,
    turnEnded: (sessionId: string, turn: EndedChatTurn) =>
      news?.({
        kind: 'turn-ended',
        sessionId,
        outcome: 'success',
        readTurn: async () => turn,
        at: 20
      })
  }
}

const turnEnds = (seen: readonly (ConversationEvent | ConversationSnapshot)[]) =>
  seen.filter((event) => event.kind === 'turn-ended')

it('keeps each audience to its own conversations, mirror state included', async () => {
  const mirrorTurn = vi.fn(() => null)
  const local = audience(true, new ChatDeliveries(() => {}, 'local-unwatched'))
  const cloudDeliveries = new ChatDeliveries(() => {})
  const cloud = audience(false, cloudDeliveries, mirrorTurn)
  const chat = { worktreeId: 'wt', sessionId: cloudLink.sessionId, agent: 'claude' as const }
  cloudDeliveries.adopt({ source: 'slack', externalId: cloudLink.externalId }, chat, 'hi')
  // Each snapshot names only its own side's thread.
  expect(local.seen[0]).toMatchObject({ conversations: [{ paneKey: localLink.paneKey }] })
  expect(cloud.seen[0]).toMatchObject({ conversations: [{ paneKey: cloudLink.paneKey }] })
  // The local side hears a cloud chat's end first: it neither tells it nor takes its mirror state.
  local.turnEnded(cloudLink.sessionId, { lastAssistantMessage: 'cloud answer' })
  cloud.turnEnded(cloudLink.sessionId, { lastAssistantMessage: 'cloud answer' })
  await vi.waitFor(() => expect(mirrorTurn).toHaveBeenCalledTimes(1))
  await vi.waitFor(() => expect(turnEnds(cloud.seen)).toHaveLength(1))
  expect(turnEnds(local.seen)).toEqual([])
})

it('ends a local delivery as the thread’s even after an Orca account reset', async () => {
  const localDeliveries = new ChatDeliveries(() => {}, 'local-unwatched')
  const cloudDeliveries = new ChatDeliveries(() => {})
  const local = audience(true, localDeliveries)
  const cloud = audience(false, cloudDeliveries)
  const chat = { worktreeId: 'wt', sessionId: localLink.sessionId, agent: 'claude' as const }
  localDeliveries.adopt({ source: 'slack-local', externalId: localLink.externalId }, chat, 'hi')
  // What the seam's resetAccount does: the cloud side only.
  cloud.events.reset()
  cloudDeliveries.clear()
  local.turnEnded(localLink.sessionId, { lastAssistantMessage: 'local answer' })
  await vi.waitFor(() => expect(turnEnds(local.seen)).toHaveLength(1))
  expect(turnEnds(local.seen)[0]).toMatchObject({
    origin: 'delivery',
    lastAssistantMessage: 'local answer',
    conversation: { source: 'slack-local', externalId: localLink.externalId }
  })
})

it('answers a local delivery through the real seam after an Orca account reset, and only locally', async () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the seam reads only these deps on these paths.
  const seam = new ExternalConversationSeam({
    store,
    onWorkspaceRemoved: () => () => {},
    readHookRow: () => null,
    onAgentPaneChange: () => () => {}
  } as unknown as ConstructorParameters<typeof ExternalConversationSeam>[0])
  // The chat host's completion feed, one subscription per id, as the real feed keeps them.
  const feed = new Map<string, { emit: (event: unknown) => void }>()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the feed and reads this path uses.
  const current = {
    subscribeTurnCompletions: (subscriber: { id: string; emit: (event: unknown) => void }) => {
      feed.set(subscriber.id, subscriber)
      return () => feed.delete(subscriber.id)
    },
    publishedWork: () => undefined,
    // The ended turn's journal: one answer from the agent, read through the completion's cursor.
    journalReads: async () => ({
      operationWindow: async () => ({
        snapshot: {
          cursor: { epoch: 'e', sequence: 3 },
          submissions: [],
          items: [
            {
              itemId: 'a1',
              revision: 1,
              sequence: 3,
              observedAt: 3,
              body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: ANSWER }] }
            }
          ]
        }
      }),
      canonicalItemIds: async () => new Map()
    })
  } as unknown as NonNullable<ReturnType<ConversationChatHost['current']>>
  const host = {
    chat: { current: () => current, ensure: async () => current, onChanged: () => () => {} }
  }
  const cloudSeen: (ConversationEvent | ConversationSnapshot)[] = []
  const localSeen: (ConversationEvent | ConversationSnapshot)[] = []
  seam.watch(host, (event) => cloudSeen.push(event))
  seam.watchLocal(host, (event) => localSeen.push(event))
  expect(cloudSeen[0]).toMatchObject({ conversations: [{ paneKey: cloudLink.paneKey }] })
  expect(localSeen[0]).toMatchObject({ conversations: [{ paneKey: localLink.paneKey }] })
  const chat = { worktreeId: 'wt', sessionId: localLink.sessionId, agent: 'claude' as const }
  const local = { source: 'slack-local' as const, externalId: localLink.externalId }
  expect(seam.adoptRun(local, chat, 'b')).toBe(true)
  seam.resetAccount()
  const cloudAfter: (ConversationEvent | ConversationSnapshot)[] = []
  seam.watch(host, (event) => cloudAfter.push(event))
  for (const subscriber of feed.values()) {
    subscriber.emit({
      type: 'completion',
      completion: {
        sessionId: localLink.sessionId,
        outcome: 'success',
        completedAt: 20,
        turnId: 't1',
        journalCursor: { epoch: 'e', sequence: 3 }
      }
    })
  }
  await vi.waitFor(() => expect(turnEnds(localSeen)).toHaveLength(1))
  expect(turnEnds(localSeen)[0]).toMatchObject({
    origin: 'delivery',
    conversation: local,
    lastAssistantMessage: ANSWER
  })
  expect(JSON.stringify(cloudAfter)).not.toContain(ANSWER)
  // The local reply sender posts that answer to the thread.
  const posted: string[] = []
  const replies = new SlackLocalReplies({
    fetch: async (_url, init) => {
      posted.push(new URLSearchParams(String(init?.body)).get('markdown_text') ?? '')
      return Response.json({ ok: true })
    },
    current: () => ({ botToken: 'xoxb-test', identity: { teamId: 'T2', botUserId: 'U0OWN' } }),
    hostName: () => 'host',
    signal: new AbortController().signal,
    onError: () => {}
  })
  for (const event of turnEnds(localSeen)) {
    if (event.kind === 'turn-ended') {
      replies.observe(event)
    }
  }
  await vi.waitFor(() => expect(posted).toEqual([ANSWER]))
})
