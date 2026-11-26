import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotSlackGate, SlackGateEvent } from '../../../shared/bots/bot-slack-gate'
import { SlackGateDecider } from './slack-gate'
import { askSlackGateOpenAI } from './slack-gate-openai'
import { setSecretStore, type SecretSealing } from '../../../shared/secure-storage/secret-store'
import {
  clearSlackGateKey,
  readSlackGateKey,
  saveSlackGateKey,
  SlackGateKeyUnsealedError,
  useSlackGateKeyRoot
} from './slack-gate-key'

function sealingStore(sealing: SecretSealing | undefined) {
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(Buffer.from(text).toString('base64')),
    decryptString: (cipher) => Buffer.from(cipher.toString(), 'base64').toString(),
    describeProtectionGap: () => null,
    ...(sealing ? { describeSealing: () => sealing } : {})
  })
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-slack-gate-key-'))
  useSlackGateKeyRoot(dir)
})
afterEach(() => {
  useSlackGateKeyRoot(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('slack gate key store', () => {
  it('saves sealed, reads back for its bot only, and clears', async () => {
    sealingStore({ kind: 'os-keychain' })
    await saveSlackGateKey('bot-a', ' secret-1 ')
    const [file] = readdirSync(dir)
    expect(readFileSync(join(dir, file), 'utf8')).not.toContain('secret-1')
    expect(await readSlackGateKey('bot-a')).toBe('secret-1')
    // The same sealed file copied under another bot's name does not open for it.
    await saveSlackGateKey('bot-b', 'secret-2')
    const files = readdirSync(dir)
    const other = files.find((name) => name !== file) ?? ''
    writeFileSync(join(dir, other), readFileSync(join(dir, file)))
    expect(await readSlackGateKey('bot-b')).toBeNull()
    await clearSlackGateKey('bot-a')
    expect(await readSlackGateKey('bot-a')).toBeNull()
  })

  it('refuses to save without an OS keychain', async () => {
    for (const sealing of [
      { kind: 'none', reason: 'basic_text' } as const,
      { kind: 'host-key', warning: 'host' } as const,
      undefined
    ]) {
      sealingStore(sealing)
      await expect(saveSlackGateKey('bot-a', 'secret')).rejects.toBeInstanceOf(
        SlackGateKeyUnsealedError
      )
    }
    expect(readdirSync(dir)).toEqual([])
  })

  it('keeps the OpenAI key apart from the command key, file for file', async () => {
    sealingStore({ kind: 'os-keychain' })
    await saveSlackGateKey('bot-a', 'command-key')
    await saveSlackGateKey('bot-a', 'openai-key', 'openai')
    // The command key keeps the path and sealed form builds before OpenAI gates wrote.
    const commandFile = readdirSync(dir).find((name) => name.endsWith('.json')) ?? ''
    const openaiFile = readdirSync(join(dir, 'openai'))[0] ?? ''
    const opened = (path: string) => {
      const sealed: string = JSON.parse(readFileSync(path, 'utf8')).sealed
      const cipher = Buffer.from(sealed, 'base64').toString()
      const opened: Record<string, unknown> = JSON.parse(Buffer.from(cipher, 'base64').toString())
      return opened
    }
    expect(Object.keys(opened(join(dir, commandFile)))).toEqual(['botId', 'key'])
    expect(opened(join(dir, 'openai', openaiFile))).toMatchObject({ slot: 'openai' })
    expect(await readSlackGateKey('bot-a')).toBe('command-key')
    expect(await readSlackGateKey('bot-a', 'openai')).toBe('openai-key')
    // A file moved into the other slot does not open there.
    const openaiText = readFileSync(join(dir, 'openai', openaiFile))
    const commandText = readFileSync(join(dir, commandFile))
    writeFileSync(join(dir, commandFile), openaiText)
    writeFileSync(join(dir, 'openai', openaiFile), commandText)
    expect(await readSlackGateKey('bot-a')).toBeNull()
    expect(await readSlackGateKey('bot-a', 'openai')).toBeNull()
    await saveSlackGateKey('bot-a', 'command-key')
    await saveSlackGateKey('bot-a', 'openai-key', 'openai')
    await clearSlackGateKey('bot-a', 'openai')
    expect(await readSlackGateKey('bot-a')).toBe('command-key')
    expect(await readSlackGateKey('bot-a', 'openai')).toBeNull()
  })

  it('hands each gate kind only its own key, through the real decider', async () => {
    sealingStore({ kind: 'os-keychain' })
    await saveSlackGateKey('bot-a', 'command-key')
    await saveSlackGateKey('bot-a', 'openai-key', 'openai')
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ answers: [{ type: 'predicate', name: 'q', probability: 0.9 }] })
    )
    const keys: (string | null)[] = []
    const gate = new SlackGateDecider({
      readKey: readSlackGateKey,
      now: Date.now,
      askOpenAI: (input) => askSlackGateOpenAI({ ...input, fetch }),
      runCommand: ({ key }) => {
        keys.push(key)
        const outcome = Promise.resolve({ kind: 'exit' as const, code: 0 })
        return { outcome, released: outcome.then(() => undefined) }
      }
    })
    const shared = { on: true, appliesTo: ['thread_reply' as const], timeoutSeconds: 5 }
    const openai: BotSlackGate = {
      ...shared,
      kind: 'openai',
      onError: 'block',
      openai: {
        questions: [{ type: 'predicate', name: 'q', instructions: 'Q?' }],
        rules: [{ question: 'q', wakeIf: { atLeast: 0.5 } }]
      }
    }
    const command: BotSlackGate = { ...shared, kind: 'command', onError: 'block', command: 'c' }
    const event: SlackGateEvent = {
      eventId: 'e',
      case: 'thread_reply',
      teamId: 'T',
      channelId: 'C',
      placeKind: 'channel',
      from: { userId: 'U' },
      text: 'hi'
    }
    expect(await gate.decide({ id: 'bot-a', name: 'A', slackGate: openai }, event)).toMatchObject({
      verdict: 'wake'
    })
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer openai-key' })
    await gate.decide({ id: 'bot-a', name: 'A', slackGate: command }, event)
    expect(keys).toEqual(['command-key'])
    await clearSlackGateKey('bot-a', 'openai')
    expect(await gate.decide({ id: 'bot-a', name: 'A', slackGate: openai }, event)).toMatchObject({
      verdict: 'block',
      reason: 'error',
      error: 'No OpenAI API key is saved for this bot.'
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
