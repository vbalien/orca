// `bots.slackGate.*`: a bot's Slack wake gate. Only the owner changes it, never an agent's CLI; a
// paired device may tune it but never choose its command or touch its key. Nothing returns the key.
import { slackGateCommandChanged } from '../../../../shared/bots/bot-slack-gate'
import {
  SlackGateBot,
  SlackGateSet,
  SlackGateSetKey,
  type SlackGateKeyStatus
} from '../../../../shared/rpc-contract/bots-slack-gate-params'
import {
  clearSlackGateKey,
  readSlackGateKey,
  saveSlackGateKey,
  slackGateKeySealing
} from '../../../bots/slack-gate/slack-gate-key'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'
import { ownerOnly } from './bots-caller-gates'

function ownersOrcaOnly(context: RpcContext, botId: string): void {
  ownerOnly(context, 'Your owner sets the Slack wake gate key in Orca.')
  if (context.caller?.kind === 'paired-device') {
    throw new InvalidArgumentError('Set the Slack wake gate key in Orca on this computer.')
  }
  if (!context.runtime.bots.list().some((bot) => bot.id === botId)) {
    throw new InvalidArgumentError('No such bot.')
  }
}

async function keyStatus(botId: string): Promise<SlackGateKeyStatus> {
  return {
    apiKeySet: (await readSlackGateKey(botId)) !== null,
    sealing: slackGateKeySealing()
  }
}

/** A deleted bot's key goes with it; a failed delete keeps the bot, so this runs only after one. */
export function forgetSlackGateKey(botId: string): Promise<void> {
  return clearSlackGateKey(botId).catch((error: unknown) =>
    console.warn('[bots] could not remove a deleted bot’s Slack gate key', error)
  )
}

export const BOT_SLACK_GATE_METHODS = [
  defineMethod({
    name: 'bots.slackGate.set',
    permission: 'workspace',
    params: SlackGateSet,
    handler: async ({ botId, gate }, context) => {
      ownerOnly(context, 'Only your owner changes your Slack wake gate, in Orca.')
      const pairedDevice = context.caller?.kind === 'paired-device'
      // Decided on the bot as saved, in its update queue, so a concurrent desktop edit is never undone.
      const bot = await context.runtime.bots.update(botId, (current) => {
        if (pairedDevice && slackGateCommandChanged(current.slackGate, gate)) {
          throw new InvalidArgumentError('Change a Slack gate command in Orca on this computer.')
        }
        return { slackGate: gate }
      })
      return { bot }
    }
  }),
  defineMethod({
    name: 'bots.slackGate.status',
    permission: 'workspace',
    params: SlackGateBot,
    handler: ({ botId }) => keyStatus(botId)
  }),
  defineMethod({
    name: 'bots.slackGate.setKey',
    permission: 'workspace',
    params: SlackGateSetKey,
    handler: async ({ botId, key }, context) => {
      ownersOrcaOnly(context, botId)
      await saveSlackGateKey(botId, key)
      return await keyStatus(botId)
    }
  }),
  defineMethod({
    name: 'bots.slackGate.clearKey',
    permission: 'workspace',
    params: SlackGateBot,
    handler: async ({ botId }, context) => {
      ownersOrcaOnly(context, botId)
      await clearSlackGateKey(botId)
      return await keyStatus(botId)
    }
  })
]
