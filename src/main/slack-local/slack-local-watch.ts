// The seam's local-audience watch while any bot runs on its own Slack app: each local thread's
// events go to the running connection of the bot that owns the thread, and to no other.
import {
  isLocalSlackConversation,
  parseLocalSlackConversation,
  type LocalSlackPlace
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
      /** A local thread's event for the bot whose thread it is, with the app the thread is in. */
      deliver: (botId: string, place: LocalSlackPlace, event: ConversationEvent) => void
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
    const place = parseLocalSlackConversation(event.conversation.externalId)
    const botId = findLink(this.deps.store, event.conversation)?.link.bot?.botId
    if (place && botId) {
      this.deps.deliver(botId, place, event)
    }
  }
}
