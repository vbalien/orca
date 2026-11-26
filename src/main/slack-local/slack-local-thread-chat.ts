// Which chat a Slack thread is for a bot (its ordinary link, or one a channel message opened), and
// whether the bot joined a channel-message thread: remembered, or read from the thread itself.
import type { Bot } from '../../shared/bot-types'
import { slackGateApplies } from '../../shared/bots/bot-slack-gate'
import { localSlackConversation } from '../../shared/connectors/local-slack-conversation'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import type { ThreadChat } from './slack-local-delivery'
import type { LocalSlackMessage } from './slack-local-events'
import type { LocalSlackThreadMessage } from './slack-local-reads'
import type { SlackLocalGateContext } from './slack-local-gate-context'
import type { SlackLocalReads } from './slack-local-inbound'
import type { SlackLocalParticipation } from './slack-local-participation'

export type Lane = 'common' | 'channel'
export type ThreadQueue = {
  tail: Promise<void>
  waiting: number
  channelWaiting: number
  lastLane: Lane
}

export class SlackLocalThreadChats {
  constructor(
    private readonly deps: {
      botUserId: string
      seam: () => ExternalConversationSeam | null
      reads: SlackLocalReads
      channelReads: SlackLocalGateContext | null
      participation?: SlackLocalParticipation
    }
  ) {}

  key(message: LocalSlackMessage, channel = false) {
    return localSlackConversation({
      teamId: message.teamId,
      channelId: message.channelId,
      threadTs: message.threadTs,
      botUserId: this.deps.botUserId,
      ...(channel ? { channel: true as const } : {})
    })
  }

  /** The thread's chat for this bot. A thread with both (an older Orca opened an ordinary chat in a
   *  channel-message thread) keeps the ordinary one; the other link goes. */
  of(bot: Bot, message: LocalSlackMessage): ThreadChat {
    const seam = this.deps.seam()
    const normal = this.key(message)
    const channel = this.key(message, true)
    const own = (key: typeof normal) => seam?.linkedChat(key, bot.id) != null
    if (own(normal)) {
      if (own(channel)) {
        console.warn('[slack-local] a thread had two chats; keeping the ordinary one')
        seam?.goneChats.release(channel)
      }
      return { key: normal, linked: 'normal' }
    }
    if (own(channel)) {
      return { key: channel, linked: 'channel' }
    }
    return { key: normal, linked: null }
  }

  /** Whether the bot joined a channel-message thread: remembered, or read from the thread itself. */
  /** Whether the bot joined a channel-message thread, and the thread as read to tell (when it was). */
  async joined(
    message: LocalSlackMessage,
    chat: ThreadChat,
    budgetMs: number
  ): Promise<{
    joined: boolean
    read?: { messages: LocalSlackThreadMessage[]; complete: boolean }
  }> {
    const participation = this.deps.participation
    if (!participation) {
      return { joined: false }
    }
    await participation.load()
    const id = chat.key.externalId
    if (participation.has(id)) {
      return { joined: true }
    }
    if (participation.slackSaid(id) === false) {
      return { joined: false }
    }
    const read = await this.deps.channelReads?.bounded(
      (signal) => this.deps.reads.thread(message.channelId, message.threadTs, signal),
      budgetMs
    )
    if (!read) {
      return { joined: false }
    }
    const posted = read.messages.some((entry) => entry.userId === this.deps.botUserId)
    // Not on the first page and more follows: unknown, so not joined (rechecked next time).
    if (posted || read.complete) {
      participation.rememberSlack(id, posted)
    }
    return { joined: posted, read }
  }

  /** Which queue a message waits in, or null to drop it now: a sure channel message the gate doesn't
   *  take in that channel costs nothing. A reply behind an earlier message in its thread waits with
   *  it and is decided once that one is through. */
  lane(bot: Bot, message: LocalSlackMessage, thread: ThreadQueue | undefined): Lane | null {
    if (message.case === 'mention' || message.case === 'dm') {
      return 'common'
    }
    if (message.case === 'thread_reply' && thread && thread.waiting > 0) {
      return thread.lastLane
    }
    const chat = message.case === 'thread_reply' ? this.of(bot, message) : null
    if (chat?.linked === 'normal') {
      return 'common'
    }
    if (chat?.linked === 'channel') {
      return this.deps.participation?.has(chat.key.externalId) ? 'common' : 'channel'
    }
    // A channel message for sure: taken only where the gate checks it, and only with words to judge.
    return this.channelTaken(bot, message) ? 'channel' : null
  }

  channelTaken(bot: Bot, message: LocalSlackMessage): boolean {
    return (
      this.deps.participation !== undefined &&
      message.text.length > 0 &&
      slackGateApplies(bot, { case: 'channel_message', channelId: message.channelId })
    )
  }
}
