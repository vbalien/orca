// A bot's own Slack app's events into its conversations: who may ask is decided here, then the wake
// gate, then the existing conversation seam starts or continues the thread's chat. Channel messages (a
// channel's top-level message, or a reply in a thread the bot hasn't joined) are taken only in the
// channels its gate checks them in, queue apart from mentions and replies, and never wake it unchecked.
import type { Bot } from '../../shared/bot-types'
import type { SlackGateCase } from '../../shared/bots/bot-slack-gate'
import { usesLocalSlack } from '../../shared/bots/bot-slack-connection'
import type { ExternalConversationHost } from '../external-conversations/external-conversation-host'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import { BoundedKeys } from './slack-local-bounded-keys'
import {
  readLocalSlackEvent,
  type LocalSlackIdentity,
  type LocalSlackMessage
} from './slack-local-events'
import type { LocalSlackThreadMessage } from './slack-local-reads'
import {
  gateContextWanted,
  SlackLocalGateContext,
  type SlackLocalRecentThread,
  type SlackReadPause
} from './slack-local-gate-context'
import type { SlackLocalParticipation } from './slack-local-participation'
import { localSlackGateEvent, type LocalSlackWakeGate } from './slack-local-wake-gate'
import { askerRole, SlackLocalAskers } from './slack-local-asker'
import { SlackLocalThreadChats, type ThreadQueue } from './slack-local-thread-chat'
import {
  decideLocalSlack,
  deliverLocalSlack,
  GATE_DEADLINE_MS,
  type LocalSlackDeliveryDeps
} from './slack-local-delivery'

export { BARE_MENTION_TEXT } from './slack-local-asker'

const PER_THREAD_WAITING = 20
const ALL_WAITING = 200
// Channel messages wait in a smaller queue of their own, so a busy channel never pushes out a mention.
const PER_THREAD_CHANNEL_WAITING = 5
const ALL_CHANNEL_WAITING = 20
const WARN_EVERY_MS = 60_000

export type SlackLocalReads = {
  /** The thread's messages, oldest first; throws when Slack can't say. */
  thread: (
    channelId: string,
    threadTs: string,
    signal?: AbortSignal
  ) => Promise<{ messages: LocalSlackThreadMessage[]; complete: boolean }>
  /** What came right before a message, for an OpenAI gate in a running chat's thread. */
  recentThread?: SlackLocalRecentThread
  userName: (userId: string) => Promise<string | undefined>
}

export type SlackLocalInboundDeps = {
  identity: LocalSlackIdentity
  bot: () => Bot | null
  seam: () => ExternalConversationSeam | null
  host: () => ExternalConversationHost
  reads: SlackLocalReads
  wakeGate: LocalSlackWakeGate
  signal: AbortSignal
  now?: () => number
  /** Which channel-message threads the bot joined; without it no channel message is taken. */
  participation?: SlackLocalParticipation
}

export class SlackLocalInbound {
  private readonly seenEvents = new BoundedKeys(2_000)
  // One message can come as app_mention and as message; only the first that acts counts.
  private readonly seenMessages = new BoundedKeys(2_000)
  private readonly threads = new Map<string, ThreadQueue>()
  private waiting = 0
  private channelWaiting = 0
  private readonly gateContext: SlackLocalGateContext | null
  // Channel messages read their threads in a lane of their own, one at a time.
  private readonly channelReads: SlackLocalGateContext | null
  private readonly lastWarn = new Map<string, number>()
  private readonly askers: SlackLocalAskers
  private readonly chats: SlackLocalThreadChats
  private readonly delivery: LocalSlackDeliveryDeps

  constructor(private readonly deps: SlackLocalInboundDeps) {
    const pause: SlackReadPause = { until: 0 }
    const lane = (atOnce: number) =>
      deps.reads.recentThread
        ? new SlackLocalGateContext({
            recentThread: deps.reads.recentThread,
            botUserId: deps.identity.botUserId,
            signal: deps.signal,
            atOnce,
            pause,
            ...(deps.now ? { now: deps.now } : {})
          })
        : null
    this.gateContext = lane(2)
    this.channelReads = lane(1)
    this.chats = new SlackLocalThreadChats({
      botUserId: deps.identity.botUserId,
      seam: deps.seam,
      reads: deps.reads,
      channelReads: this.channelReads,
      ...(deps.participation ? { participation: deps.participation } : {})
    })
    this.askers = new SlackLocalAskers({
      botUserId: deps.identity.botUserId,
      reads: deps.reads,
      channelReads: this.channelReads
    })
    this.delivery = {
      host: deps.host,
      key: (message, channel) => this.chats.key(message, channel),
      ...(deps.participation ? { participation: deps.participation } : {}),
      wakeGate: deps.wakeGate,
      signal: deps.signal,
      now: () => this.now()
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private warn(cause: string): void {
    const now = this.now()
    if (now - (this.lastWarn.get(cause) ?? 0) >= WARN_EVERY_MS) {
      this.lastWarn.set(cause, now)
      console.warn(`[slack-local] ${cause}`)
    }
  }

  /** An events_api payload, already acknowledged to Slack. */
  receive(payload: unknown): void {
    const message = readLocalSlackEvent(payload, this.deps.identity)
    if (!message || this.deps.signal.aborted || !this.seenEvents.add(message.eventId)) {
      return
    }
    const bot = this.deps.bot()
    // Who can ask comes first: no one else's message is read, queued or judged.
    if (!bot || !usesLocalSlack(bot) || !askerRole(bot, message)) {
      return
    }
    const threadKey = `${message.teamId}:${message.channelId}:${message.threadTs}`
    const thread = this.threads.get(threadKey)
    const lane = this.chats.lane(bot, message, thread)
    if (lane === null) {
      return
    }
    const queue = thread ?? {
      tail: Promise.resolve(),
      waiting: 0,
      channelWaiting: 0,
      lastLane: lane
    }
    const full =
      lane === 'channel'
        ? queue.channelWaiting >= PER_THREAD_CHANNEL_WAITING ||
          this.channelWaiting >= ALL_CHANNEL_WAITING
        : queue.waiting - queue.channelWaiting >= PER_THREAD_WAITING ||
          this.waiting - this.channelWaiting >= ALL_WAITING
    if (full) {
      this.warn(`dropped a message: too many waiting (${lane})`)
      return
    }
    queue.waiting += 1
    this.waiting += 1
    if (lane === 'channel') {
      queue.channelWaiting += 1
      this.channelWaiting += 1
    }
    queue.lastLane = lane
    const receivedAt = this.now()
    const tail = queue.tail
      .then(() => this.handle(message, receivedAt))
      .catch((error: unknown) =>
        console.warn(
          '[slack-local] could not take a message',
          error instanceof Error ? error.message : String(error)
        )
      )
      .finally(() => {
        queue.waiting -= 1
        this.waiting -= 1
        if (lane === 'channel') {
          queue.channelWaiting -= 1
          this.channelWaiting -= 1
        }
        if (this.threads.get(threadKey) === queue && queue.waiting === 0) {
          this.threads.delete(threadKey)
        }
      })
    queue.tail = tail
    this.threads.set(threadKey, queue)
  }

  private async handle(message: LocalSlackMessage, receivedAt: number): Promise<void> {
    const bot = this.deps.bot()
    const seam = this.deps.seam()
    if (!bot || !usesLocalSlack(bot) || !seam || this.deps.signal.aborted) {
      return
    }
    // Another bot's thread: not ours.
    const others =
      seam.linkedChat(this.chats.key(message)) ?? seam.linkedChat(this.chats.key(message, true))
    const chat = this.chats.of(bot, message)
    if (others && !chat.linked) {
      return
    }
    const deadlineAt = receivedAt + GATE_DEADLINE_MS
    const left = () => deadlineAt - this.now()
    let gateCase: SlackGateCase = message.case
    if (message.case === 'thread_reply' && chat.linked !== 'normal') {
      gateCase =
        chat.linked === 'channel' && (await this.chats.joined(message, chat, left()))
          ? 'thread_reply'
          : 'channel_message'
    }
    const channelMessage = gateCase === 'channel_message'
    if (channelMessage && (left() <= 0 || !this.chats.channelTaken(bot, message))) {
      return
    }
    const role = askerRole(bot, message)
    if (!role || !this.seenMessages.add(`${message.channelId}:${message.ts}`)) {
      return
    }
    const linked = chat.linked !== null
    const { asker, historyUnknown, truncated } = await this.askers.read(
      message,
      role,
      linked,
      channelMessage ? left : null
    )
    // A running chat reads no thread for itself; an OpenAI gate that sends earlier messages needs it.
    const wanted = linked
      ? gateContextWanted(bot, {
          case: gateCase,
          inThread: message.inThread,
          channelId: message.channelId
        })
      : 0
    const reader = channelMessage ? this.channelReads : this.gateContext
    const gateContext =
      wanted > 0
        ? await reader?.read(message, wanted, channelMessage ? left() : undefined)
        : undefined
    const event = localSlackGateEvent({
      message,
      asker,
      historyUnknown,
      truncated,
      case: gateCase,
      ...(gateContext ? { gateContext } : {})
    })
    const verdict = await decideLocalSlack(
      this.delivery,
      bot,
      event,
      channelMessage ? deadlineAt : undefined
    )
    const reservation = verdict.reservation
    try {
      if (verdict.verdict !== 'wake' || this.deps.signal.aborted) {
        reservation?.release()
        return
      }
      // Reads and the gate took time: who may ask, as whom, and where channel messages are taken, are
      // decided again now, and once more when the chat takes it.
      const allowed = (): boolean => {
        const latest = this.deps.bot()
        return (
          latest !== null &&
          usesLocalSlack(latest) &&
          askerRole(latest, message) === role &&
          (!channelMessage || this.chats.channelTaken(latest, message)) &&
          !this.deps.signal.aborted
        )
      }
      if (!allowed()) {
        reservation?.release()
        return
      }
      let admitted = false
      const admissible = (): boolean => {
        if (!allowed() || (reservation && !reservation.admit(this.now()))) {
          return false
        }
        admitted = true
        return true
      }
      await deliverLocalSlack(
        this.delivery,
        bot,
        seam,
        message,
        chat,
        gateCase,
        asker,
        verdict,
        admissible,
        () => admitted
      )
    } catch (error) {
      reservation?.release()
      throw error
    }
  }
}
