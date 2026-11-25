// Slack event triggers need Orca Cloud's app; a bot on its own Slack app can't take them yet.
import { usesLocalSlack, type BotSlackConnection } from '../../shared/bots/bot-slack-connection'

export const LOCAL_SLACK_TRIGGER_REFUSAL =
  "This bot uses its own Slack app on this computer, which doesn't run Slack automation triggers yet. Use a schedule, or a Linear or GitHub trigger."

/** Throws when a bot on its own Slack app would get a Slack event trigger. */
export function refuseLocalSlackTriggers(
  bot: { slackConnection?: BotSlackConnection } | null | undefined,
  rules: readonly { source: string }[] | undefined
): void {
  if (bot && usesLocalSlack(bot) && rules?.some((rule) => rule.source === 'slack')) {
    throw new Error(LOCAL_SLACK_TRIGGER_REFUSAL)
  }
}
