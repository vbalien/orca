// A bot's own Slack app's tokens, sealed by the OS keyring, one file per bot in this profile. The
// identity read from the tokens travels with them, so a file is always a matching pair.
import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  credentialFileExists,
  inCredentialFileOrder,
  stageCredentialFile
} from '../credentials/credential-file-io'
import type { SecretStore } from '../../shared/secure-storage/secret-store'

const SlackId = z.string().regex(/^[A-Z0-9]{2,32}$/)

export const SlackLocalSecretsSchema = z.object({
  botToken: z.string().regex(/^xoxb-[\w-]{10,500}$/),
  appToken: z.string().regex(/^xapp-[\w-]{10,500}$/),
  teamId: SlackId,
  botUserId: SlackId,
  appId: SlackId
})
export type SlackLocalSecrets = z.infer<typeof SlackLocalSecretsSchema>

export const isSlackBotToken = (token: string): boolean =>
  SlackLocalSecretsSchema.shape.botToken.safeParse(token).success
export const isSlackAppToken = (token: string): boolean =>
  SlackLocalSecretsSchema.shape.appToken.safeParse(token).success

const ENVELOPE = 'orca-slack-local-v1:'
const BOT_ID = /^[\w-]{1,128}$/

export class SlackLocalTokenStore {
  constructor(
    private readonly dir: string,
    private readonly secrets: () => SecretStore | null
  ) {}

  /** Why tokens can't be saved here: only an OS keyring seals them. Null when they can. */
  sealingRefusal(): string | null {
    const secrets = this.secrets()
    const sealing = secrets?.describeSealing?.()
    if (!secrets || !secrets.isEncryptionAvailable() || sealing?.kind !== 'os-keychain') {
      return sealing?.kind === 'none'
        ? sealing.reason
        : "The bot's computer has no OS keyring to seal Slack tokens with."
    }
    return null
  }

  private path(botId: string): string {
    if (!BOT_ID.test(botId)) {
      throw new Error('invalid bot id')
    }
    return join(this.dir, `${botId}.sealed`)
  }

  /** The bots with a token file here. */
  async botIds(): Promise<string[]> {
    const names = await readdir(this.dir).catch(() => [])
    return names.flatMap((name) => {
      const botId = name.endsWith('.sealed') ? name.slice(0, -'.sealed'.length) : ''
      return BOT_ID.test(botId) ? [botId] : []
    })
  }

  async has(botId: string): Promise<boolean> {
    const path = this.path(botId)
    return inCredentialFileOrder(path, () => credentialFileExists(path))
  }

  /** The sealed file's bytes as they are, for putting back after a failed change; null when none. */
  async readSealed(botId: string): Promise<Buffer | null> {
    const path = this.path(botId)
    return inCredentialFileOrder(path, async () =>
      (await credentialFileExists(path)) ? await readFile(path) : null
    )
  }

  async read(botId: string): Promise<SlackLocalSecrets | null> {
    const sealed = await this.readSealed(botId)
    if (!sealed) {
      return null
    }
    const secrets = this.secrets()
    const text = sealed.toString('utf8')
    if (!secrets?.isEncryptionAvailable() || !text.startsWith(ENVELOPE)) {
      throw new Error('Slack tokens could not be unsealed')
    }
    try {
      const plain = secrets.decryptString(Buffer.from(text.slice(ENVELOPE.length), 'base64'))
      return SlackLocalSecretsSchema.parse(JSON.parse(plain))
    } catch {
      // Never the cause: it could quote the plaintext.
      throw new Error('Slack tokens could not be unsealed')
    }
  }

  async write(botId: string, value: SlackLocalSecrets): Promise<void> {
    const refusal = this.sealingRefusal()
    const secrets = this.secrets()
    if (refusal || !secrets) {
      throw new Error(refusal ?? 'Slack tokens could not be sealed')
    }
    const parsed = SlackLocalSecretsSchema.parse(value)
    const sealed = secrets.encryptString(JSON.stringify(parsed))
    await this.writeSealed(botId, Buffer.from(`${ENVELOPE}${sealed.toString('base64')}`, 'utf8'))
  }

  /** Puts back what readSealed returned; null removes the file. */
  async writeSealed(botId: string, sealed: Buffer | null): Promise<void> {
    const path = this.path(botId)
    await inCredentialFileOrder(path, async () => {
      if (sealed === null) {
        await rm(path, { force: true })
        return
      }
      await stageCredentialFile(path, sealed, { durable: true, createDirectory: true })
    })
  }

  remove(botId: string): Promise<void> {
    return this.writeSealed(botId, null)
  }
}
