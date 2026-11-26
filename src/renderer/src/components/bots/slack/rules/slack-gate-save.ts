// Saving a bot's Slack wake gate and its OpenAI key on its host. An OpenAI gate goes by
// `bots.slackGate.save` and its key by `setOpenAIKey`/`clearOpenAIKey`, which older hosts don't have: they
// answer method_not_found instead of misreading the gate or keeping the key as the command's. Command gates
// and removal keep `bots.slackGate.set`, which every host has. Never falls back from one to the other.
import type { BotSlackGate } from '../../../../../../shared/bots/bot-slack-gate'

export class SlackGateHostTooOldError extends Error {
  constructor() {
    super('The bot’s Orca is too old for OpenAI Decisions checks.')
    this.name = 'SlackGateHostTooOldError'
  }
}

export type SlackGateHostCall = (method: string, params: unknown) => Promise<unknown>

const NEWER_METHODS = new Set([
  'bots.slackGate.save',
  'bots.slackGate.setOpenAIKey',
  'bots.slackGate.clearOpenAIKey'
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
      throw new SlackGateHostTooOldError()
    }
    throw error
  }
}

export function slackGateSaveMethod(gate: BotSlackGate | null): string {
  return gate?.kind === 'openai' ? 'bots.slackGate.save' : 'bots.slackGate.set'
}

export async function saveSlackGate(
  call: SlackGateHostCall,
  botId: string,
  gate: BotSlackGate | null
): Promise<void> {
  await callSlackGateHost(call, slackGateSaveMethod(gate), { botId, gate })
}
