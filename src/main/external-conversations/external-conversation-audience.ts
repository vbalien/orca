// The seam's two audiences: Orca Cloud's conversations, and a bot's own Slack app's threads
// (slack-local) that this computer answers itself. Each has its own events and delivery marks, so
// neither side's watch, mirror state or account reset reaches the other.
import { isLocalSlackConversation } from '../../shared/connectors/local-slack-conversation'
import { chatTurnFacts, watchChatNews } from './external-conversation-chat'
import { chatPromptFacts } from './external-conversation-chat-prompts'
import { ChatDeliveries } from './external-conversation-chat-delivery'
import { ConversationEvents } from './external-conversation-events'
import {
  HOST_CLOCK,
  type ExternalConversationHost,
  type ExternalConversationSeamDeps
} from './external-conversation-host'
import { chatPromptReads } from './external-conversation-prompt-standing'
import { conversationWorkerActivities } from './external-conversation-workers'

export function audienceEvents(
  audience: 'cloud' | 'local',
  deps: ExternalConversationSeamDeps,
  host: ExternalConversationHost,
  deliveries: ChatDeliveries,
  /** The seam's: once disabled, a watch's teardown follows nothing. */
  signal: AbortSignal
): ConversationEvents {
  const local = audience === 'local'
  const facts = chatTurnFacts(host.chat, deps.store, (id) => deliveries.pending(id))
  const newsId = local ? 'external-conversations-local' : 'external-conversations'
  return new ConversationEvents({
    store: deps.store,
    readHookRow: deps.readHookRow,
    onAgentPaneChange: deps.onAgentPaneChange,
    ...chatPromptReads(host.chat),
    onChatNews: (listener) => (host.chat ? watchChatNews(host.chat, listener, newsId) : () => {}),
    onWatchDisposed: () => {
      if (!signal.aborted) {
        deliveries.followUnwatched(host.chat)
      }
    },
    chatTurnOrigin: (sessionId, turnAt) => deliveries.origin(sessionId, turnAt),
    chatTurnDelivered: facts.delivered,
    runningTurnReported: facts.reported,
    chatTurnDelivery: (sessionId, turnAt) => deliveries.started(sessionId, turnAt),
    chatTurnWaiting: (sessionId) => deliveries.waiting(sessionId),
    workLinks: async (link) => (await host.bots?.workLinks(link)) ?? [],
    workerActivities: (links) => conversationWorkerActivities(host, links),
    audience: (link) => isLocalSlackConversation(link) === local,
    // Orca Cloud's alone: the Slack mirror, the reply outbox, whom a cloud thread acts for, and
    // prompts the cloud routes by who raised them.
    ...(local
      ? { promptsAudience: () => false }
      : {
          mirrorTurn: (sessionId: string) => deps.slackMirror?.()?.turnEnded(sessionId) ?? null,
          replyFill: () => deps.replyFill?.() ?? null,
          ...(deps.actsForOf ? { actsForOf: deps.actsForOf } : {}),
          promptsAudience: () => deps.promptsAudience?.() === true
        }),
    ...chatPromptFacts(host.chat),
    ...HOST_CLOCK
  })
}

/** The local audience's delivery marks, followed under their own subscriber id when unwatched. */
export function localChatDeliveries(
  link: ConstructorParameters<typeof ChatDeliveries>[0]
): ChatDeliveries {
  return new ChatDeliveries(link, 'external-conversations-local-unwatched')
}
