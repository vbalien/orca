// The copy of a gate older builds can't hold whole: Restore gives it back only while the stored gate is
// exactly what an older Orca leaves of it, saves land in order, and a removed bot's copy stays gone.
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { BotSlackGate, BotSlackGateEdit } from '../../../shared/bots/bot-slack-gate'
import { oldSchemaView, toStoredSlackGate } from '../../../shared/bots/slack-gate-store-form'
import { BotStateFile, useBotStateRoot } from './bot-state-file'
import { forgetSlackGateCopy, keepSlackGateCopy, restorableSlackGate } from './slack-gate-copies'

beforeEach(() => useBotStateRoot(mkdtempSync(join(tmpdir(), 'gate-copies-'))))
afterEach(() => useBotStateRoot(null))

const limited = (perDay: number): BotSlackGate =>
  toStoredSlackGate({
    on: true,
    kind: 'openai',
    appliesTo: ['thread_reply'],
    channelMessages: { channels: ['C0CHAN01'] },
    timeoutSeconds: 5,
    onError: 'wake',
    openai: {
      questions: [{ type: 'predicate', name: 'banter', instructions: 'Banter?' }],
      rules: [{ question: 'banter', wakeIf: { atLeast: 0.9 }, limit: { perDay } }]
    }
  } satisfies BotSlackGateEdit)
// What an older build leaves when it rewrites the profile.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the old schema's view of a stored gate is a stored gate.
const olderSave = (gate: BotSlackGate) => oldSchemaView(gate) as BotSlackGate

it('restores the copy only while the stored gate is what an older Orca left of it', async () => {
  const gate = limited(2)
  await keepSlackGateCopy('b1', gate)
  expect(await restorableSlackGate('b1', olderSave(gate))).toEqual(gate)
  // Changed since (or never touched by an older build): nothing to restore.
  expect(await restorableSlackGate('b1', gate)).toBeNull()
  expect(await restorableSlackGate('b1', null)).toBeNull()
  // An older client saving that view unchanged keeps the copy; a real removal drops it.
  await keepSlackGateCopy('b1', olderSave(gate))
  expect(await restorableSlackGate('b1', olderSave(gate))).toEqual(gate)
  await keepSlackGateCopy('b1', null, { explicitRemoval: true })
  expect(await restorableSlackGate('b1', olderSave(gate))).toBeNull()
})

it('keeps the last of two saves, whose older views are the same', async () => {
  const first = limited(1)
  const second = limited(5)
  expect(oldSchemaView(first)).toEqual(oldSchemaView(second))
  await Promise.all([keepSlackGateCopy('b1', first), keepSlackGateCopy('b1', second)])
  expect(await restorableSlackGate('b1', olderSave(second))).toEqual(second)
})

it('never writes a removed bot’s copy again', async () => {
  const saving = keepSlackGateCopy('b1', limited(1))
  const forgetting = forgetSlackGateCopy('b1')
  await Promise.all([saving, forgetting])
  expect(existsSync(new BotStateFile('bot-slack-gate-copies', 'b1').path)).toBe(false)
})
