// `bots.slackLocal.*`: a bot's own Slack app on its Electron host (the desktop app or `orca serve`).
// The owner's Orca changes it, here or on a paired computer; never an agent's CLI. Tokens go in and
// never come back out.
import {
  BotSlackLocalAskers,
  BotSlackLocalBot,
  BotSlackLocalOwner,
  BotSlackLocalTokens,
  BotSlackLocalUseOrca
} from '../../../../shared/rpc-contract/bots-slack-local-params'
import { withSlackConfigLock } from '../../../slack-local/slack-config-lock'
import { slackLocalService, type SlackLocalService } from '../../../slack-local/slack-local-service'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'
import { ownerOnly } from './bots-caller-gates'

const REFUSAL = 'Only your owner sets up your own Slack app, in Orca.'

function ownerHost(context: RpcContext): SlackLocalService {
  ownerOnly(context, REFUSAL)
  const service = slackLocalService()
  if (!service) {
    throw new InvalidArgumentError(
      "Your own Slack app needs Orca's Electron runtime on the bot's computer: the desktop app, or `orca serve` with ORCA_SERVE_RUNTIME=electron."
    )
  }
  return service
}

/** A change under the Slack config lock, answered with the bot's status (never its tokens). */
async function change(
  context: RpcContext,
  botId: string,
  run: (service: SlackLocalService) => Promise<void>
) {
  const service = ownerHost(context)
  await withSlackConfigLock(() => run(service))
  return await service.status(botId)
}

export const BOT_SLACK_LOCAL_METHODS = [
  defineMethod({
    name: 'bots.slackLocal.status',
    permission: 'accounts-admin',
    params: BotSlackLocalBot,
    handler: async ({ botId }, context) => ownerHost(context).status(botId)
  }),
  defineMethod({
    name: 'bots.slackLocal.useLocal',
    permission: 'accounts-admin',
    params: BotSlackLocalBot,
    handler: ({ botId }, context) =>
      change(context, botId, (service) => service.config.useLocal(botId))
  }),
  defineMethod({
    name: 'bots.slackLocal.useOrca',
    permission: 'accounts-admin',
    params: BotSlackLocalUseOrca,
    handler: ({ botId, forgetTokens }, context) =>
      change(context, botId, (service) => service.config.useOrca(botId, forgetTokens))
  }),
  defineMethod({
    name: 'bots.slackLocal.setTokens',
    permission: 'accounts-admin',
    params: BotSlackLocalTokens,
    handler: ({ botId, botToken, appToken }, context) =>
      change(context, botId, (service) =>
        service.config.setTokens(botId, {
          ...(botToken ? { botToken } : {}),
          ...(appToken ? { appToken } : {})
        })
      )
  }),
  defineMethod({
    name: 'bots.slackLocal.setOwner',
    permission: 'accounts-admin',
    params: BotSlackLocalOwner,
    handler: ({ botId, expectedTeamId, ownerUserId }, context) =>
      change(context, botId, (service) =>
        service.config.setOwner(botId, expectedTeamId, ownerUserId)
      )
  }),
  defineMethod({
    name: 'bots.slackLocal.addAskers',
    permission: 'accounts-admin',
    params: BotSlackLocalAskers,
    handler: ({ botId, expectedTeamId, askers }, context) =>
      change(context, botId, (service) => service.config.addAskers(botId, expectedTeamId, askers))
  })
]
