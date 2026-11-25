// A connector conversation in a bot's home: a native chat there, checked against the bot on every delivery.
import type { ConnectorWorkLink } from '../../shared/connector-work-link-contract'
import type {
  ExternalConversationBot,
  ExternalConversationLink
} from '../../shared/connectors/external-conversation-link'
import { linkedChat, type LinkableChat } from './external-conversation-chat-delivery'
import {
  findLink,
  type ExternalConversationLinkStore,
  type LinkedConversation
} from './external-conversation-links'
import type { ExternalConversationHost } from './external-conversation-host'
import type { Bot } from '../../shared/bot-types'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import {
  refused,
  type ConversationKey,
  type Delivery,
  type ReplyTarget
} from './external-conversation-types'

export type ConversationBots = {
  /** Why the bot takes no conversation now; null when it does. */
  refusal(botId: string): 'bot_not_found' | 'bot_paused' | null
  /** A new chat for a thread, or the bot's current Chat. */
  open(target: ExternalConversationBot): Promise<LinkableChat>
  /** The pull requests a bot conversation's work opened. */
  workLinks(link: ExternalConversationLink): Promise<ConnectorWorkLink[]>
}

/**
 * The chat a bot conversation's delivery goes to, linked or not yet: a thread keeps the chat it started,
 * and a direct message goes to the bot's current Chat, which answers whoever wrote to it last.
 */
export async function botChatFor(
  store: ExternalConversationLinkStore,
  bots: ConversationBots | undefined,
  key: ConversationKey,
  bot: ExternalConversationBot
): Promise<LinkableChat | Delivery> {
  if (!bots) {
    return refused('bot_not_found')
  }
  const refusal = bots.refusal(bot.botId)
  if (refusal) {
    return refused(refusal)
  }
  // A DM that ran in the bot's Chat, then given its own chat, opens one rather than keep the Chat.
  const linked = findLink(store, key)
  if (bot.kind === 'bot' && linked && linked.link.bot?.kind !== 'bot-chat') {
    return linkedChat(linked.workspace.worktreeId, linked.link)
  }
  return { ...(await bots.open(bot)), bot }
}

/** A start's chat once the host's admission lets it through; the admission's outcome otherwise. */
export async function admittedChat(
  store: ExternalConversationLinkStore,
  host: ExternalConversationHost,
  key: ConversationKey,
  bot: ExternalConversationBot,
  signal: AbortSignal
): Promise<LinkableChat | Delivery> {
  return (
    (await host.admit?.(signal, { botId: bot.botId })) ??
    (await botChatFor(store, host.bots, key, bot))
  )
}

/** A send's link once the host's admission lets it through (read again after it waited); the
 *  admission's outcome otherwise. Throws for a conversation with no link. */
export async function admittedLink(
  store: ExternalConversationLinkStore,
  host: ExternalConversationHost,
  key: ConversationKey,
  signal: AbortSignal
): Promise<LinkedConversation | Delivery> {
  const before = findLink(store, key)
  const bot = before?.link.bot
  const held = await host.admit?.(signal, before ? (bot ? { botId: bot.botId } : {}) : null)
  const linked = held ?? (host.admit ? findLink(store, key) : before)
  if (!linked) {
    throw new Error('external_conversation_not_found')
  }
  return linked
}

/**
 * Why a bot's chat may not post a reply into its conversation; null when it may, or when it is no
 * bot's. A bot's Chat answers whichever direct message wrote last, so it has no one conversation to
 * post into mid-turn.
 */
export function botReplyRefusal(
  { bot: speaksFor, worktreeId }: ReplyTarget,
  bots: readonly Pick<Bot, 'id' | 'folderWorkspaceId'>[]
): 'bot_chat_reply' | 'not_this_bots_conversation' | null {
  if (!speaksFor) {
    return null
  }
  if (speaksFor.kind === 'bot-chat') {
    return 'bot_chat_reply'
  }
  const bot = bots.find((entry) => entry.id === speaksFor.botId)
  return bot && folderWorkspaceKey(bot.folderWorkspaceId) === worktreeId
    ? null
    : 'not_this_bots_conversation'
}
