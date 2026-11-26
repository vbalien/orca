import type {
  ConnectorAsker,
  ConnectorAnswer
} from '../../shared/connectors/connector-cloud-contract'
import type { AdmittedMessage } from '../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import { nameLinkedPlace } from './external-conversation-place'
import { isBotAgent } from '../../shared/bot-types'
import { type ConversationChatHost, chatTurnFacts } from './external-conversation-chat'
import { answerConversation } from './external-conversation-answer'
import { admittedChat, admittedLink, botChatFor } from './external-conversation-bots'
import {
  ChatDeliveries,
  linkedChat,
  type LinkableChat
} from './external-conversation-chat-delivery'
import { cancelConversation } from './external-conversation-cancel'
import { resumeRefusal } from './external-conversation-resume'
import { ConversationChain, type QueuedWork } from './external-conversation-chain'
import { GoneChats } from './external-conversation-gone-chats'
import type { ConversationEvents, ConversationWatchListener } from './external-conversation-events'
import { conversationOwnsTurn } from './external-conversation-chat-turns'
import type { DeliveryReceipts } from './external-conversation-delivery-receipts'
import type {
  ExternalConversationHost,
  ExternalConversationSeamDeps
} from './external-conversation-host'
import {
  findLink,
  findLinkForSession,
  findConversationChat,
  type LinkedConversation
} from './external-conversation-links'
import { writeChatLink } from './external-conversation-link-writes'
import {
  conversationId,
  type ConnectorMessage,
  type ConnectorStartInput,
  refused,
  type ConversationKey,
  type ConversationStart,
  type Delivery
} from './external-conversation-types'

import { recordAdmittedTurn, recordLastTurn } from './external-conversation-last-turn'
import { isLocalSlackConversation } from '../../shared/connectors/local-slack-conversation'
import { audienceEvents, localChatDeliveries } from './external-conversation-audience'
export type { ExternalConversationSeamDeps } from './external-conversation-host'

/** One enabled period: disabling settles queued work and aborts running work at its next boundary. */
export class ExternalConversationSeam {
  private readonly abort = new AbortController()
  readonly signal = this.abort.signal
  private readonly chain = new ConversationChain(this.abort.signal)
  /** Runs `work` in the conversation's queue after its deliveries; a Stop settles it or aborts it. */
  readonly queued = (key: ConversationKey, work?: QueuedWork): Promise<Delivery> =>
    this.chain.after(conversationId(key), work)
  private readonly linked = new Map<string, { key: ConversationKey; worktreeId: string }>()
  private readonly chatDeliveries = new ChatDeliveries((...link) => this.linkChat(...link))
  /** A bot's own Slack app's threads (slack-local): their deliveries, events and watch are kept
   *  apart from Orca Cloud's, so an account reset or a cloud watch never touches them. */
  private readonly localDeliveries = localChatDeliveries((...link) => this.linkChat(...link))
  /** Built by the first watcher, so an unwatched seam subscribes to nothing. */
  private events: ConversationEvents | null = null
  private localEvents: ConversationEvents | null = null
  private readonly releaseRemovals: () => void
  /** Links whose chat was deleted: dropped, and the cloud told the thread is free. */
  readonly goneChats: GoneChats

  constructor(private readonly deps: ExternalConversationSeamDeps) {
    this.goneChats = new GoneChats({ ...deps, released: (dropped) => this.unlinked(dropped) })
    // Cancel removed-workspace lanes; surviving links distinguish same-path twins on other hosts.
    this.releaseRemovals = deps.onWorkspaceRemoved((worktreeId) => {
      for (const [id, { key, worktreeId: linkedTo }] of this.linked) {
        if (linkedTo === worktreeId && !findLink(this.deps.store, key)) {
          this.linked.delete(id)
          this.chain.cancel(id, 'agent_not_reachable')
        }
      }
    })
  }

  dispose(reason: 'connectors_disabled'): void {
    this.releaseRemovals()
    this.resetAccount()
    this.chatDeliveries.stopFollowing()
    this.abort.abort(reason)
    // After the abort, so its watch's teardown starts no unwatched follower again.
    this.localEvents?.dispose()
    this.localDeliveries.stopFollowing()
  }

  /** Signed out or switched account: drop what the last account's cloud was shown; keep working.
   *  A bot's own Slack app's threads belong to no Orca account, so they keep theirs. */
  resetAccount(): void {
    this.events?.reset()
    this.chatDeliveries.clear()
  }

  answer(
    host: ExternalConversationHost,
    key: ConversationKey,
    promptId: string,
    answer: string | ConnectorAnswer
  ): Promise<Delivery> {
    return answerConversation(host, { ...this.deps, events: this.events }, key, {
      promptId,
      ...(typeof answer === 'string' ? { optionId: answer } : answer),
      signal: this.abort.signal
    })
  }

  /** Receipted like a send, so a retried delivery never cancels twice. */
  cancel(
    host: ExternalConversationHost,
    key: ConversationKey,
    id: string,
    turnId?: number
  ): Promise<Delivery> {
    const seam = { ...this.deps, chain: this.chain }
    const args = turnId === undefined ? [] : [turnId]
    // A Stop bound to a turn never lands on a later one.
    const turnIsCurrent = () =>
      turnId === undefined ||
      this.replyTarget(findLink(this.deps.store, key)?.link.paneKey ?? '')?.turnId === turnId
    return this.deps.receipts.run(key, id, 'connector.cancel', args, async () =>
      turnIsCurrent()
        ? cancelConversation(host, seam, key, this.abort.signal, turnIsCurrent)
        : refused('turn_not_running')
    )
  }

  /** Whether a chat's current or next turn is a connector's delivery, not its owner's. */
  deliveredTurn(sessionId: string): boolean {
    return this.chatDeliveries.pending(sessionId) || this.localDeliveries.pending(sessionId)
  }

  /** Whether the chat's running turn is its conversation's, so workers it starts report there too: a
   *  turn the owner typed that the Slack mirror posted to the thread is the thread's ask as well. */
  conversationTurn(chats: ConversationChatHost | undefined, sessionId: string): boolean {
    const linked = findLinkForSession(this.deps.store, sessionId)
    return Boolean(
      linked &&
      (conversationOwnsTurn(linked.link, this.turnFacts(chats, linked.link)) ||
        this.deps.slackMirror?.()?.turnPosted(sessionId))
    )
  }

  /** Null unless a watch runs (replies need the connector) and the chat is linked. */
  replyTarget(paneKey: string): ReturnType<ConversationEvents['replyTarget']> {
    return this.events?.replyTarget(paneKey) ?? this.localEvents?.replyTarget(paneKey) ?? null
  }

  private turnFacts(chats: ConversationChatHost | undefined, key: { source: string }) {
    const { deliveries } = this.side(key)
    return chatTurnFacts(chats, this.deps.store, (id) => deliveries.pending(id))
  }

  private side(key: { source: string }) {
    return isLocalSlackConversation(key)
      ? { events: this.localEvents, deliveries: this.localDeliveries }
      : { events: this.events, deliveries: this.chatDeliveries }
  }

  /** A snapshot of every linked conversation first, then its events; returns the release. Orca
   *  Cloud's: every conversation but a bot's own Slack app's. */
  watch(host: ExternalConversationHost, listener: ConversationWatchListener): () => void {
    if (this.abort.signal.aborted) {
      throw new Error('connectors_disabled')
    }
    this.events ??= audienceEvents('cloud', this.deps, host, this.chatDeliveries, this.signal)
    this.chatDeliveries.stopFollowing()
    const release = this.events.watch(listener)
    this.deps.watched?.()
    return release
  }

  /** The same for a bot's own Slack app's threads only, which this computer answers itself: no
   *  Slack mirror, reply outbox or cloud flush, and untouched by an Orca account reset. */
  watchLocal(host: ExternalConversationHost, listener: ConversationWatchListener): () => void {
    if (this.abort.signal.aborted) {
      throw new Error('connectors_disabled')
    }
    this.localEvents ??= audienceEvents('local', this.deps, host, this.localDeliveries, this.signal)
    this.localDeliveries.stopFollowing()
    return this.localEvents.watch(listener)
  }

  /** A turn end held for the owner's Slack posts, told now; false while nothing watches. */
  tellTurnEnd(event: Parameters<ConversationEvents['tell']>[0]): boolean {
    return this.side(event.conversation).events?.tell(event) ?? false
  }

  /** A bot's conversation is a native chat, which starts whether or not status hooks are on. */
  async start(
    host: ExternalConversationHost,
    key: ConversationKey,
    deliveryId: string,
    input: ConnectorStartInput
  ): Promise<ConversationStart> {
    const { agent, target, prompt, ...message } = input
    const initial = await this.deps.receipts.run(
      key,
      deliveryId,
      'connector.start',
      [agent, target, prompt],
      () =>
        this.chain.enqueue(conversationId(key), async (signal) => {
          if (!isBotAgent(agent)) {
            return refused('unsupported_agent')
          }
          const chat = await admittedChat(this.deps.store, host, key, target, signal)
          return 'outcome' in chat
            ? chat
            : this.deliverToChat(host, key, chat, { ...message, text: prompt, deliveryId }, signal)
        })
    )
    return { conversation: key, initial }
  }

  send(
    host: ExternalConversationHost,
    key: ConversationKey,
    deliveryId: string,
    message: ConnectorMessage
  ): Promise<Delivery> {
    const id = conversationId(key)
    return this.deps.receipts.run(key, deliveryId, 'connector.send', [message.text], () => {
      const queued = findLink(this.deps.store, key)
      if (queued) {
        this.linked.set(id, { key, worktreeId: queued.workspace.worktreeId })
      }
      return this.chain.enqueue(id, async (signal) => {
        const linked = await admittedLink(this.deps.store, host, key, signal)
        if ('outcome' in linked) {
          return linked
        }
        const delivered = await this.deliver(host, key, linked, { ...message, deliveryId }, signal)
        return this.goneChats.settle(key, delivered)
      })
    })
  }

  /** Its delivery receipts: what an earlier process's received delivery came to (never run again),
   *  and the receipts a batch's later sends settle through (connector-delivery-batches). */
  get receipts(): DeliveryReceipts {
    return this.deps.receipts
  }

  /** The chat a conversation is linked to on this host, if any. */
  linkedChat(key: ConversationKey, botId?: string) {
    return findConversationChat(this.deps.store, key, botId)
  }

  /**
   * Links an event's conversation to the chat its automation run already started, as a delivery would:
   * the turn's replies and final message go to the event's thread. False once connectors are off.
   */
  adoptRun(key: ConversationKey, chat: LinkableChat, text: string): boolean {
    if (this.abort.signal.aborted) {
      return false
    }
    try {
      this.side(key).deliveries.adopt(key, chat, text)
    } catch (error) {
      console.warn('[connectors] could not link an automation run to its thread', error)
      return false
    }
    this.linked.set(conversationId(key), { key, worktreeId: chat.worktreeId })
    return true
  }

  /** Links a conversation to an existing native chat, which runs only on this host. */
  linkChat(key: ConversationKey, chat: LinkableChat, text?: string, asker?: ConnectorAsker): void {
    const fresh = findLink(this.deps.store, key) === null
    const written = writeChatLink(this.deps.store, key, chat, text)
    const linked = (asker && this.deps.slackMirror?.()?.opened(written, asker, fresh)) || written
    const { events } = this.side(key)
    if (linked) {
      events?.linked(linked, this.deps.actsForOf?.(chat.sessionId))
      this.deps.onLinked?.()
    } else {
      const kept = findLink(this.deps.store, key)
      if (kept) {
        events?.delivered(kept.link)
      }
    }
    // A bot's own Slack app's channel is never named through Orca Cloud.
    if (asker && chat.bot && !isLocalSlackConversation(key)) {
      void nameLinkedPlace(this.deps, key, chat.bot.botId, asker.place, this.abort.signal)
    }
  }

  /** Which side began the chat's latest turn, as its host admitted the message. */
  messageAdmitted(message: AdmittedMessage): void {
    recordAdmittedTurn(this.deps, message)
  }

  private unlinked(dropped: LinkedConversation): void {
    this.linked.delete(conversationId(dropped.link))
    this.side(dropped.link).events?.unlinked(dropped)
    this.deps.onLinked?.()
  }

  private async deliverToChat(
    host: ExternalConversationHost,
    key: ConversationKey,
    chat: LinkableChat,
    message: ConnectorMessage & { deliveryId: string },
    signal: AbortSignal
  ): Promise<Delivery> {
    // Orca Cloud's Slack never reaches a bot that answers Slack through its own app.
    if (key.source === 'slack' && chat.bot && this.deps.usesLocalSlack?.(chat.bot.botId)) {
      return refused('bot_not_found')
    }
    this.linked.set(conversationId(key), { key, worktreeId: chat.worktreeId })
    // A bot's request may list images; they go with its words, so the agent sees them at once.
    const images =
      chat.bot && message.asker && this.deps.askerImages && !isLocalSlackConversation(key)
        ? await this.deps
            .askerImages({ botId: chat.bot.botId, conversation: key, asker: message.asker, signal })
            .catch(() => [])
        : []
    // The admission's word for the chat (a wake gate's reason) goes with Orca's note.
    const admitNote = host.admitNote?.()
    const note = admitNote ? [message.note, admitNote].filter(Boolean).join('\n\n') : message.note
    const delivered = await this.side(key).deliveries.deliver(host.chat, key, chat, {
      ...message,
      ...(note ? { note } : {}),
      signal,
      ...(images.length > 0 ? { images } : {})
    })
    // Its outbox row may have committed even when the send was then rejected: watch from now on.
    if (message.reply) {
      this.deps.replyAdmitted?.(chat.sessionId)
    }
    // A new conversation's link is written only once its chat took the message, after admission.
    if (delivered.outcome !== 'refused') {
      recordLastTurn(this.deps, key, 'conversation', {
        worktreeId: chat.worktreeId,
        sshHostId: null
      })
    }
    return delivered
  }

  private async deliver(
    host: ExternalConversationHost,
    key: ConversationKey,
    { workspace, link }: LinkedConversation,
    message: ConnectorMessage & { deliveryId: string },
    signal: AbortSignal
  ): Promise<Delivery> {
    const chat = link.bot
      ? await botChatFor(this.deps.store, host.bots, key, link.bot)
      : linkedChat(workspace.worktreeId, link)
    return 'outcome' in chat
      ? chat
      : ((await resumeRefusal(message, host.chat, chat.sessionId, { workspace, link })) ??
          this.deliverToChat(host, key, chat, message, signal))
  }
}
