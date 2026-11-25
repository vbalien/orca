// Which Slack events a bot's own app answers, read into one shape: a mention, a DM, or a reply in a
// thread. Everything else (edits, other bots, the app's own posts, group DMs) is dropped here.
import { isSlackRecord } from './slack-web-api'
export type LocalSlackCase = 'mention' | 'dm' | 'thread_reply'

export type LocalSlackMessage = {
  eventId: string
  case: LocalSlackCase
  teamId: string
  channelId: string
  /** Slack's channel_type: im, channel (public) or group (private); absent on app_mention. */
  channelType: 'im' | 'channel' | 'group' | null
  userId: string
  /** Their words, without mentions of the bot. */
  text: string
  ts: string
  /** The thread the message belongs to: its root's ts, or its own for a top-level message. */
  threadTs: string
  /** It was written inside an existing thread. */
  inThread: boolean
  mentioned: boolean
}

export type LocalSlackIdentity = { teamId: string; botUserId: string; appId?: string }

const ALLOWED_SUBTYPES = new Set([undefined, 'thread_broadcast', 'file_share'])
const SLACK_TS = /^\d{1,12}\.\d{1,8}$/
const SLACK_ID = /^[A-Z0-9]{2,32}$/

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

export function readLocalSlackEvent(
  payload: unknown,
  identity: LocalSlackIdentity
): LocalSlackMessage | null {
  if (!isSlackRecord(payload) || !isSlackRecord(payload.event)) {
    return null
  }
  const envelope = payload
  const event = payload.event
  const eventId = text(envelope.event_id)
  if (
    envelope.type !== 'event_callback' ||
    !event ||
    !eventId ||
    envelope.team_id !== identity.teamId ||
    (identity.appId !== undefined && envelope.api_app_id !== identity.appId)
  ) {
    return null
  }
  const userId = text(event.user)
  const channelId = text(event.channel)
  const ts = text(event.ts)
  const threadTs = text(event.thread_ts)
  if (
    !userId ||
    !SLACK_ID.test(userId) ||
    userId === identity.botUserId ||
    event.bot_id !== undefined ||
    event.hidden === true ||
    !ALLOWED_SUBTYPES.has(text(event.subtype)) ||
    !channelId ||
    !SLACK_ID.test(channelId) ||
    !ts ||
    !SLACK_TS.test(ts) ||
    (threadTs !== undefined && !SLACK_TS.test(threadTs))
  ) {
    return null
  }
  const channelType = text(event.channel_type)
  const raw = text(event.text) ?? ''
  const token = `<@${identity.botUserId}>`
  const mentioned = raw.includes(token)
  let kind: LocalSlackCase
  if (event.type === 'app_mention') {
    kind = 'mention'
  } else if (event.type === 'message' && channelType === 'im') {
    kind = 'dm'
  } else if (
    event.type === 'message' &&
    (channelType === 'channel' || channelType === 'group') &&
    threadTs !== undefined
  ) {
    // The same message comes as app_mention too: one case for both, whichever arrives first.
    kind = mentioned ? 'mention' : 'thread_reply'
  } else {
    return null
  }
  return {
    eventId,
    case: kind,
    teamId: identity.teamId,
    channelId,
    channelType:
      channelType === 'im' || channelType === 'channel' || channelType === 'group'
        ? channelType
        : null,
    userId,
    text: raw.replaceAll(token, '').trim(),
    ts,
    threadTs: threadTs ?? ts,
    inThread: threadTs !== undefined && threadTs !== ts,
    mentioned
  }
}
