// `bots.slackGate.*`: a bot's Slack wake gate. Only the owner changes it, never an agent's CLI; a
// paired device may tune it and set its key, but never choose its command. Nothing returns the key.
import {
  LegacyBotSlackGateJevSchema,
  SLACK_GATE_DEFAULT_MODEL,
  slackGateCommandChanged,
  type BotSlackGate
} from '../../../../shared/bots/bot-slack-gate'
import {
  slackGateJevConfigOf,
  slackGateJevLegacyMirror,
  storedSlackGateJev
} from '../../../../shared/bots/slack-gate-jev-config'
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

/** The owner's Orca here or on a paired computer; the key is sealed on this host. */
function ownerKeyChange(context: RpcContext, botId: string): void {
  ownerOnly(context, 'Your owner sets the Slack wake gate key in Orca.')
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

const effectiveModel = (model: string | undefined) => model?.trim() || SLACK_GATE_DEFAULT_MODEL

/** The gate to store: a Jev config with the mirror older builds read. A legacy one-question Jev
 *  over a saved config comes from an older client: it may change only the shared fields. */
export function slackGateToStore(
  saved: BotSlackGate | null | undefined,
  gate: BotSlackGate | null
): BotSlackGate | null {
  if (!gate || gate.kind !== 'jev') {
    return gate
  }
  const incoming = slackGateJevConfigOf(gate.jev)
  let jev = gate.jev
  if (!incoming.legacy) {
    jev = storedSlackGateJev(incoming.config)
  } else if (saved?.kind === 'jev' && !slackGateJevConfigOf(saved.jev).legacy) {
    const kept = slackGateJevConfigOf(saved.jev).config
    const mirror = slackGateJevLegacyMirror(kept)
    if (
      // Surrounding spaces don't make it another question (a client may have trimmed them).
      gate.jev.question?.trim() !== mirror.question.trim() ||
      gate.jev.threshold !== mirror.threshold ||
      effectiveModel(gate.jev.model) !== effectiveModel(kept.model)
    ) {
      throw new InvalidArgumentError(
        'This gate uses Jev rules from a newer Orca. Edit it in Orca on this bot’s computer.'
      )
    }
    jev = storedSlackGateJev(kept)
  }
  if (!LegacyBotSlackGateJevSchema.safeParse(jev).success) {
    throw new InvalidArgumentError(
      'This gate could not be saved in a form older Orca versions read.'
    )
  }
  return { ...gate, jev }
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
      return { slackGate: slackGateToStore(current.slackGate, gate) }
    })
    return { bot }
  }
})

export const BOT_SLACK_GATE_METHODS = [
  setGate,
  // The same save under a name older hosts don't know, so a Jev config with rules is never stripped
  // to its mirror by one: they answer method_not_found instead.
  defineMethod({ ...setGate, name: 'bots.slackGate.update' }),
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
      ownerKeyChange(context, botId)
      await saveSlackGateKey(botId, key)
      return await keyStatus(botId)
    }
  }),
  defineMethod({
    name: 'bots.slackGate.clearKey',
    permission: 'workspace',
    params: SlackGateBot,
    handler: async ({ botId }, context) => {
      ownerKeyChange(context, botId)
      await clearSlackGateKey(botId)
      return await keyStatus(botId)
    }
  })
]
