// A copy of each gate that uses fields older builds drop, kept outside the profile: an older Orca that
// rewrites the profile keeps only what it knows (oldSchemaView), and the owner can put the rest back
// from here — only while the stored gate is still exactly what that older Orca would have left.
import { createHash } from 'node:crypto'
import * as z from 'zod'
import { BotSlackGateSchema, type BotSlackGate } from '../../../shared/bots/bot-slack-gate'
import { oldSchemaView, slackGateUsesNewerFields } from '../../../shared/bots/slack-gate-store-form'
import { BotStateFile } from './bot-state-file'

const FOLDER = 'bot-slack-gate-copies'
const CopyFile = z.object({ v: z.literal(1), gate: z.unknown(), oldView: z.string() })

/** JSON with keys in order, so the same value hashes the same whichever schema wrote it. */
function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

const digest = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex')

async function readCopy(botId: string): Promise<{ gate: BotSlackGate; oldView: string } | null> {
  const read = await new BotStateFile(FOLDER, botId).read()
  const parsed = read.kind === 'ok' ? CopyFile.safeParse(read.value) : null
  const gate = parsed?.success ? BotSlackGateSchema.safeParse(parsed.data.gate) : null
  return parsed?.success && gate?.success ? { gate: gate.data, oldView: parsed.data.oldView } : null
}

/** After a save: keep a copy of a gate older builds can't hold whole; drop it otherwise, unless the
 *  saved gate is what an older Orca leaves of the copied one (an older client saved it unchanged). */
export async function keepSlackGateCopy(
  botId: string,
  saved: BotSlackGate | null,
  options: { explicitRemoval?: boolean } = {}
): Promise<void> {
  const file = new BotStateFile(FOLDER, botId)
  if (saved && slackGateUsesNewerFields(saved)) {
    await file.write(() => ({ v: 1, gate: saved, oldView: digest(oldSchemaView(saved)) }))
    return
  }
  const copy = options.explicitRemoval ? null : await readCopy(botId)
  if (copy && copy.oldView === digest(saved ?? null)) {
    return
  }
  await file.remove()
}

/** The copied gate when the stored one is still what an older Orca left of it; else null. */
export async function restorableSlackGate(
  botId: string,
  stored: BotSlackGate | null | undefined
): Promise<BotSlackGate | null> {
  const copy = await readCopy(botId)
  return copy && copy.oldView === digest(stored ?? null) ? copy.gate : null
}

export async function forgetSlackGateCopy(botId: string): Promise<void> {
  await new BotStateFile(FOLDER, botId).remove()
}
