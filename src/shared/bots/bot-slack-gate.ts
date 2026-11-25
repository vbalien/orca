// A bot's Slack wake gate: a check that runs before a Slack message (or automation event) wakes the
// bot. Independent of how Slack reaches Orca, so any Slack connector can ask the same decision.
import * as z from 'zod'
import type { StoredSlackGateJev } from './slack-gate-jev-config'
import { validateStoredSlackGateJev } from './slack-gate-jev-validate'

export const SLACK_GATE_CASES = ['mention', 'dm', 'thread_reply', 'trigger'] as const
export type SlackGateCase = (typeof SLACK_GATE_CASES)[number]

export const SLACK_GATE_MAX_TIMEOUT_SECONDS = 20
export const SLACK_GATE_DEFAULT_MODEL = 'jev-latest'

const nonBlank = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0)

const common = {
  on: z.boolean(),
  appliesTo: z.array(z.enum(SLACK_GATE_CASES)).min(1).max(SLACK_GATE_CASES.length),
  timeoutSeconds: z.number().int().min(1).max(SLACK_GATE_MAX_TIMEOUT_SECONDS),
  onError: z.enum(['wake', 'block'])
}

/** Today's jev shape exactly as builds before configurable rules read it (they strip unknown keys).
 *  Frozen: every saved gate must keep parsing with it, or a rollback would drop the gate. */
export const LegacyBotSlackGateJevSchema = z.object({
  question: nonBlank(2000),
  threshold: z.number().min(0).max(1),
  model: z.string().trim().max(100).optional()
})

/** A config of TypeSafe questions and rules (with the mirror older builds read), or the legacy
 *  one-question gate. Checked field by field by the same validator the editor uses. */
export const BotSlackGateJevSchema = z
  .custom<StoredSlackGateJev>()
  .superRefine((value, context) => {
    for (const issue of validateStoredSlackGateJev(value)) {
      context.addIssue({
        code: 'custom',
        path: issue.path,
        message: `${issue.code}${issue.params ? ` ${JSON.stringify(issue.params)}` : ''}`
      })
    }
  })

export const BotSlackGateSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('command'), command: nonBlank(2000) }),
  z.object({ ...common, kind: z.literal('jev'), jev: BotSlackGateJevSchema })
])
export type BotSlackGate = z.infer<typeof BotSlackGateSchema>

/** One Slack message or event as every Slack connector hands it to the gate. Untrusted text. */
export type SlackGateEvent = {
  eventId: string
  case: SlackGateCase
  /** The source can't tell a mention from a plain reply: either selected case applies. */
  mentionUnknown?: true
  teamId: string
  channelId: string
  placeKind: 'direct_message' | 'group_message' | 'public_channel' | 'private_channel' | 'channel'
  threadTs?: string
  messageTs?: string
  from: { userId: string; name?: string; role?: 'owner' | 'member'; app?: boolean; viaBot?: string }
  text: string
  /** Messages that wait in the same turn behind this one, each with its own case. */
  later?: { case: SlackGateCase; mentionUnknown?: true; text: string }[]
  /** A bare mention's request: the asker's own earlier messages; incomplete when parts are missing. */
  earlierOwn?: { texts: string[]; incomplete?: true }
  mentioned?: boolean
  context?: { kind: string; userId?: string; name?: string; text: string }[]
  trigger?: { automationId: string; triggerId: string; event: string }
  /** Texts were cut to fit the gate's input. */
  truncated?: true
  /** The thread's earlier messages are partly missing or could not be read. Never in command stdin:
   *  only Jev configs with rules read it. */
  contextIncomplete?: 'more' | 'unreadable'
}

function caseApplies(
  appliesTo: readonly SlackGateCase[],
  entry: { case: SlackGateCase; mentionUnknown?: true }
): boolean {
  if (appliesTo.includes(entry.case)) {
    return true
  }
  return (
    entry.mentionUnknown === true &&
    (entry.case === 'thread_reply' || entry.case === 'mention') &&
    (appliesTo.includes('mention') || appliesTo.includes('thread_reply'))
  )
}

/** The one applicability rule: the gate is on and the event, or any message in its turn, is selected. */
export function slackGateApplies(
  bot: { slackGate?: BotSlackGate | null | undefined },
  event: Pick<SlackGateEvent, 'case' | 'mentionUnknown' | 'later'>
): boolean {
  const gate = bot.slackGate
  if (!gate?.on) {
    return false
  }
  return [event, ...(event.later ?? [])].some((entry) => caseApplies(gate.appliesTo, entry))
}

/** Whether an update changes the command a gate runs (null/absent gates run none). */
export function slackGateCommandChanged(
  before: BotSlackGate | null | undefined,
  after: BotSlackGate | null | undefined
): boolean {
  const command = (gate: BotSlackGate | null | undefined) =>
    gate?.kind === 'command' ? gate.command : null
  return after !== undefined && command(before) !== command(after)
}
