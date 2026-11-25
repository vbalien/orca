// `bots.slackLocal.*`: a bot's own Slack app on this computer. Tokens only ever come in; no answer
// carries them back.
import * as z from 'zod'

const Id = z.string().min(1).max(256)
const SlackId = z.string().regex(/^[A-Z0-9]{2,32}$/)
// Bounded for transport; the host checks the xoxb-/xapp- shape itself.
const Token = z.string().trim().min(1).max(600)

export const BotSlackLocalBot = z.object({ botId: Id })
export const BotSlackLocalUseOrca = z.object({ botId: Id, forgetTokens: z.boolean() })
export const BotSlackLocalTokens = z
  .object({ botId: Id, botToken: Token.optional(), appToken: Token.optional() })
  .refine((value) => value.botToken !== undefined || value.appToken !== undefined)
export const BotSlackLocalOwner = z.object({
  botId: Id,
  expectedTeamId: SlackId,
  ownerUserId: SlackId.nullable()
})
export const BotSlackLocalAskers = z.object({
  botId: Id,
  expectedTeamId: SlackId,
  askers: z
    .array(z.object({ id: SlackId, name: z.string().trim().min(1).max(200).optional() }))
    .min(1)
    .max(50)
})
