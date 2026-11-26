// `bots.slackGate.*`: a bot's Slack wake gate and its keys, changed by the owner's Orca, here or
// paired (never an agent's CLI); a gate's command changes only on the bot's computer.
import * as z from 'zod'
import { BotSlackGateSchema } from '../bots/bot-slack-gate'

const BotId = z.string().trim().min(1).max(200)

export const SlackGateBot = z.object({ botId: BotId })
/** The whole gate; null removes it (a saved key stays until removed on its own). */
export const SlackGateSet = z.object({ botId: BotId, gate: BotSlackGateSchema.nullable() })
/** Printable ASCII only: a key travels in an HTTP header and an environment variable. */
export const SlackGateSetKey = z.object({
  botId: BotId,
  key: z
    .string()
    .trim()
    .regex(/^[\x21-\x7e]{1,512}$/, 'An API key is one line of printable characters')
})

/** What a client may know about the keys: whether each is saved, never a key. Older hosts send no
 *  `openaiKeySet`. */
export type SlackGateKeyStatus = {
  apiKeySet: boolean
  openaiKeySet?: boolean
  sealing: 'os-keychain' | 'unavailable'
}
