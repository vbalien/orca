import { botLinearWorkspaces, botSlackApps, type Bot } from '../bot-types'

/** Whether the cloud can bring the bot work: a Slack app, a Linear workspace or a GitHub link. */
export function botHasConnector(
  bot: Pick<Bot, 'slack' | 'slackApps' | 'linear' | 'linearWorkspaces' | 'github'>
): boolean {
  return botSlackApps(bot).length > 0 || botLinearWorkspaces(bot).length > 0 || bot.github !== null
}
