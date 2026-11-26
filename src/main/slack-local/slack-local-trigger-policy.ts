// Slack event triggers need Orca Cloud's app; a bot on its own Slack app can't take them yet.
import { usesLocalSlack, type BotSlackConnection } from '../../shared/bots/bot-slack-connection'

export const LOCAL_SLACK_TRIGGER_REFUSAL =
  "This bot uses its own Slack app, which doesn't run Slack automation triggers yet. Use a schedule, or a Linear or GitHub trigger."

/** Throws when a bot on its own Slack app would get a Slack event trigger. */
export function refuseLocalSlackTriggers(
  bot: { slackConnection?: BotSlackConnection } | null | undefined,
  rules: readonly { source: string }[] | undefined
): void {
  if (bot && usesLocalSlack(bot) && rules?.some((rule) => rule.source === 'slack')) {
    throw new Error(LOCAL_SLACK_TRIGGER_REFUSAL)
  }
}

type TriggerRules = readonly { source: string }[]

/** Throws when an update leaves an enabled automation with Slack triggers on a bot on its own Slack
 *  app: the bot it will run for (a retarget keeps the rules it had), with the rules it will have.
 *  An update that changes neither rules, enabling nor bot isn't refused for rules it already had. */
export function refuseLocalSlackTriggersOnUpdate(
  bots: readonly { id: string; slackConnection?: BotSlackConnection }[],
  current: { botId: string; enabled: boolean; on: TriggerRules | undefined },
  patch: { botId?: string; enabled?: boolean; on?: TriggerRules }
): void {
  const botId = patch.botId ?? current.botId
  if (!(patch.enabled ?? current.enabled)) {
    return
  }
  const rules = patch.on ?? (patch.enabled || botId !== current.botId ? current.on : undefined)
  refuseLocalSlackTriggers(
    bots.find((bot) => bot.id === botId),
    rules
  )
}
