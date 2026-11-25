// What a bot's own Slack app looks like to its settings: never its tokens.
import type { Bot } from '../../shared/bot-types'
import { localSlackConnection } from '../../shared/bots/bot-slack-connection'
import { LOCAL_SLACK_SOURCE } from '../../shared/connectors/local-slack-conversation'
import type { SocketModeState } from './slack-socket-mode-client'
import type { SlackLocalTokenStore } from './slack-local-token-store'
import type { SlackLocalStatus } from '../../shared/bots/slack-local-status-contract'

export type { SlackLocalStatus } from '../../shared/bots/slack-local-status-contract'

export type SlackLocalAutomations = {
  listAutomations?: () => readonly {
    name: string
    enabled: boolean
    bot?: { botId: string } | null
    on?: readonly { source: string }[]
  }[]
}

/** Enabled automations of the bot with Slack triggers, which don't run on its own app yet. */
export function slackTriggerAutomations(store: SlackLocalAutomations, botId: string): string[] {
  return (store.listAutomations?.() ?? [])
    .filter(
      (automation) =>
        automation.enabled &&
        automation.bot?.botId === botId &&
        (automation.on ?? []).some((rule) => rule.source === 'slack')
    )
    .map((automation) => automation.name)
}

export async function slackLocalStatus(input: {
  bot: Bot | null
  running: SocketModeState | null
  /** Bots are on and this one isn't paused: it listens when it can. */
  listening: boolean
  /** Why it isn't connected, when it isn't for a reason worth saying. */
  problem: string | null
  lastReplyError: string | null
  tokens: SlackLocalTokenStore
  slackTriggerAutomations: string[]
}): Promise<SlackLocalStatus> {
  const { bot, running, problem, lastReplyError } = input
  const local = bot ? localSlackConnection(bot) : null
  const refusal = input.tokens.sealingRefusal()
  const connection: SlackLocalStatus['connection'] = !local
    ? { state: 'off' }
    : !input.listening
      ? { state: 'paused' }
      : running
        ? running.state === 'error'
          ? { state: 'error', error: running.error }
          : { state: running.state === 'connected' ? 'connected' : 'connecting' }
        : problem === 'needs_tokens'
          ? { state: 'needs_tokens' }
          : problem
            ? { state: 'error', error: problem }
            : { state: 'connecting' }
  return {
    mode: local ? 'local' : 'orca',
    tokens: { saved: bot ? await input.tokens.has(bot.id).catch(() => false) : false },
    ...(local?.teamId ? { teamId: local.teamId } : {}),
    ...(local?.teamName ? { teamName: local.teamName } : {}),
    ...(local?.appId ? { appId: local.appId } : {}),
    ...(local?.botUserId ? { botUserId: local.botUserId } : {}),
    ...(local?.ownerUserId ? { ownerUserId: local.ownerUserId } : {}),
    askers: (bot?.members ?? [])
      .filter(
        (member) => member.source === LOCAL_SLACK_SOURCE && member.workspaceId === local?.teamId
      )
      .map((member) => ({ id: member.id, name: member.name })),
    connection,
    ...(lastReplyError ? { lastReplyError } : {}),
    sealing: refusal ? { ok: false, reason: refusal } : { ok: true },
    slackTriggerAutomations: input.slackTriggerAutomations
  }
}
