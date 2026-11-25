// `bots.slackGate.*`: a bot's Slack wake gate and its key, changed from the owner's Orca only.
import * as z from 'zod'
import { BotSlackGateSchema } from '../bots/bot-slack-gate'

const BotId = z.string().trim().min(1).max(200)

export const SlackGateBot = z.object({ botId: BotId })
/** The whole gate; null removes it (a saved key stays until removed on its own). */
export const SlackGateSet = z.object({ botId: BotId, gate: BotSlackGateSchema.nullable() })
export const SlackGateSetKey = z.object({ botId: BotId, key: z.string().trim().min(1).max(512) })

/** What a client may know about the key: whether one is saved, never the key. */
export type SlackGateKeyStatus = { apiKeySet: boolean; sealing: 'os-keychain' | 'unavailable' }
