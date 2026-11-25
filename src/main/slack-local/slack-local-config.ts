// Changing a bot's own Slack app: which app it uses, its tokens, its owner and the people who may
// ask. Each runs inside withSlackConfigLock (the RPC handlers take it).
import type { Bot } from '../../shared/bot-types'
import { localSlackConnection, usesLocalSlack } from '../../shared/bots/bot-slack-connection'
import { LOCAL_SLACK_SOURCE } from '../../shared/connectors/local-slack-conversation'
import { withBotsCloudClient } from '../connector-cloud/bots-cloud-client'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { slackTriggerAutomations, type SlackLocalAutomations } from './slack-local-status'
import {
  isSlackAppToken,
  isSlackBotToken,
  type SlackLocalSecrets,
  type SlackLocalTokenStore
} from './slack-local-token-store'
import { LOCAL_SLACK_TRIGGER_REFUSAL } from './slack-local-trigger-policy'
import { slackBotIdentity, SlackApiError, type SlackFetch } from './slack-web-api'
import { socketModeAppId, type SocketModeSocket } from './slack-socket-mode-client'

export class SlackLocalConfigError extends Error {}

export type SlackLocalConfigDeps = {
  runtime: Pick<OrcaRuntimeService, 'bots' | 'getConnectorCloud'>
  store: SlackLocalAutomations
  tokens: SlackLocalTokenStore
  fetch: SlackFetch
  socketFactory?: (url: string) => SocketModeSocket
  /** The running connections, told of each change. */
  host: {
    release: (botId: string) => void
    reconcile: () => void
    restart: (botId: string) => Promise<void>
  }
}

/** Whether another bot's record already names this app (its workspace and bot user). */
export function claimedByAnother(
  bots: readonly Bot[],
  botId: string,
  identity: { teamId: string; botUserId: string }
): boolean {
  return bots.some((other) => {
    const local = localSlackConnection(other)
    return (
      other.id !== botId &&
      local?.teamId === identity.teamId &&
      local.botUserId === identity.botUserId
    )
  })
}

export class SlackLocalConfig {
  constructor(private readonly deps: SlackLocalConfigDeps) {}

  async useLocal(botId: string): Promise<void> {
    const bot = this.requireBot(botId)
    if (usesLocalSlack(bot)) {
      return
    }
    if ((bot.slackApps?.length ?? 0) > 0 || bot.slack) {
      throw new SlackLocalConfigError(
        "Remove this bot's Orca Cloud Slack app first (its Slack settings, Remove), then use your own app."
      )
    }
    if (slackTriggerAutomations(this.deps.store, botId).length > 0) {
      throw new SlackLocalConfigError(LOCAL_SLACK_TRIGGER_REFUSAL)
    }
    // Signed in, the cloud says whether an app exists that this computer hasn't recorded.
    const cloud = this.deps.runtime.getConnectorCloud()
    if (cloud?.signedInAccount()) {
      const state = await withBotsCloudClient(cloud, (client) => client.slackState(botId))
      const states = state.ok ? [state.value, ...(state.value.teams ?? [])] : []
      if (
        states.some((entry) => entry.state !== 'not_created' && entry.state !== 'grant_expired')
      ) {
        throw new SlackLocalConfigError(
          'Orca Cloud still has a Slack app for this bot. Remove it in its Slack settings first.'
        )
      }
    }
    await this.deps.runtime.bots.update(botId, (current) => {
      if ((current.slackApps?.length ?? 0) > 0 || current.slack) {
        throw new SlackLocalConfigError("Remove this bot's Orca Cloud Slack app first.")
      }
      return { slackConnection: { mode: 'local' } }
    })
    this.deps.host.reconcile()
  }

  async useOrca(botId: string, forgetTokens: boolean): Promise<void> {
    this.requireBot(botId)
    this.deps.host.release(botId)
    await this.deps.runtime.bots.update(botId, (current) => ({
      slackConnection: { mode: 'orca' },
      members: current.members.filter((member) => member.source !== LOCAL_SLACK_SOURCE)
    }))
    if (forgetTokens) {
      await this.deps.tokens.remove(botId)
    }
    this.deps.host.reconcile()
  }

  /** Validates new tokens with Slack, then saves them and the workspace they belong to together. */
  async setTokens(botId: string, given: { botToken?: string; appToken?: string }): Promise<void> {
    const bot = this.requireBot(botId)
    if (!usesLocalSlack(bot)) {
      throw new SlackLocalConfigError('Choose your own Slack app for this bot first.')
    }
    const refusal = this.deps.tokens.sealingRefusal()
    if (refusal) {
      throw new SlackLocalConfigError(refusal)
    }
    const saved = await this.deps.tokens.read(botId).catch(() => null)
    const botToken = given.botToken?.trim() || saved?.botToken
    const appToken = given.appToken?.trim() || saved?.appToken
    if (!botToken || !isSlackBotToken(botToken)) {
      throw new SlackLocalConfigError('Paste the Bot User OAuth Token, which starts with xoxb-.')
    }
    if (!appToken || !isSlackAppToken(appToken)) {
      throw new SlackLocalConfigError('Paste the App-Level Token, which starts with xapp-.')
    }
    let identity: Awaited<ReturnType<typeof slackBotIdentity>>
    let socketAppId: string | null
    try {
      identity = await slackBotIdentity(this.deps.fetch, botToken)
      socketAppId = await socketModeAppId(this.deps.fetch, appToken, this.deps.socketFactory)
    } catch (error) {
      throw new SlackLocalConfigError(
        `Slack didn't accept these tokens (${error instanceof SlackApiError ? error.code : 'network'}).`
      )
    }
    if (!identity.appId) {
      throw new SlackLocalConfigError("Slack didn't say which app this bot token belongs to.")
    }
    // Both tokens must be the same app's, checked before either replaces what works.
    if (socketAppId !== null && socketAppId !== identity.appId) {
      throw new SlackLocalConfigError('The two tokens belong to different Slack apps.')
    }
    const secrets: SlackLocalSecrets = {
      botToken,
      appToken,
      teamId: identity.teamId,
      botUserId: identity.botUserId,
      appId: identity.appId
    }
    if (claimedByAnother(this.deps.runtime.bots.list(), botId, secrets)) {
      throw new SlackLocalConfigError(
        'Another bot already uses this Slack app. Each bot needs its own app.'
      )
    }
    const previous = await this.deps.tokens.readSealed(botId)
    await this.deps.tokens.write(botId, secrets)
    try {
      await this.deps.runtime.bots.update(botId, (current) => {
        if (!usesLocalSlack(current)) {
          throw new SlackLocalConfigError('This bot no longer uses its own Slack app.')
        }
        if (claimedByAnother(this.deps.runtime.bots.list(), botId, secrets)) {
          throw new SlackLocalConfigError('Another bot already uses this Slack app.')
        }
        return identityUpdate(current, secrets, identity.teamName)
      })
    } catch (error) {
      // The pair that worked goes back; a bot deleted meanwhile keeps no tokens at all.
      const exists = this.deps.runtime.bots.list().some((entry) => entry.id === botId)
      await this.deps.tokens.writeSealed(botId, exists ? previous : null)
      throw error
    }
    await this.deps.host.restart(botId)
  }

  async setOwner(botId: string, expectedTeamId: string, ownerUserId: string | null): Promise<void> {
    await this.deps.runtime.bots.update(botId, (current) => {
      const local = requireTeam(current, expectedTeamId)
      const { ownerUserId: _old, ...rest } = local
      return { slackConnection: ownerUserId ? { ...rest, ownerUserId } : rest }
    })
  }

  async addAskers(
    botId: string,
    expectedTeamId: string,
    askers: readonly { id: string; name?: string }[]
  ): Promise<void> {
    await this.deps.runtime.bots.update(botId, (current) => {
      requireTeam(current, expectedTeamId)
      return {
        addMembers: askers.map((asker) => ({
          id: asker.id,
          name: asker.name ?? asker.id,
          source: LOCAL_SLACK_SOURCE,
          workspaceId: expectedTeamId
        }))
      }
    })
  }

  private requireBot(botId: string): Bot {
    const bot = this.deps.runtime.bots.list().find((entry) => entry.id === botId)
    if (!bot) {
      throw new SlackLocalConfigError('No such bot.')
    }
    return bot
  }
}

function requireTeam(bot: Bot, expectedTeamId: string) {
  const local = localSlackConnection(bot)
  if (!local || local.teamId !== expectedTeamId) {
    throw new SlackLocalConfigError('team_changed')
  }
  return local
}

/** The bot's record for these tokens: a new workspace drops the old one's people and owner. */
export function identityUpdate(
  current: Bot,
  secrets: Pick<SlackLocalSecrets, 'teamId' | 'botUserId' | 'appId'>,
  teamName: string | undefined
) {
  const local = localSlackConnection(current)
  const sameTeam = local?.teamId === secrets.teamId
  return {
    slackConnection: {
      mode: 'local' as const,
      teamId: secrets.teamId,
      botUserId: secrets.botUserId,
      appId: secrets.appId,
      ...(teamName
        ? { teamName }
        : sameTeam && local?.teamName
          ? { teamName: local.teamName }
          : {}),
      ...(sameTeam && local?.ownerUserId ? { ownerUserId: local.ownerUserId } : {})
    },
    ...(sameTeam
      ? {}
      : {
          members: current.members.filter(
            (member) =>
              member.source !== LOCAL_SLACK_SOURCE || member.workspaceId === secrets.teamId
          )
        })
  }
}

/** A crash between saving tokens and recording their workspace: the file is the truth when no
 *  other bot claims that app. False when the pair can't be made to match. */
export async function repairLocalIdentity(
  runtime: Pick<OrcaRuntimeService, 'bots'>,
  bot: Bot,
  secrets: SlackLocalSecrets
): Promise<boolean> {
  const local = localSlackConnection(bot)
  if (local?.teamId === secrets.teamId && local.botUserId === secrets.botUserId) {
    return true
  }
  if (claimedByAnother(runtime.bots.list(), bot.id, secrets)) {
    return false
  }
  try {
    // Checked again in the update queue: a switch back to Orca or another bot's claim wins.
    await runtime.bots.update(bot.id, (current) => {
      if (!usesLocalSlack(current) || claimedByAnother(runtime.bots.list(), bot.id, secrets)) {
        throw new Error('not repaired')
      }
      return identityUpdate(current, secrets, undefined)
    })
    return true
  } catch {
    return false
  }
}
