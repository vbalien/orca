// A bot's own Slack app's tokens are kept only when an OS keyring seals them, never as plain text,
// and a failed change can put the previous file back as it was.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { SecretStore } from '../../shared/secure-storage/secret-store'
import { SlackLocalTokenStore, type SlackLocalSecrets } from './slack-local-token-store'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const BOT_TOKEN = 'xoxb-1111-2222-abcdefghijkl'
const secrets: SlackLocalSecrets = {
  botToken: BOT_TOKEN,
  appToken: 'xapp-1-A111-3333-abcdefghijkl',
  teamId: 'T1',
  botUserId: 'U0BOT',
  appId: 'A111'
}

// Reversible but not plain text, as a keyring would be.
function keyring(kind: 'os-keychain' | 'none'): SecretStore {
  return {
    isEncryptionAvailable: () => kind === 'os-keychain',
    encryptString: (text) => Buffer.from(Buffer.from(text, 'utf8').map((byte) => byte ^ 0x5a)),
    decryptString: (cipher) => Buffer.from(cipher.map((byte) => byte ^ 0x5a)).toString('utf8'),
    describeProtectionGap: () => (kind === 'none' ? 'no keyring' : null),
    describeSealing: () =>
      kind === 'none' ? { kind: 'none', reason: 'no keyring' } : { kind: 'os-keychain' }
  }
}

function store(kind: 'os-keychain' | 'none') {
  const dir = mkdtempSync(join(tmpdir(), 'slack-local-tokens-'))
  dirs.push(dir)
  return { dir, tokens: new SlackLocalTokenStore(dir, () => keyring(kind)) }
}

it('seals tokens only with an OS keyring, never writes them in plain text, and restores a file', async () => {
  const refused = store('none')
  expect(refused.tokens.sealingRefusal()).toBe('no keyring')
  await expect(refused.tokens.write('b1', secrets)).rejects.toThrow('no keyring')
  expect(await refused.tokens.has('b1')).toBe(false)

  const { dir, tokens } = store('os-keychain')
  await tokens.write('b1', secrets)
  expect(readFileSync(join(dir, 'b1.sealed'), 'utf8')).not.toContain(BOT_TOKEN)
  expect(await tokens.read('b1')).toEqual(secrets)

  const before = await tokens.readSealed('b1')
  await tokens.write('b1', { ...secrets, teamId: 'T2' })
  await tokens.writeSealed('b1', before)
  expect(await tokens.read('b1')).toEqual(secrets)
  await tokens.writeSealed('b1', null)
  expect(await tokens.read('b1')).toBeNull()
})

it('never puts a token in an error, and refuses a bot id that could leave its folder', async () => {
  const { dir, tokens } = store('os-keychain')
  await expect(
    tokens.write('b1', { ...secrets, botToken: 'xoxp-user-token-123456' })
  ).rejects.not.toThrow(/xoxp/)
  await expect(tokens.has('../escape')).rejects.toThrow('invalid bot id')
  // A file that isn't ours reads as unsealable, saying nothing of what it holds.
  const tampered = new SlackLocalTokenStore(dir, () => keyring('os-keychain'))
  await tampered.writeSealed(
    'b2',
    Buffer.from(`orca-slack-local-v1:${Buffer.from(BOT_TOKEN).toString('base64')}`)
  )
  await expect(tampered.read('b2')).rejects.toThrow('Slack tokens could not be unsealed')
  await expect(tampered.read('b2')).rejects.not.toThrow(BOT_TOKEN)
})
