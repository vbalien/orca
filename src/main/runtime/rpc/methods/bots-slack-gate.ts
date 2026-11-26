// `bots.slackGate.*`: a bot's Slack wake gate. Only the owner changes it, never an agent's CLI; a
// paired device may tune it and set its keys, but never choose its command. Nothing returns a key.
import { slackGateCommandChanged, type BotSlackGate } from '../../../../shared/bots/bot-slack-gate'
import { validateSlackGateRules } from '../../../../shared/bots/slack-gate-rules-validate'
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
  slackGateKeySealing,
  type SlackGateKeySlot
} from '../../../bots/slack-gate/slack-gate-key'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'
import { ownerOnly } from './bots-caller-gates'

/** The owner's Orca here or on a paired computer; the key is sealed on this host. */
function ownerKeyChange(context: RpcContext, botId: string): void {
  ownerOnly(context, 'Your owner sets the Slack wake gate key in Orca.')
  if (!context.runtime.bots.list().some((bot) => bot.id === botId)) {
    throw new InvalidArgumentError('No such bot.')
  }
}

async function keyStatus(botId: string): Promise<SlackGateKeyStatus> {
  return {
    apiKeySet: (await readSlackGateKey(botId, 'command')) !== null,
    openaiKeySet: (await readSlackGateKey(botId, 'openai')) !== null,
    sealing: slackGateKeySealing()
  }
}

/** A deleted bot's keys go with it; a failed delete keeps the bot, so this runs only after one. */
export async function forgetSlackGateKey(botId: string): Promise<void> {
  for (const slot of ['command', 'openai'] as const) {
    await clearSlackGateKey(botId, slot).catch((error: unknown) =>
      console.warn('[bots] could not remove a deleted bot’s Slack gate key', error)
    )
  }
}

/** An OpenAI gate is kept in its canonical form (the schema already checked it). */
function slackGateToStore(gate: BotSlackGate | null): BotSlackGate | null {
  if (gate?.kind !== 'openai') {
    return gate
  }
  const checked = validateSlackGateRules(gate.openai)
  return checked.ok ? { ...gate, openai: checked.config } : gate
}

const setGate = defineMethod({
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
      // A save replaces a retired gate's notice along with the gate.
      return { slackGate: slackGateToStore(gate), slackGateRetired: undefined }
    })
    return { bot }
  }
})

function keyMethods<Set extends string, Clear extends string>(
  slot: SlackGateKeySlot,
  set: Set,
  clear: Clear
) {
  return [
    defineMethod({
      name: set,
      permission: 'workspace',
      params: SlackGateSetKey,
      handler: async ({ botId, key }, context) => {
        ownerKeyChange(context, botId)
        await saveSlackGateKey(botId, key, slot)
        return await keyStatus(botId)
      }
    }),
    defineMethod({
      name: clear,
      permission: 'workspace',
      params: SlackGateBot,
      handler: async ({ botId }, context) => {
        ownerKeyChange(context, botId)
        await clearSlackGateKey(botId, slot)
        return await keyStatus(botId)
      }
    })
  ]
}

export const BOT_SLACK_GATE_METHODS = [
  setGate,
  // The same save under a name older hosts don't know, so they answer method_not_found to an OpenAI gate
  // instead of a validation error.
  defineMethod({ ...setGate, name: 'bots.slackGate.save' }),
  defineMethod({
    name: 'bots.slackGate.status',
    permission: 'workspace',
    params: SlackGateBot,
    handler: ({ botId }) => keyStatus(botId)
  }),
  ...keyMethods('command', 'bots.slackGate.setKey', 'bots.slackGate.clearKey'),
  // Names of their own, so an older host can't take an OpenAI key for the command's.
  ...keyMethods('openai', 'bots.slackGate.setOpenAIKey', 'bots.slackGate.clearOpenAIKey')
]
