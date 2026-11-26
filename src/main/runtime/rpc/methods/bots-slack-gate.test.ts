// Who may change a bot's Slack wake gate: the owner's Orca. No agent CLI ever; a paired device may
// tune the gate and set its key but never choose its command.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import type { BotSlackGate } from '../../../../shared/bots/bot-slack-gate'
import { applyBotUpdates, type BotHostUpdates } from '../../../../shared/rpc-contract/bots-params'
import { setSecretStore } from '../../../../shared/secure-storage/secret-store'
import {
  readSlackGateKey,
  saveSlackGateKey,
  useSlackGateKeyRoot
} from '../../../bots/slack-gate/slack-gate-key'
import { SlackGateSetKey } from '../../../../shared/rpc-contract/bots-slack-gate-params'
import type { RpcContext } from '../core'
import { BOT_SLACK_GATE_METHODS } from './bots-slack-gate'

function method(name: string) {
  const found = BOT_SLACK_GATE_METHODS.find((entry) => entry.name === name)
  if (!found) {
    throw new Error(name)
  }
  return found
}
const call = (name: string, params: unknown, context: RpcContext) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each test passes the params its method parses.
  method(name).handler(params as never, context)

const gate = (command: string, timeoutSeconds = 5): BotSlackGate => ({
  on: true,
  kind: 'command',
  command,
  appliesTo: ['thread_reply'],
  timeoutSeconds,
  onError: 'wake'
})

/** The bot as its controller keeps it: a function edit reads the bot as saved, in the queue. */
function contextFor(caller: RpcContext['caller'], saved: { bot: Bot }) {
  const bots = {
    list: () => [saved.bot],
    update: vi.fn(async (_id: string, edit: BotHostUpdates | ((bot: Bot) => BotHostUpdates)) => {
      saved.bot = applyBotUpdates(saved.bot, typeof edit === 'function' ? edit(saved.bot) : edit)
      return saved.bot
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these methods read only runtime.bots and caller.
  return { bots, context: { runtime: { bots }, caller } as unknown as RpcContext }
}
const saved = (slackGate?: BotSlackGate) => ({
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: applyBotUpdates reads members; the rest is carried.
  bot: { id: 'b1', members: [], ...(slackGate ? { slackGate } : {}) } as unknown as Bot
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-slack-gate-rpc-'))
  useSlackGateKeyRoot(dir)
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(Buffer.from(text).toString('base64')),
    decryptString: (cipher) => Buffer.from(cipher.toString(), 'base64').toString(),
    describeProtectionGap: () => null,
    describeSealing: () => ({ kind: 'os-keychain' })
  })
})
afterEach(() => {
  useSlackGateKeyRoot(null)
  rmSync(dir, { recursive: true, force: true })
})

const AGENTS = [
  { kind: 'local-cli' as const },
  { kind: 'paired-device' as const, deviceId: 'd', agent: true as const }
]
// A person on a paired computer: no agent claim.
const PAIRED = { kind: 'paired-device' as const, deviceId: 'mac' }

describe('bots.slackGate.set', () => {
  it('refuses every agent CLI', async () => {
    for (const caller of AGENTS) {
      const bot = saved(gate('a'))
      await expect(
        call(
          'bots.slackGate.set',
          { botId: 'b1', gate: gate('b') },
          contextFor(caller, bot).context
        )
      ).rejects.toThrow()
      expect(bot.bot.slackGate).toEqual(gate('a'))
    }
  })

  it('lets a paired owner tune a gate but never change or clear its command', async () => {
    const bot = saved(gate('a'))
    const { context } = contextFor(PAIRED, bot)
    await call('bots.slackGate.set', { botId: 'b1', gate: gate('a', 9) }, context)
    expect(bot.bot.slackGate).toMatchObject({ command: 'a', timeoutSeconds: 9 })
    for (const next of [gate('b'), null]) {
      await expect(
        call('bots.slackGate.set', { botId: 'b1', gate: next }, context)
      ).rejects.toThrow('Change a Slack gate command in Orca on this computer.')
    }
    expect(bot.bot.slackGate).toMatchObject({ command: 'a' })
  })

  it('checks a paired owner against the bot as saved, so a desktop edit is never undone', async () => {
    const bot = saved(gate('a'))
    // The desktop changed the command after the paired computer read `a`.
    await call(
      'bots.slackGate.set',
      { botId: 'b1', gate: gate('desktop') },
      contextFor({ kind: 'desktop' }, bot).context
    )
    await expect(
      call('bots.slackGate.set', { botId: 'b1', gate: gate('a') }, contextFor(PAIRED, bot).context)
    ).rejects.toThrow()
    expect(bot.bot.slackGate).toMatchObject({ command: 'desktop' })
  })

  it('keeps the key when the gate is removed', async () => {
    await saveSlackGateKey('b1', 'secret')
    const bot = saved(gate('a'))
    await call(
      'bots.slackGate.set',
      { botId: 'b1', gate: null },
      contextFor({ kind: 'desktop' }, bot).context
    )
    expect(bot.bot.slackGate).toBeNull()
    expect(await readSlackGateKey('b1')).toBe('secret')
  })
})

describe('bots.slackGate key methods', () => {
  it('refuse every agent CLI, which neither saves nor removes a key', async () => {
    const bot = saved()
    for (const caller of AGENTS) {
      const { context } = contextFor(caller, bot)
      await expect(
        call('bots.slackGate.setKey', { botId: 'b1', key: 'secret' }, context)
      ).rejects.toThrow('Your owner sets the Slack wake gate key in Orca.')
    }
    expect(await readSlackGateKey('b1')).toBeNull()
    await saveSlackGateKey('b1', 'kept')
    for (const caller of AGENTS) {
      await expect(
        call('bots.slackGate.clearKey', { botId: 'b1' }, contextFor(caller, bot).context)
      ).rejects.toThrow('Your owner sets the Slack wake gate key in Orca.')
    }
    expect(await readSlackGateKey('b1')).toBe('kept')
  })

  it('let the owner on a paired computer save and remove a key, answering only its status', async () => {
    const { context } = contextFor(PAIRED, saved())
    // A key is one header-safe line.
    expect(SlackGateSetKey.safeParse({ botId: 'b1', key: 'sk-1\nX-Other: y' }).success).toBe(false)
    expect(await call('bots.slackGate.setKey', { botId: 'b1', key: 'secret' }, context)).toEqual({
      apiKeySet: true,
      sealing: 'os-keychain'
    })
    expect(await readSlackGateKey('b1')).toBe('secret')
    expect(await call('bots.slackGate.clearKey', { botId: 'b1' }, context)).toEqual({
      apiKeySet: false,
      sealing: 'os-keychain'
    })
    expect(await readSlackGateKey('b1')).toBeNull()
    await expect(
      call('bots.slackGate.setKey', { botId: 'other', key: 'secret' }, context)
    ).rejects.toThrow('No such bot.')
    expect(await readSlackGateKey('other')).toBeNull()
  })
})
