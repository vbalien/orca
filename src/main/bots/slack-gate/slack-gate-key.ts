// A bot's Slack gate API key: sealed by the OS keychain, one private file per bot in this profile's
// data folder, bound to the bot id. Written from the owner's Orca only; never returned or logged.
import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import * as z from 'zod'
import { getSecretStore, hasSecretStore } from '../../../shared/secure-storage/secret-store'
import { inCredentialFileOrder, stageCredentialFile } from '../../credentials/credential-file-io'
import { getCanonicalUserDataPath } from '../../persistence/loading-store/user-data-path'

const KeyFile = z.object({ version: z.literal(1), sealed: z.string().min(1) })
const Sealed = z.object({ botId: z.string(), key: z.string().min(1) })

let rootOverride: string | null = null

/** Tests point the store at a temporary folder. */
export function useSlackGateKeyRoot(root: string | null): void {
  rootOverride = root
}

function keyPath(botId: string): string {
  const name = createHash('sha256').update(botId).digest('hex').slice(0, 32)
  return join(
    rootOverride ?? join(getCanonicalUserDataPath(), 'bot-slack-gate-keys'),
    `${name}.json`
  )
}

/** Only an OS keychain seals the key; a built-in or host-held key would leave it readable. */
export function slackGateKeySealing(): 'os-keychain' | 'unavailable' {
  if (!hasSecretStore()) {
    return 'unavailable'
  }
  const store = getSecretStore()
  return store.isEncryptionAvailable() && store.describeSealing?.().kind === 'os-keychain'
    ? 'os-keychain'
    : 'unavailable'
}

export class SlackGateKeyUnsealedError extends Error {
  constructor() {
    super('Saving a gate key needs the system keychain, which this computer does not offer Orca.')
  }
}

export async function saveSlackGateKey(botId: string, key: string): Promise<void> {
  if (slackGateKeySealing() !== 'os-keychain') {
    throw new SlackGateKeyUnsealedError()
  }
  const sealed = getSecretStore().encryptString(JSON.stringify({ botId, key: key.trim() }))
  const path = keyPath(botId)
  await inCredentialFileOrder(path, () =>
    stageCredentialFile(path, JSON.stringify({ version: 1, sealed: sealed.toString('base64') }), {
      durable: true,
      createDirectory: true,
      requirePrivateWindowsFile: true
    })
  )
}

/** The key, or null when none is saved or it no longer opens here (another keychain, another bot). */
export async function readSlackGateKey(botId: string): Promise<string | null> {
  const path = keyPath(botId)
  const text = await inCredentialFileOrder(path, () =>
    readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return null
      }
      throw error
    })
  )
  if (text === null || !hasSecretStore()) {
    return null
  }
  try {
    const file = KeyFile.parse(JSON.parse(text))
    const opened = Sealed.parse(
      JSON.parse(getSecretStore().decryptString(Buffer.from(file.sealed, 'base64')))
    )
    return opened.botId === botId ? opened.key : null
  } catch {
    return null
  }
}

export async function clearSlackGateKey(botId: string): Promise<void> {
  const path = keyPath(botId)
  await inCredentialFileOrder(path, () => rm(path, { force: true }))
}
