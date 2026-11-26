// A saved TypeSafe Jev gate, which this build no longer runs: the profile load drops it from disk too
// (so a rollback to an older build can't run it again), keeps the bot, and leaves a one-line notice.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTestBot } from '../bots/bot.test-fixture'
import {
  closeTestStores,
  createStore,
  readPersistedStateJson,
  testState,
  writeDataFile
} from './persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

describe('a retired Jev gate on load', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-jev-retired-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('is removed on disk by the first save, with only the notice left', async () => {
    const jev = {
      on: true,
      kind: 'jev',
      appliesTo: ['mention'],
      timeoutSeconds: 5,
      onError: 'wake',
      jev: { question: 'Q?', threshold: 0.5 }
    }
    const gated = { ...JSON.parse(JSON.stringify(makeTestBot({ id: 'b1' }))), slackGate: jev }
    const other = JSON.parse(JSON.stringify(makeTestBot({ id: 'b2', name: 'Other' })))
    // A profile already in its database and past the other bot migrations: only the retired gate can
    // ask for a save on this load.
    const first = createStore()
    await first.flushAsync()
    await closeTestStores()
    const saved: Record<string, unknown> = JSON.parse(readPersistedStateJson())
    const { botOrder: _order, botsNewerAgents: _newer, ...rest } = saved
    writeDataFile({ ...rest, bots: [gated, other], botsPermissionDefaultMigrated: true })
    const store = createStore()
    expect(store.getBots().map((bot) => [bot.id, bot.slackGate, bot.slackGateRetired])).toEqual([
      ['b1', undefined, 'jev'],
      ['b2', undefined, undefined]
    ])
    // Nothing else changed: only the save the load asked for is pending.
    await store.flushPendingOrThrowAsync()
    await closeTestStores()
    const written: { bots: Record<string, unknown>[] } = JSON.parse(readPersistedStateJson())
    expect(written.bots.map((bot) => [bot.id, bot.slackGate, bot.slackGateRetired])).toEqual([
      ['b1', undefined, 'jev'],
      ['b2', undefined, undefined]
    ])
  })
})
