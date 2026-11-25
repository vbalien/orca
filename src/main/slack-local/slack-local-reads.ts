// What a bot's own Slack app reads before a turn: the thread so far, and people's names.
import { callSlack, slackFields, type SlackFetch } from './slack-web-api'

export type LocalSlackThreadMessage = { ts: string; userId?: string; botId?: string; text: string }

const THREAD_READ_LIMIT = 100
const NAMES_KEPT = 500

export function slackLocalReads(fetchImpl: SlackFetch, botToken: string, signal: AbortSignal) {
  const names = new Map<string, string | undefined>()
  return {
    thread: async (
      channelId: string,
      threadTs: string
    ): Promise<{ messages: LocalSlackThreadMessage[]; complete: boolean }> => {
      const answer = await callSlack(
        fetchImpl,
        'conversations.replies',
        botToken,
        { channel: channelId, ts: threadTs, limit: THREAD_READ_LIMIT },
        signal
      )
      const raw = Array.isArray(answer.messages) ? answer.messages : []
      const messages = raw.flatMap((item): LocalSlackThreadMessage[] => {
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
      return { messages, complete: answer.has_more !== true }
    },
    userName: async (userId: string): Promise<string | undefined> => {
      if (names.has(userId)) {
        return names.get(userId)
      }
      const { user } = await callSlack(fetchImpl, 'users.info', botToken, { user: userId }, signal)
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
