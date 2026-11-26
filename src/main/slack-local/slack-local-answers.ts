// Each listening bot's answer sender, kept across its reconnects so a token change loses no answer.
import { hostname } from 'node:os'
import type { ConversationEvent } from '../external-conversations/external-conversation-events'
import type { SlackLocalParticipation } from './slack-local-participation'
import { SlackLocalReplies, type SlackLocalRepliesDeps } from './slack-local-replies'
import type { SlackFetch } from './slack-web-api'

export class SlackLocalAnswers {
  private readonly senders = new Map<
    string,
    { replies: SlackLocalReplies; abort: AbortController }
  >()

  constructor(
    private readonly deps: {
      fetch: SlackFetch
      /** The bot's credentials once any reconnect settles; null when it isn't connected. */
      credentials: (botId: string) => ReturnType<SlackLocalRepliesDeps['current']>
      onError: (botId: string, code: string) => void
      onDelivered: (botId: string) => void
      participation?: (botId: string) => SlackLocalParticipation
      canPost?: (botId: string, externalId: string, paneKey: string) => boolean
    }
  ) {}

  observe(botId: string, event: ConversationEvent): void {
    this.sender(botId).observe(event)
  }

  /** Stops the senders of every bot not in `wanted`, with whatever they still had to post. */
  keepOnly(wanted: ReadonlySet<string>): void {
    for (const botId of this.senders.keys()) {
      if (!wanted.has(botId)) {
        this.drop(botId)
      }
    }
  }

  drop(botId: string): void {
    this.senders.get(botId)?.abort.abort()
    this.senders.delete(botId)
  }

  private sender(botId: string): SlackLocalReplies {
    const kept = this.senders.get(botId)
    if (kept) {
      return kept.replies
    }
    const abort = new AbortController()
    const replies = new SlackLocalReplies({
      fetch: this.deps.fetch,
      current: () => this.deps.credentials(botId),
      hostName: () => hostname(),
      signal: abort.signal,
      onError: (code) => this.deps.onError(botId, code),
      onDelivered: () => this.deps.onDelivered(botId),
      ...(this.deps.participation ? { participation: this.deps.participation(botId) } : {}),
      ...(this.deps.canPost
        ? {
            canPost: (externalId: string, paneKey: string) =>
              this.deps.canPost!(botId, externalId, paneKey)
          }
        : {})
    })
    this.senders.set(botId, { replies, abort })
    return replies
  }
}
