// Saving a bot's Slack wake gate on its host. A Jev config with rules goes by `bots.slackGate.update`,
// which older hosts don't have: they refuse it instead of keeping only its compatibility mirror. Command
// gates and removal keep `bots.slackGate.set`, which every host has. Never falls back from one to the other.
import type { BotSlackGate } from '../../../../../../shared/bots/bot-slack-gate'
import { slackGateJevConfigOf } from '../../../../../../shared/bots/slack-gate-jev-config'

export class SlackGateHostTooOldError extends Error {
  constructor() {
    super('The bot’s Orca is too old to save Jev rules.')
    this.name = 'SlackGateHostTooOldError'
  }
}

export type SlackGateHostCall = (method: string, params: unknown) => Promise<unknown>

export function slackGateSaveMethod(gate: BotSlackGate | null): string {
  return gate?.kind === 'jev' && !slackGateJevConfigOf(gate.jev).legacy
    ? 'bots.slackGate.update'
    : 'bots.slackGate.set'
}

export async function saveSlackGate(
  call: SlackGateHostCall,
  botId: string,
  gate: BotSlackGate | null
): Promise<void> {
  const method = slackGateSaveMethod(gate)
  try {
    await call(method, { botId, gate })
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
    if (method === 'bots.slackGate.update' && code === 'method_not_found') {
      throw new SlackGateHostTooOldError()
    }
    throw error
  }
}
