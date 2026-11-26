// The seam's local-audience watch while any bot runs on its own Slack app: each local thread's
// events go to the running connection of the bot that owns the thread, and to no other.
import {
  isLocalSlackConversation,
  localSlackConversation,
  parseLocalSlackConversation
} from '../../shared/connectors/local-slack-conversation'
import type { ConversationEvent } from '../external-conversations/external-conversation-events'
import {
  findLink,
  type ExternalConversationLinkStore
} from '../external-conversations/external-conversation-links'
import { runtimeConversationHost } from '../external-conversations/external-conversation-runtime-host'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'

export class SlackLocalWatch {
  private watched: { seam: ExternalConversationSeam; release: () => void } | null = null

  constructor(
    private readonly deps: {
      runtime: Parameters<typeof runtimeConversationHost>[0]
      store: ExternalConversationLinkStore
      /** A local thread's event for the bot whose thread it is. */
      deliver: (botId: string, event: ConversationEvent) => void
      /** The watched seam was disabled: watch the next one. */
      seamGone: () => void
    }
  ) {}

  ensure(wanted: boolean): void {
    const seam = wanted ? this.deps.runtime.getExternalConversationSeam() : null
    if (this.watched && (this.watched.seam !== seam || this.watched.seam.signal.aborted)) {
      this.watched.release()
      this.watched = null
    }
    if (!seam || seam.signal.aborted || this.watched) {
      return
    }
    try {
      const unwatch = seam.watchLocal(runtimeConversationHost(this.deps.runtime), (event) => {
        if (event.kind !== 'snapshot') {
          this.route(event)
        }
      })
      const gone = (): void => queueMicrotask(this.deps.seamGone)
      seam.signal.addEventListener('abort', gone, { once: true })
      const release = (): void => {
        seam.signal.removeEventListener('abort', gone)
        unwatch()
      }
      this.watched = { seam, release }
    } catch (error) {
      console.warn(
        '[slack-local] could not watch conversations',
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  private route(event: ConversationEvent): void {
    if (!isLocalSlackConversation(event.conversation)) {
      return
    }
    const botId = findLink(this.deps.store, event.conversation)?.link.bot?.botId
    const place = parseLocalSlackConversation(event.conversation.externalId)
    if (!botId || !place) {
      return
    }
    // A channel-message chat whose thread has an ordinary chat too (an older Orca opened it) says
    // nothing more there: the ordinary one is the thread's.
    if (place.channel && !canonicalLocalChat(this.deps.store, event.conversation.externalId)) {
      console.warn('[slack-local] a thread had two chats; the channel-message one stays quiet')
      return
    }
    this.deps.deliver(botId, event)
  }
}

/** Whether a local conversation is its thread's chat: an ordinary one always, a channel-message one
 *  (`:c`) only while it is linked and no ordinary chat of the same bot has the thread. */
export function canonicalLocalChat(
  store: ExternalConversationLinkStore,
  externalId: string,
  /** The chat whose answer it is: the thread's link must still be its, not a later chat's. */
  chat?: { botId: string; paneKey: string }
): boolean {
  const place = parseLocalSlackConversation(externalId)
  const own = place ? findLink(store, { source: 'slack-local', externalId }) : null
  // Unlinked, or linked to another bot or chat since: nothing of this chat goes to Slack.
  if (
    !place ||
    !own ||
    (chat && (own.link.bot?.botId !== chat.botId || own.link.paneKey !== chat.paneKey))
  ) {
    return false
  }
  if (!place.channel) {
    return true
  }
  const { channel: _channel, ...ordinary } = place
  const normal = findLink(store, localSlackConversation(ordinary))
  return !(normal && normal.link.bot?.botId === own.link.bot?.botId)
}
