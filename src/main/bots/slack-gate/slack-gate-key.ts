// A bot's Slack gate API keys: the command gate's key and the OpenAI key, each sealed by the OS keychain in
// a private file per bot in this profile's data folder, bound to the bot id and its slot. Written by the
// owner's Orca, here or paired; never returned or logged.
import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import * as z from 'zod'
import { getSecretStore, hasSecretStore } from '../../../shared/secure-storage/secret-store'
import { inCredentialFileOrder, stageCredentialFile } from '../../credentials/credential-file-io'
import { getCanonicalUserDataPath } from '../../persistence/loading-store/user-data-path'

const KeyFile = z.object({ version: z.literal(1), sealed: z.string().min(1) })
const Sealed = z.object({
  botId: z.string(),
  slot: z.literal('openai').optional(),
  key: z.string().min(1)
})

/** The command gate's key (handed to the command) or the OpenAI Decisions key; never one for the other. */
export type SlackGateKeySlot = 'command' | 'openai'

let rootOverride: string | null = null

/** Tests point the store at a temporary folder. */
export function useSlackGateKeyRoot(root: string | null): void {
  rootOverride = root
}

/** The command key keeps the path builds before OpenAI gates wrote; the OpenAI key has its own folder. */
function keyPath(botId: string, slot: SlackGateKeySlot): string {
  const name = createHash('sha256').update(botId).digest('hex').slice(0, 32)
  const root = rootOverride ?? join(getCanonicalUserDataPath(), 'bot-slack-gate-keys')
  return join(...(slot === 'openai' ? [root, 'openai'] : [root]), `${name}.json`)
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
    super(
      'Saving a gate key needs the system keychain on this bot’s computer, which it does not offer Orca.'
    )
  }
}

export async function saveSlackGateKey(
  botId: string,
  key: string,
  slot: SlackGateKeySlot = 'command'
): Promise<void> {
  if (slackGateKeySealing() !== 'os-keychain') {
    throw new SlackGateKeyUnsealedError()
  }
  const sealed = getSecretStore().encryptString(
    JSON.stringify({ botId, ...(slot === 'openai' ? { slot } : {}), key: key.trim() })
  )
  const path = keyPath(botId, slot)
  await inCredentialFileOrder(path, () =>
    stageCredentialFile(path, JSON.stringify({ version: 1, sealed: sealed.toString('base64') }), {
      durable: true,
      createDirectory: true,
      requirePrivateWindowsFile: true
    })
  )
}

/** The key, or null when none is saved or it no longer opens here (another keychain, another bot,
 *  another slot's file). */
export async function readSlackGateKey(
  botId: string,
  slot: SlackGateKeySlot = 'command'
): Promise<string | null> {
  const path = keyPath(botId, slot)
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
    return opened.botId === botId && (opened.slot ?? 'command') === slot ? opened.key : null
  } catch {
    return null
  }
}

export async function clearSlackGateKey(
  botId: string,
  slot: SlackGateKeySlot = 'command'
): Promise<void> {
  const path = keyPath(botId, slot)
  await inCredentialFileOrder(path, () => rm(path, { force: true }))
}
