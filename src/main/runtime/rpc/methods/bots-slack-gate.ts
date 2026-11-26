// `bots.slackGate.*`: a bot's Slack wake gate. Only the owner changes it, never an agent's CLI; a
// paired device may tune it and set its keys, but never choose its command. Nothing returns a key.
import {
  effectiveSlackGate,
  slackGateCommandChanged,
  type BotSlackGate,
  type BotSlackGateEdit
} from '../../../../shared/bots/bot-slack-gate'
import {
  canonicalSlackGateRules,
  slackGateRulesExtended
} from '../../../../shared/bots/slack-gate-rules-config'
import { toStoredSlackGate } from '../../../../shared/bots/slack-gate-store-form'
import {
  SLACK_GATE_FEATURES,
  SlackGateBot,
  SlackGateSet,
  SlackGateSetKey,
  SlackGateStore,
  type SlackGateKeyStatus
} from '../../../../shared/rpc-contract/bots-slack-gate-params'
import { slackGateScriptRun, slackGateWakeCounts } from '../../../bots/slack-gate/slack-gate'
import { slackGateRecoveryCooldown } from '../../../bots/slack-gate/slack-gate-openai-run'
import {
  forgetSlackGateCopy,
  keepSlackGateCopy,
  restorableSlackGate,
  sameSlackGate
} from '../../../bots/slack-gate/slack-gate-copies'
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

/** The bot's stored gate, so a key change answers the whole status (Restore included). */
function storedGate(context: RpcContext, botId: string): BotSlackGate | null {
  return context.runtime.bots.list().find((bot) => bot.id === botId)?.slackGate ?? null
}

async function keyStatus(botId: string, stored?: BotSlackGate | null): Promise<SlackGateKeyStatus> {
  const scriptRun = slackGateScriptRun(botId)
  return {
    apiKeySet: (await readSlackGateKey(botId, 'command')) !== null,
    openaiKeySet: (await readSlackGateKey(botId, 'openai')) !== null,
    sealing: slackGateKeySealing(),
    features: [...SLACK_GATE_FEATURES],
    ...(scriptRun ? { scriptRun } : {}),
    ...(stored !== undefined && (await restorableSlackGate(botId, stored).catch(() => null))
      ? { restorable: true }
      : {}),
    pendingWakes: await pendingWakes(botId, stored)
  }
}

/** The gate's counts as status shows them; read first when the gate counts (limits or a rules script),
 *  so a hold kept from before a restart shows before any event came. */
async function pendingWakes(botId: string, stored: BotSlackGate | null | undefined) {
  const gate = stored ? effectiveSlackGate(stored) : null
  if (
    gate?.kind === 'openai' &&
    (gate.rulesCommand || slackGateRulesExtended(gate.openai).limits)
  ) {
    await slackGateWakeCounts.load(botId, slackGateRecoveryCooldown(gate)).catch(() => undefined)
  }
  return await slackGateWakeCounts.pendingStatus(botId)
}

/** A deleted bot's keys go with it, and its gate's counts and copy; a failed delete keeps the bot, so
 *  this runs only after one. */
export async function forgetSlackGateKey(botId: string): Promise<void> {
  for (const slot of ['command', 'openai'] as const) {
    await clearSlackGateKey(botId, slot).catch((error: unknown) =>
      console.warn('[bots] could not remove a deleted bot’s Slack gate key', error)
    )
  }
  await slackGateWakeCounts.forget(botId).catch(() => undefined)
  await forgetSlackGateCopy(botId).catch(() => undefined)
}

/** What is stored for a gate: the rules canonical, and the fields older builds can't run projected
 *  (slack-gate-store-form). Whatever form it came in, it is stored the same way. */
function slackGateToStore(gate: BotSlackGate | BotSlackGateEdit | null): BotSlackGate | null {
  if (!gate) {
    return null
  }
  const edit = 'newer' in gate ? effectiveSlackGate(gate) : gate
  return toStoredSlackGate(
    edit.kind === 'openai' ? { ...edit, openai: canonicalSlackGateRules(edit.openai) } : edit
  )
}

/** Saves the gate in the bot's update queue; a paired device may tune it but never choose a command it
 *  runs (a command gate's, or a rules script). */
async function saveGate(
  context: RpcContext,
  botId: string,
  gate: BotSlackGate | BotSlackGateEdit | null,
  options: {
    explicitRemoval?: boolean
    /** Saved only while the stored gate is still this one (checked in the bot's update queue). */
    unchangedFrom?: BotSlackGate | null
  } = {}
) {
  ownerOnly(context, 'Only your owner changes your Slack wake gate, in Orca.')
  const pairedDevice = context.caller?.kind === 'paired-device'
  const stored = slackGateToStore(gate)
  const bot = await context.runtime.bots.update(botId, (current) => {
    if (
      options.unchangedFrom !== undefined &&
      !sameSlackGate(current.slackGate, options.unchangedFrom)
    ) {
      throw new InvalidArgumentError('The gate changed meanwhile; open it again to restore.')
    }
    const before = current.slackGate ? effectiveSlackGate(current.slackGate) : current.slackGate
    if (
      pairedDevice &&
      slackGateCommandChanged(before, stored ? effectiveSlackGate(stored) : null)
    ) {
      throw new InvalidArgumentError('Change a Slack gate command in Orca on this computer.')
    }
    // A save replaces a retired gate's notice along with the gate.
    return { slackGate: stored, slackGateRetired: undefined }
  })
  // Saved either way; without the copy, Restore can't bring back what an older build drops.
  const copyKept = await keepSlackGateCopy(botId, stored, options).catch(() => false)
  if (!copyKept) {
    console.warn('[bots] could not keep a copy of a Slack gate for older builds')
  }
  return { bot, ...(copyKept ? {} : { copyKept: false as const }) }
}

const setGate = defineMethod({
  name: 'bots.slackGate.set',
  permission: 'workspace',
  params: SlackGateSet,
  handler: ({ botId, gate }, context) => saveGate(context, botId, gate)
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
        return await keyStatus(botId, storedGate(context, botId))
      }
    }),
    defineMethod({
      name: clear,
      permission: 'workspace',
      params: SlackGateBot,
      handler: async ({ botId }, context) => {
        ownerKeyChange(context, botId)
        await clearSlackGateKey(botId, slot)
        return await keyStatus(botId, storedGate(context, botId))
      }
    })
  ]
}

export const BOT_SLACK_GATE_METHODS = [
  setGate,
  // The same save under a name older hosts don't know, so they answer method_not_found to an OpenAI gate
  // instead of a validation error.
  defineMethod({ ...setGate, name: 'bots.slackGate.save' }),
  // The editor's whole gate; older hosts answer method_not_found, so a client never loses channel
  // messages, a rules script or limits to a host that would drop them.
  defineMethod({
    name: 'bots.slackGate.store',
    permission: 'workspace',
    params: SlackGateStore,
    handler: ({ botId, gate }, context) =>
      saveGate(context, botId, gate, { explicitRemoval: gate === null })
  }),
  // Puts back the settings an older Orca dropped, while the stored gate is still what it left.
  defineMethod({
    name: 'bots.slackGate.restore',
    permission: 'workspace',
    params: SlackGateBot,
    handler: async ({ botId }, context) => {
      ownerOnly(context, 'Only your owner changes your Slack wake gate, in Orca.')
      const current = context.runtime.bots.list().find((bot) => bot.id === botId)
      if (!current) {
        throw new InvalidArgumentError('No such bot.')
      }
      const copy = await restorableSlackGate(botId, current.slackGate)
      if (!copy) {
        throw new InvalidArgumentError('There is nothing to restore for this gate.')
      }
      // Only over what it was checked against: a change from another device meanwhile stays.
      return await saveGate(context, botId, copy, { unchangedFrom: current.slackGate ?? null })
    }
  }),
  defineMethod({
    name: 'bots.slackGate.status',
    permission: 'workspace',
    params: SlackGateBot,
    handler: ({ botId }, context) =>
      keyStatus(
        botId,
        context.runtime.bots.list().find((bot) => bot.id === botId)?.slackGate ?? null
      )
  }),
  ...keyMethods('command', 'bots.slackGate.setKey', 'bots.slackGate.clearKey'),
  // Names of their own, so an older host can't take an OpenAI key for the command's.
  ...keyMethods('openai', 'bots.slackGate.setOpenAIKey', 'bots.slackGate.clearOpenAIKey')
]
