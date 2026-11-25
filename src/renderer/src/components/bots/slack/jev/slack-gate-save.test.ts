// Saving a Jev gate with rules to an older host fails plainly (it has no `update`), instead of being
// stripped to its mirror by that host's `set`; command gates and removal still save there.
import { describe, expect, it } from 'vitest'
import * as z from 'zod'
import {
  LegacyBotSlackGateJevSchema,
  type BotSlackGate
} from '../../../../../../shared/bots/bot-slack-gate'
import { saveSlackGate, SlackGateHostTooOldError } from './slack-gate-save'

// A host from before configurable rules: only `set`, with today's frozen jev shape (unknown keys stripped).
function olderHost() {
  const common = {
    on: z.boolean(),
    appliesTo: z.array(z.string()),
    timeoutSeconds: z.number(),
    onError: z.enum(['wake', 'block'])
  }
  const gateSchema = z.discriminatedUnion('kind', [
    z.object({ ...common, kind: z.literal('command'), command: z.string() }),
    z.object({ ...common, kind: z.literal('jev'), jev: LegacyBotSlackGateJevSchema })
  ])
  const host: { stored: unknown } = { stored: 'untouched' }
  const call = async (method: string, params: unknown) => {
    if (method !== 'bots.slackGate.set') {
      throw Object.assign(new Error(`Unknown method: ${method}`), { code: 'method_not_found' })
    }
    host.stored = z.object({ botId: z.string(), gate: gateSchema.nullable() }).parse(params).gate
  }
  return { host, call }
}

const shared = {
  on: true,
  appliesTo: ['mention' as const],
  timeoutSeconds: 5,
  onError: 'wake' as const
}
const rules: BotSlackGate = {
  ...shared,
  kind: 'jev',
  jev: {
    questions: { asks: { type: 'noul', instructions: 'Asks?' } },
    send: { message: true },
    rules: [{ question: 'asks', wakeIf: { atLeast: 0.7 } }]
  }
}

describe('saveSlackGate against an older host', () => {
  it('refuses a Jev config with rules and leaves the host untouched', async () => {
    const { host, call } = olderHost()
    await expect(saveSlackGate(call, 'b1', rules)).rejects.toBeInstanceOf(SlackGateHostTooOldError)
    expect(host.stored).toBe('untouched')
  })

  it('still saves a command gate and a removal there', async () => {
    const { host, call } = olderHost()
    await saveSlackGate(call, 'b1', { ...shared, kind: 'command', command: 'check' })
    expect(host.stored).toMatchObject({ kind: 'command', command: 'check' })
    await saveSlackGate(call, 'b1', null)
    expect(host.stored).toBeNull()
  })
})
