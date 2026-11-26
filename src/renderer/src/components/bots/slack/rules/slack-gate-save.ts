// Saving a bot's Slack wake gate and its OpenAI key on its host. A host that reports gate features takes
// the editor's whole gate by `bots.slackGate.store` (channel messages, a rules script, notes, limits).
// Older hosts get `bots.slackGate.save` for an OpenAI gate and `bots.slackGate.set` for a command gate or
// removal; a gate using newer fields is never sent to them (they would drop the fields and say saved).
// Never falls back from one method to another.
import type { BotSlackGateEdit } from '../../../../../../shared/bots/bot-slack-gate'
import { slackGateRulesExtended } from '../../../../../../shared/bots/slack-gate-rules-config'

export class SlackGateHostTooOldError extends Error {
  constructor(readonly feature: 'openai' | 'newer' = 'openai') {
    super('The bot’s Orca is too old for this check.')
    this.name = 'SlackGateHostTooOldError'
  }
}

/** Whether a gate uses anything only hosts with gate features keep. */
export function slackGateNeedsNewerHost(gate: BotSlackGateEdit | null): boolean {
  if (!gate) {
    return false
  }
  if (gate.channelMessages || gate.appliesTo.length === 0) {
    return true
  }
  if (gate.kind !== 'openai') {
    return false
  }
  const { notes, limits } = slackGateRulesExtended(gate.openai)
  return gate.rulesCommand !== undefined || notes || limits
}

export type SlackGateHostCall = (method: string, params: unknown) => Promise<unknown>

const NEWER_METHODS = new Set([
  'bots.slackGate.save',
  'bots.slackGate.setOpenAIKey',
  'bots.slackGate.clearOpenAIKey',
  'bots.slackGate.store',
  'bots.slackGate.restore'
])

/** Calls the host; a method this host is too old to know reads as SlackGateHostTooOldError. */
export async function callSlackGateHost(
  call: SlackGateHostCall,
  method: string,
  params: unknown
): Promise<unknown> {
  try {
    return await call(method, params)
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
    if (NEWER_METHODS.has(method) && code === 'method_not_found') {
      throw new SlackGateHostTooOldError(
        method === 'bots.slackGate.store' || method === 'bots.slackGate.restore'
          ? 'newer'
          : 'openai'
      )
    }
    throw error
  }
}

/** `hostHasFeatures`: the host's gate status listed features (it knows `store`). */
export function slackGateSaveMethod(
  gate: BotSlackGateEdit | null,
  hostHasFeatures: boolean
): string {
  if (hostHasFeatures) {
    return 'bots.slackGate.store'
  }
  if (slackGateNeedsNewerHost(gate)) {
    throw new SlackGateHostTooOldError('newer')
  }
  return gate?.kind === 'openai' ? 'bots.slackGate.save' : 'bots.slackGate.set'
}

export async function saveSlackGate(
  call: SlackGateHostCall,
  botId: string,
  gate: BotSlackGateEdit | null,
  hostHasFeatures: boolean
): Promise<void> {
  await callSlackGateHost(call, slackGateSaveMethod(gate, hostHasFeatures), { botId, gate })
}
