// How a bot's Slack reaches it: through Orca Cloud's app (the default), or through the owner's own
// Slack app that this computer connects to directly. Tokens never live here: they are sealed apart.
import * as z from 'zod'
import { LOCAL_SLACK_SOURCE } from '../connectors/local-slack-conversation'

const SlackId = z.string().regex(/^[A-Z0-9]{2,32}$/)

export const BotSlackConnectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('orca') }),
  z.object({
    mode: z.literal('local'),
    // Read from the saved bot token (auth.test); absent until tokens are saved.
    teamId: SlackId.optional(),
    teamName: z.string().max(200).optional(),
    appId: SlackId.optional(),
    botUserId: SlackId.optional(),
    /** The owner's own Slack member id in that workspace: their requests act as the owner. */
    ownerUserId: SlackId.optional()
  })
])
export type BotSlackConnection = z.infer<typeof BotSlackConnectionSchema>
export type BotSlackLocalConnection = Extract<BotSlackConnection, { mode: 'local' }>

type WithConnection = { slackConnection?: BotSlackConnection | undefined }

export function localSlackConnection(bot: WithConnection): BotSlackLocalConnection | null {
  return bot.slackConnection?.mode === 'local' ? bot.slackConnection : null
}

export function usesLocalSlack(bot: WithConnection): boolean {
  return localSlackConnection(bot) !== null
}

export function botUsesLocalSlack(
  bots: readonly (WithConnection & { id: string })[],
  botId: string
): boolean {
  return bots.some((bot) => bot.id === botId && usesLocalSlack(bot))
}

type AskerMember = { id: string; source?: string; workspaceId?: string }

/** Who may ask through the local app: the owner, and the people added for its current workspace. */
export function localSlackAskers(bot: WithConnection & { members: readonly AskerMember[] }): {
  ownerUserId: string | null
  members: string[]
} {
  const local = localSlackConnection(bot)
  if (!local?.teamId) {
    return { ownerUserId: null, members: [] }
  }
  return {
    ownerUserId: local.ownerUserId ?? null,
    members: bot.members
      .filter(
        (member) => member.source === LOCAL_SLACK_SOURCE && member.workspaceId === local.teamId
      )
      .map((member) => member.id)
  }
}
