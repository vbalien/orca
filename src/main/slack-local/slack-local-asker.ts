// Who asked a bot's own Slack app, as the conversation seam and the wake gate take it: their role and
// name, their words cut to a cap, and the thread before the message for a chat that starts inside one.
import type { Bot } from '../../shared/bot-types'
import type { ConnectorAsker, ConnectorContextItem } from '../../shared/connector-asker-contract'
import { localSlackAskers } from '../../shared/bots/bot-slack-connection'
import type { LocalSlackMessage } from './slack-local-events'
import type { LocalSlackThreadMessage } from './slack-local-reads'
import type { SlackLocalGateContext } from './slack-local-gate-context'
import type { SlackLocalReads } from './slack-local-inbound'

export const BARE_MENTION_TEXT = '(mentioned you with no message)'
const LOCAL_NOTE =
  "You were asked in Slack through your own Slack app on this computer. Your final message is posted to this thread for you; `orca slack` and `orca bot reply` aren't available here yet."
const CONTEXT_MESSAGES = 20
const EARLIER_OWN_MESSAGES = 10
const TEXT_CAP = 4000

/** Cuts texts to the cap, remembering whether any was cut. */
function textCap() {
  const cap = (text: string): string => {
    cap.cut ||= text.length > TEXT_CAP
    return text.slice(0, TEXT_CAP)
  }
  cap.cut = false
  return cap
}
type TextCap = ReturnType<typeof textCap>

/** Who they are to the bot now: its owner, someone added for its workspace, or no one. */
export function askerRole(bot: Bot, message: LocalSlackMessage): 'owner' | 'member' | null {
  const askers = localSlackAskers(bot)
  if (message.userId === askers.ownerUserId) {
    return 'owner'
  }
  return askers.members.includes(message.userId) ? 'member' : null
}

function placeKind(message: LocalSlackMessage): ConnectorAsker['place']['kind'] {
  switch (message.channelType) {
    case 'im':
      return 'direct_message'
    case 'channel':
      return 'public_channel'
    case 'group':
      return 'private_channel'
    case null:
      return message.channelId.startsWith('D') ? 'direct_message' : 'channel'
  }
}

export class SlackLocalAskers {
  constructor(
    private readonly deps: {
      botUserId: string
      reads: SlackLocalReads
      /** Channel messages read their threads in this bounded lane. */
      channelReads: SlackLocalGateContext | null
    }
  ) {}

  async read(
    message: LocalSlackMessage,
    role: 'owner' | 'member',
    linked: boolean,
    channelBudget: (() => number) | null
  ): Promise<{ asker: ConnectorAsker; historyUnknown: boolean; truncated: boolean }> {
    // A channel message reads names in its own bounded lane too (a known name costs nothing).
    const name = channelBudget
      ? ((await this.deps.channelReads?.bounded(
          (signal) => this.deps.reads.userName(message.userId, signal),
          channelBudget()
        )) ?? undefined)
      : await this.deps.reads.userName(message.userId).catch(() => undefined)
    const cap = textCap()
    const words = cap(message.text)
    // Only a mention can be bare: a channel message without words was never taken.
    const bare = words.length === 0 && message.case === 'mention'
    // A running chat already has its thread; a new one started inside a thread reads what came before.
    const thread =
      !linked && message.inThread ? await this.threadBefore(message, channelBudget) : null
    // Only a whole stretch can say what they wrote since the bot last spoke.
    const earlierOwn =
      bare && thread?.ok && thread.complete
        ? this.earlierOwn(thread.messages, message.userId, cap)
        : null
    // In a thread, a bare mention whose stretch wasn't read whole (or at all, in a running chat):
    // what they asked before is unknown to the gate, not nothing.
    const historyUnknown = bare && message.inThread && !(thread?.ok && thread.complete)
    const asker: ConnectorAsker = {
      userId: message.userId,
      ...(name ? { name } : {}),
      role,
      place: { kind: placeKind(message), id: message.channelId },
      text: bare ? BARE_MENTION_TEXT : words,
      context: !thread
        ? []
        : !thread.ok
          ? [{ kind: 'unreadable' }]
          : thread.complete
            ? this.context(thread.messages, cap)
            : [{ kind: 'more' }],
      ...(earlierOwn ? { earlierOwn } : {}),
      note: LOCAL_NOTE
    }
    return { asker, historyUnknown, truncated: cap.cut }
  }

  /** The thread before the message. A channel message reads it in its own bounded lane. */
  private async threadBefore(
    message: LocalSlackMessage,
    channelBudget: (() => number) | null
  ): Promise<{ ok: true; messages: LocalSlackThreadMessage[]; complete: boolean } | { ok: false }> {
    try {
      const read = channelBudget
        ? await this.deps.channelReads?.bounded(
            (signal) => this.deps.reads.thread(message.channelId, message.threadTs, signal),
            channelBudget()
          )
        : await this.deps.reads.thread(message.channelId, message.threadTs)
      if (!read) {
        return { ok: false }
      }
      const before = read.messages.filter((entry) => Number(entry.ts) < Number(message.ts))
      // A page that ends before the message leaves out what came right before it.
      const complete = read.complete || before.length < read.messages.length
      return { ok: true, messages: before, complete }
    } catch {
      return { ok: false }
    }
  }

  private context(messages: LocalSlackThreadMessage[], cap: TextCap): ConnectorContextItem[] {
    const recent = messages.slice(-CONTEXT_MESSAGES)
    const items: ConnectorContextItem[] = recent.map((entry) =>
      entry.botId || entry.userId === this.deps.botUserId
        ? { kind: 'bot', text: cap(entry.text) }
        : { kind: 'earlier', userId: entry.userId ?? 'unknown', text: cap(entry.text) }
    )
    return messages.length > recent.length ? [{ kind: 'more' }, ...items] : items
  }

  /** Their own messages since the bot last posted in the thread, oldest first. */
  private earlierOwn(messages: LocalSlackThreadMessage[], userId: string, cap: TextCap) {
    const lastBot = messages.findLastIndex((entry) => entry.userId === this.deps.botUserId)
    const own = messages
      .slice(lastBot + 1)
      .filter((entry) => entry.userId === userId && entry.text.trim().length > 0)
    if (own.length === 0) {
      return null
    }
    const kept = own.slice(-EARLIER_OWN_MESSAGES)
    return {
      messages: kept.map((entry) => ({
        text: cap(entry.text),
        at: Math.round(Number(entry.ts) * 1000),
        // The agent is told a cut request is incomplete.
        ...(entry.text.length > TEXT_CAP ? { cut: true as const } : {})
      })),
      ...(own.length > kept.length ? { more: true as const } : {})
    }
  }
}
