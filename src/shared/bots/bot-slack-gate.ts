// A bot's Slack wake gate: a check that runs before a Slack message (or automation event) wakes the
// bot. Independent of how Slack reaches Orca, so any Slack connector can ask the same decision.
import * as z from 'zod'
import { isPlainObject, type SlackGateRulesConfig } from './slack-gate-rules-config'
import { validateSlackGateRules } from './slack-gate-rules-validate'

export const SLACK_GATE_CASES = ['mention', 'dm', 'thread_reply', 'trigger'] as const
export type SlackGateCase = (typeof SLACK_GATE_CASES)[number]

export const SLACK_GATE_MAX_TIMEOUT_SECONDS = 20
export const SLACK_GATE_OPENAI_DEFAULT_MODEL = 'gpt-6-luna'

/** Context items without text, shown to every gate kind by these words. */
export const SLACK_GATE_CONTEXT_MARKER_TEXT = {
  more: '(earlier messages in this thread are not shown)',
  unreadable: '(this thread could not be read)'
} as const

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

/** OpenAI Decisions questions and the rules over their answers, checked field by field by the same
 *  validator the editor uses. */
export const BotSlackGateOpenAISchema = z
  .custom<SlackGateRulesConfig>()
  .superRefine((value, context) => {
    const result = validateSlackGateRules(value)
    for (const issue of result.ok ? [] : result.issues) {
      context.addIssue({
        code: 'custom',
        path: issue.path,
        message: `${issue.code}${issue.params ? ` ${JSON.stringify(issue.params)}` : ''}`
      })
    }
  })

export const BotSlackGateSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('command'), command: nonBlank(2000) }),
  z.object({ ...common, kind: z.literal('openai'), openai: BotSlackGateOpenAISchema })
])
export type BotSlackGate = z.infer<typeof BotSlackGateSchema>

/** One Slack message or event as every Slack connector hands it to the gate. Untrusted text. */
export type SlackGateEvent = {
  eventId: string
  case: SlackGateCase
  /** The source can't tell a mention from a plain reply: checked only when both are selected. */
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
  /** Earlier thread messages; kind `self` is the bot itself as the host checked it (OpenAI gates only),
   *  `bot` any Slack app. */
  context?: { kind: string; userId?: string; name?: string; text: string }[]
  trigger?: { automationId: string; triggerId: string; event: string }
  /** Texts were cut to fit the gate's input. */
  truncated?: true
  /** The thread's earlier messages are partly missing or could not be read. Never in command stdin. */
  contextIncomplete?: 'more' | 'unreadable'
}

function caseApplies(
  appliesTo: readonly SlackGateCase[],
  entry: { case: SlackGateCase; mentionUnknown?: true }
): boolean {
  // A missed mention costs more than a needless wake: a message that may be either is checked
  // only when both are.
  if (entry.mentionUnknown) {
    return appliesTo.includes('mention') && appliesTo.includes('thread_reply')
  }
  return appliesTo.includes(entry.case)
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

/** How incomplete a thread's context is, by its marker items: unreadable wins over more, whatever
 *  their order, since a gate that needs the thread treats unreadable as a failed check. */
export function slackGateContextIncomplete(
  items: readonly { kind: string }[] | undefined
): 'unreadable' | 'more' | undefined {
  const kinds = new Set((items ?? []).map((item) => item.kind))
  return kinds.has('unreadable') ? 'unreadable' : kinds.has('more') ? 'more' : undefined
}

/** A stored bot whose gate is of the TypeSafe Jev kind, which this build no longer runs: the gate reads
 *  as none, never as another kind. */
export function hasRetiredJevGate(rawBot: unknown): boolean {
  return isPlainObject(rawBot) && isPlainObject(rawBot.slackGate) && rawBot.slackGate.kind === 'jev'
}
