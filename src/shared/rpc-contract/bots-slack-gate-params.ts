// `bots.slackGate.*`: a bot's Slack wake gate and its keys, changed by the owner's Orca, here or
// paired (never an agent's CLI); a gate's command changes only on the bot's computer.
import * as z from 'zod'
import { BotSlackGateEditSchema, BotSlackGateSchema } from '../bots/bot-slack-gate'

const BotId = z.string().trim().min(1).max(200)

export const SlackGateBot = z.object({ botId: BotId })
/** The whole gate; null removes it (a saved key stays until removed on its own). */
export const SlackGateSet = z.object({ botId: BotId, gate: BotSlackGateSchema.nullable() })
/** The whole gate as the editor has it (channel messages, a rules script, notes and limits included);
 *  the host stores what older builds can read beside it. Older hosts don't know this method. */
export const SlackGateStore = z.object({ botId: BotId, gate: BotSlackGateEditSchema.nullable() })
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
  /** What this host's gate can do beyond the first OpenAI gates; absent on older hosts. */
  features?: SlackGateFeature[]
  /** The rules script's last run here (no message text); absent until it ran. */
  scriptRun?: { at: number; outcome: 'verdict' | 'ask' | 'useSaved' | 'error'; error?: string }
  /** A copy of settings an older Orca dropped can be put back (bots.slackGate.restore). */
  restorable?: boolean
  /** Wakes of limited rules still waiting to be counted, and the oldest one's age. */
  /** heldUntil: limited rules are held after an unreadable counts file, until then (or until the
   *  file is replaced). */
  pendingWakes?: { pending: number; oldestMs?: number; heldUntil?: number | 'replaced' }
}

export const SLACK_GATE_FEATURES = ['channelMessages', 'rulesCommand', 'ruleLimits'] as const
export type SlackGateFeature = (typeof SLACK_GATE_FEATURES)[number]
