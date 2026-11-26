// Which channel-message threads a bot joined: forgetting them (off its own app, or deleted) closes the
// record for good, so a mention still on its way when that happened never writes it again.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BotStateFile, useBotStateRoot } from '../bots/slack-gate/bot-state-file'
import { SlackLocalParticipations } from './slack-local-participation'

beforeEach(() => useBotStateRoot(mkdtempSync(join(tmpdir(), 'participation-'))))
afterEach(() => useBotStateRoot(null))

const file = () => new BotStateFile('slack-local-participation', 'b1').path

it('never writes a forgotten bot’s record again, and starts a new one when it comes back', async () => {
  const records = new SlackLocalParticipations(() => true)
  const before = records.of('b1')
  const mention = before.mentionStarted('T1:C1:1.0:U0BOT:c')
  records.forget('b1')
  await before.forget()
  // The mention lands after the bot was forgotten.
  mention(true)
  before.add('T1:C1:2.0:U0BOT:c')
  expect(before.has('T1:C1:1.0:U0BOT:c')).toBe(false)
  expect(existsSync(file())).toBe(false)
  // Back on its own app: a new record.
  const after = records.of('b1')
  expect(after).not.toBe(before)
  after.add('T1:C1:3.0:U0BOT:c')
  expect(after.has('T1:C1:3.0:U0BOT:c')).toBe(true)
})

it('lets a new record write only after the forgotten one is gone, and keeps what an earlier run wrote', async () => {
  const records = new SlackLocalParticipations(() => true)
  records.of('b1').add('T1:C1:1.0:U0BOT:c')
  await vi.waitFor(() => expect(existsSync(file())).toBe(true))
  // Off and straight back on: the new record's thread survives the old record's removal.
  records.forget('b1')
  records.of('b1').add('T1:C1:2.0:U0BOT:c')
  await vi.waitFor(() =>
    expect(JSON.parse(readFileSync(file(), 'utf8')).threads).toEqual(['T1:C1:2.0:U0BOT:c'])
  )
  // A restart: the first thread joined adds to what the file had, never replaces it.
  const restarted = new SlackLocalParticipations(() => true)
  restarted.of('b1').add('T1:C1:3.0:U0BOT:c')
  await vi.waitFor(() =>
    expect(JSON.parse(readFileSync(file(), 'utf8')).threads.sort()).toEqual([
      'T1:C1:2.0:U0BOT:c',
      'T1:C1:3.0:U0BOT:c'
    ])
  )
})

it('keeps a new record through two removals in a row', async () => {
  const records = new SlackLocalParticipations(() => true)
  records.of('b1').add('T1:C1:1.0:U0BOT:c')
  records.forget('b1')
  records.of('b1').add('T1:C1:2.0:U0BOT:c')
  records.forget('b1')
  records.of('b1').add('T1:C1:3.0:U0BOT:c')
  await vi.waitFor(() =>
    expect(JSON.parse(readFileSync(file(), 'utf8')).threads).toEqual(['T1:C1:3.0:U0BOT:c'])
  )
})
