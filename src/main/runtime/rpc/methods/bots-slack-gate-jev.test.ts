// Saving a Jev gate with rules: the host stores the config with the mirror older builds read, takes it
// under the newer method too, and never lets an older client's one-question form erase the rules.
import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import {
  BotSlackGateSchema,
  LegacyBotSlackGateJevSchema,
  type BotSlackGate
} from '../../../../shared/bots/bot-slack-gate'
import type {
  SlackGateJevConfig,
  StoredSlackGateJev
} from '../../../../shared/bots/slack-gate-jev-config'
import { applyBotUpdates, type BotHostUpdates } from '../../../../shared/rpc-contract/bots-params'
import { SlackGateSet } from '../../../../shared/rpc-contract/bots-slack-gate-params'
import type { RpcContext } from '../core'
import { BOT_SLACK_GATE_METHODS, slackGateToStore } from './bots-slack-gate'

const config: SlackGateJevConfig = {
  model: 'jev-latest',
  questions: {
    asks: { type: 'noul', instructions: 'Asks?' },
    chat: { type: 'noul', instructions: 'Small talk?' }
  },
  send: { message: true },
  rules: [
    { question: 'asks', wakeIf: { atLeast: 0.7 } },
    { question: 'chat', blockIf: { atLeast: 0.8 } }
  ]
}
const shared = {
  on: true,
  appliesTo: ['thread_reply' as const],
  timeoutSeconds: 5,
  onError: 'wake' as const
}
const jevGate = (
  jev: StoredSlackGateJev,
  fields: Partial<Pick<BotSlackGate, 'on' | 'timeoutSeconds'>> = {}
): BotSlackGate => ({ ...shared, kind: 'jev', jev, ...fields })

describe('slackGateToStore', () => {
  it('stores a config canonical, with a mirror today’s builds parse', () => {
    const stored = slackGateToStore(null, jevGate({ ...config, model: '  ' }))
    expect(stored).toEqual(
      jevGate({
        questions: config.questions,
        send: config.send,
        rules: config.rules,
        question: 'Asks?',
        threshold: 0.7
      })
    )
    expect(
      stored?.kind === 'jev' && LegacyBotSlackGateJevSchema.safeParse(stored.jev).success
    ).toBe(true)
    expect(BotSlackGateSchema.safeParse(stored).success).toBe(true)
  })

  it('lets an older client change only the shared fields of a config it cannot see', () => {
    const saved = slackGateToStore(null, jevGate({ ...config, model: '' }))
    // An older client sends back the mirror, without a model for a blank one, and a new timeout.
    const older = jevGate({ question: 'Asks?', threshold: 0.7 }, { timeoutSeconds: 9, on: false })
    const merged = slackGateToStore(saved, older)
    expect(merged).toMatchObject({ on: false, timeoutSeconds: 9 })
    expect(merged?.kind === 'jev' && merged.jev.rules).toEqual(config.rules)
    // The mirror's question with its surrounding spaces trimmed is still the same question.
    const spaced = slackGateToStore(
      null,
      jevGate({
        ...config,
        questions: { ...config.questions, asks: { type: 'noul', instructions: '  Asks?  ' } }
      })
    )
    expect(
      slackGateToStore(spaced, jevGate({ question: 'Asks?', threshold: 0.7 }, { on: false }))
    ).toMatchObject({ on: false })
    // A different question from it would replace the rules: refused.
    expect(() => slackGateToStore(saved, jevGate({ question: 'Other?', threshold: 0.7 }))).toThrow(
      'This gate uses Jev rules from a newer Orca.'
    )
    expect(() =>
      slackGateToStore(saved, jevGate({ question: 'Asks?', threshold: 0.7, model: 'other' }))
    ).toThrow('This gate uses Jev rules from a newer Orca.')
    // A legacy gate over a legacy gate, a command gate and removal are stored as given.
    const legacy = jevGate({ question: 'Q?', threshold: 0.5 })
    expect(slackGateToStore(legacy, jevGate({ question: 'R?', threshold: 0.6 }))).toEqual(
      jevGate({ question: 'R?', threshold: 0.6 })
    )
    expect(slackGateToStore(saved, null)).toBeNull()
  })

  it('saves through both methods; the newer one exists so older hosts refuse instead of stripping', async () => {
    for (const name of ['bots.slackGate.set', 'bots.slackGate.update']) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: applyBotUpdates reads members; the rest is carried.
      const saved = { bot: { id: 'b1', members: [] } as unknown as Bot }
      const bots = {
        list: () => [saved.bot],
        update: vi.fn(async (_id: string, edit: (bot: Bot) => BotHostUpdates) => {
          saved.bot = applyBotUpdates(saved.bot, edit(saved.bot))
          return saved.bot
        })
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads runtime.bots and caller.
      const context = { runtime: { bots }, caller: { kind: 'desktop' } } as unknown as RpcContext
      const method = BOT_SLACK_GATE_METHODS.find((entry) => entry.name === name)!
      const params = SlackGateSet.parse({ botId: 'b1', gate: jevGate(config) })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: params parsed by the method's own schema.
      await method.handler(params as never, context)
      expect(saved.bot.slackGate).toMatchObject({ jev: { rules: config.rules, question: 'Asks?' } })
    }
  })
})
