// Saving an OpenAI gate or its key to an older host fails plainly (it has none of the newer methods),
// instead of a validation error or the key landing in the command's slot; command gates and removal still
// save there.
import { describe, expect, it } from 'vitest'
import type { BotSlackGateEdit } from '../../../../../../shared/bots/bot-slack-gate'
import { callSlackGateHost, saveSlackGate, SlackGateHostTooOldError } from './slack-gate-save'

// A host from before OpenAI gates: only `set`, `setKey` and `clearKey`.
function olderHost() {
  const host: { calls: string[] } = { calls: [] }
  const call = async (method: string, _params: unknown) => {
    if (
      !['bots.slackGate.set', 'bots.slackGate.setKey', 'bots.slackGate.clearKey'].includes(method)
    ) {
      throw Object.assign(new Error(`Unknown method: ${method}`), { code: 'method_not_found' })
    }
    host.calls.push(method)
  }
  return { host, call }
}

const shared = {
  on: true,
  appliesTo: ['mention' as const],
  timeoutSeconds: 5,
  onError: 'wake' as const
}
const openai: BotSlackGateEdit = {
  ...shared,
  kind: 'openai',
  openai: {
    questions: [{ type: 'predicate', name: 'asks', instructions: 'Asks?' }],
    rules: [{ question: 'asks', wakeIf: { atLeast: 0.7 } }]
  }
}

describe('saving to an older host', () => {
  it('refuses an OpenAI gate and its key, and never falls back to the older methods', async () => {
    const { host, call } = olderHost()
    await expect(saveSlackGate(call, 'b1', openai, false)).rejects.toBeInstanceOf(
      SlackGateHostTooOldError
    )
    for (const method of ['bots.slackGate.setOpenAIKey', 'bots.slackGate.clearOpenAIKey']) {
      await expect(callSlackGateHost(call, method, { botId: 'b1' })).rejects.toBeInstanceOf(
        SlackGateHostTooOldError
      )
    }
    expect(host.calls).toEqual([])
  })

  it('still saves a command gate, a removal and the command key there', async () => {
    const { host, call } = olderHost()
    await saveSlackGate(call, 'b1', { ...shared, kind: 'command', command: 'check' }, false)
    await saveSlackGate(call, 'b1', null, false)
    await callSlackGateHost(call, 'bots.slackGate.setKey', { botId: 'b1', key: 'k' })
    expect(host.calls).toEqual([
      'bots.slackGate.set',
      'bots.slackGate.set',
      'bots.slackGate.setKey'
    ])
  })
})

describe('saving newer settings', () => {
  it('never sends channel messages, a rules script or limits to a host without gate features', async () => {
    const { host, call } = olderHost()
    const channel: BotSlackGateEdit = { ...openai, channelMessages: { channels: ['C0123'] } }
    const script: BotSlackGateEdit = { ...openai, rulesCommand: 'node rules.mjs' }
    for (const gate of [channel, script]) {
      await expect(saveSlackGate(call, 'b1', gate, false)).rejects.toMatchObject({
        feature: 'newer'
      })
    }
    expect(host.calls).toEqual([])
  })

  it('sends every gate to a host with gate features by store', async () => {
    const calls: string[] = []
    await saveSlackGate(async (method) => void calls.push(method), 'b1', openai, true)
    await saveSlackGate(async (method) => void calls.push(method), 'b1', null, true)
    expect(calls).toEqual(['bots.slackGate.store', 'bots.slackGate.store'])
  })
})
