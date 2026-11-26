// What a bot's own Slack app reads before a turn: the thread so far, and people's names.
import { callSlack, slackFields, type SlackFetch } from './slack-web-api'

export type LocalSlackThreadMessage = { ts: string; userId?: string; botId?: string; text: string }

const THREAD_READ_LIMIT = 100
const NAMES_KEPT = 500
// The wake gate's read of what came right before a reply: up to 3 pages of 200 (Slack returns oldest first).
const RECENT_PAGE = 200
const RECENT_PAGES = 3

function threadMessages(answer: Record<string, unknown>): LocalSlackThreadMessage[] {
  const raw = Array.isArray(answer.messages) ? answer.messages : []
  return raw.flatMap((item): LocalSlackThreadMessage[] => {
    const entry = slackFields(item)
    return typeof entry.ts === 'string'
      ? [
          {
            ts: entry.ts,
            text: typeof entry.text === 'string' ? entry.text : '',
            ...(typeof entry.user === 'string' ? { userId: entry.user } : {}),
            ...(typeof entry.bot_id === 'string' ? { botId: entry.bot_id } : {})
          }
        ]
      : []
  })
}

export function slackLocalReads(fetchImpl: SlackFetch, botToken: string, signal: AbortSignal) {
  const names = new Map<string, string | undefined>()
  return {
    thread: async (
      channelId: string,
      threadTs: string,
      readSignal?: AbortSignal
    ): Promise<{ messages: LocalSlackThreadMessage[]; complete: boolean }> => {
      const answer = await callSlack(
        fetchImpl,
        'conversations.replies',
        botToken,
        { channel: channelId, ts: threadTs, limit: THREAD_READ_LIMIT },
        readSignal ? AbortSignal.any([signal, readSignal]) : signal
      )
      return { messages: threadMessages(answer), complete: answer.has_more !== true }
    },
    /** The thread's messages before `beforeTs`, oldest first, within a few pages; `complete` is false
     *  when more remain, so the newest of them were not read. */
    recentThread: async (
      channelId: string,
      threadTs: string,
      beforeTs: string,
      readSignal: AbortSignal
    ): Promise<{ messages: LocalSlackThreadMessage[]; complete: boolean }> => {
      const messages: LocalSlackThreadMessage[] = []
      let cursor: string | undefined
      for (let page = 0; page < RECENT_PAGES; page++) {
        const answer = await callSlack(
          fetchImpl,
          'conversations.replies',
          botToken,
          {
            channel: channelId,
            ts: threadTs,
            latest: beforeTs,
            inclusive: false,
            limit: RECENT_PAGE,
            cursor
          },
          AbortSignal.any([signal, readSignal])
        )
        messages.push(...threadMessages(answer))
        const next = slackFields(answer.response_metadata).next_cursor
        cursor = typeof next === 'string' && next.length > 0 ? next : undefined
        if (answer.has_more !== true || !cursor) {
          return { messages, complete: answer.has_more !== true }
        }
      }
      return { messages, complete: false }
    },
    userName: async (userId: string, readSignal?: AbortSignal): Promise<string | undefined> => {
      if (names.has(userId)) {
        return names.get(userId)
      }
      const { user } = await callSlack(
        fetchImpl,
        'users.info',
        botToken,
        { user: userId },
        readSignal ? AbortSignal.any([signal, readSignal]) : signal
      )
      const profile = slackFields(slackFields(user).profile)
      const name = [profile.display_name, profile.real_name, slackFields(user).name].find(
        (value): value is string => typeof value === 'string' && value.trim().length > 0
      )
      if (names.size >= NAMES_KEPT) {
        names.clear()
      }
      names.set(userId, name?.slice(0, 200))
      return name?.slice(0, 200)
    }
  }
}
