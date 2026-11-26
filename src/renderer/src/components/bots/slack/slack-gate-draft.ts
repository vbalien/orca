// The "Check before waking" form's state, how it turns into the gate the save RPC takes, and the save.
import { refreshBotHost } from '@/lib/bot-catalog'
import { callBotRpc } from '@/lib/bot-hosts'
import type { Bot } from '../../../../../shared/bot-types'
import {
  BotSlackGateEditSchema,
  effectiveSlackGate,
  type BotSlackGate,
  type BotSlackGateEdit,
  type SlackGateSettingCase
} from '../../../../../shared/bots/bot-slack-gate'
import {
  formatSlackGateRulesText,
  parseSlackGateRulesText
} from '../../../../../shared/bots/slack-gate-rules-text'
import { SLACK_GATE_DEFAULT_RULES } from '../../../../../shared/bots/slack-gate-default-rules'
import { saveSlackGate } from './rules/slack-gate-save'

export type SlackGateDraft = {
  on: boolean
  kind: BotSlackGate['kind']
  appliesTo: SlackGateSettingCase[]
  /** Channel messages are checked (own Slack app), in these channels. */
  channelMessages: boolean
  channelsText: string
  timeoutSeconds: number
  onError: BotSlackGate['onError']
  command: string
  rulesText: string
  rulesCommand: string
}

const CHANNEL_ID = /^[CG][A-Z0-9]{2,31}$/

/** The channel ids typed, split on commas, spaces and lines; null when one isn't an id. */
export function channelIdsOf(text: string): string[] | null {
  const ids = [...new Set(text.split(/[\s,]+/).filter(Boolean))]
  return ids.every((entry) => CHANNEL_ID.test(entry)) ? ids : null
}

/** A gate kind this Orca runs; an older host or a kept list can carry another (TypeSafe Jev). */
export function knownGate(gate: Bot['slackGate']): BotSlackGate | null {
  return gate?.kind === 'openai' || gate?.kind === 'command' ? gate : null
}

// A new gate is on and checks only thread replies with the default rules (mentions and DMs wake as
// before), and wakes when the check fails: a missed request costs more than an extra wake.
export function draftOf(saved: Bot['slackGate']): SlackGateDraft {
  const known = knownGate(saved)
  const gate = known ? effectiveSlackGate(known) : null
  return {
    on: gate?.on ?? true,
    kind: gate?.kind ?? 'openai',
    appliesTo: gate ? [...gate.appliesTo] : ['thread_reply'],
    channelMessages: gate?.channelMessages !== undefined,
    channelsText: gate?.channelMessages?.channels.join(', ') ?? '',
    timeoutSeconds: gate?.timeoutSeconds ?? 10,
    onError: gate?.onError ?? 'wake',
    command: gate?.kind === 'command' ? gate.command : '',
    rulesText: formatSlackGateRulesText(
      gate?.kind === 'openai' ? gate.openai : SLACK_GATE_DEFAULT_RULES
    ),
    rulesCommand: gate?.kind === 'openai' ? (gate.rulesCommand ?? '') : ''
  }
}

/** The gate the form describes, or null while something in it is invalid. */
export function gateOf(draft: SlackGateDraft): BotSlackGateEdit | null {
  const channels = draft.channelMessages ? channelIdsOf(draft.channelsText) : []
  if (channels === null || (draft.channelMessages && channels.length === 0)) {
    return null
  }
  const common = {
    on: draft.on,
    appliesTo: draft.appliesTo,
    ...(draft.channelMessages ? { channelMessages: { channels } } : {}),
    timeoutSeconds: draft.timeoutSeconds,
    onError: draft.onError
  }
  const rules = draft.kind === 'openai' ? parseSlackGateRulesText(draft.rulesText) : null
  if (rules && !rules.ok) {
    return null
  }
  const parsed = BotSlackGateEditSchema.safeParse(
    draft.kind === 'command'
      ? { ...common, kind: 'command', command: draft.command }
      : {
          ...common,
          kind: 'openai',
          openai: rules?.config,
          ...(draft.rulesCommand.trim() ? { rulesCommand: draft.rulesCommand.trim() } : {})
        }
  )
  return parsed.success ? parsed.data : null
}

/** Saves the gate (null removes it) on the bot's host, then reads its bots again; false when the host
 *  could not keep its copy for older builds. */
export async function saveGate(
  bot: Bot,
  gate: BotSlackGateEdit | null,
  hostHasFeatures: boolean
): Promise<boolean> {
  try {
    return await saveSlackGate(
      (method, params) => callBotRpc(bot, method, params),
      bot.id,
      gate,
      hostHasFeatures
    )
  } finally {
    await refreshBotHost(bot.hostId)
  }
}
