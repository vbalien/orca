// Which channel-message threads a bot joined: forgetting them (off its own app, or deleted) closes the
// record for good, so a mention still on its way when that happened never writes it again.
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
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
