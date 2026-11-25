import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
})
