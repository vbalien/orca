// A bot on its own Slack app never ends up with an enabled Slack-triggered automation by an update,
// whether the rules change or the automation moves to it.
import { expect, it } from 'vitest'
import { refuseLocalSlackTriggersOnUpdate } from './slack-local-trigger-policy'

const bots = [
  { id: 'cloud', slackConnection: { mode: 'orca' as const } },
  { id: 'local', slackConnection: { mode: 'local' as const } }
]
const slack = [{ source: 'slack' }]
const refused = (
  current: { botId: string; enabled: boolean; on: { source: string }[] | undefined },
  patch: { botId?: string; enabled?: boolean; on?: { source: string }[] }
) => {
  try {
    refuseLocalSlackTriggersOnUpdate(bots, current, patch)
    return false
  } catch {
    return true
  }
}

it('refuses Slack triggers for the bot an automation will run for', () => {
  const onCloud = { botId: 'cloud', enabled: true, on: slack }
  // Moved to the local bot, with its rules kept or given anew.
  expect(refused(onCloud, { botId: 'local' })).toBe(true)
  expect(refused(onCloud, { botId: 'local', on: slack })).toBe(true)
  expect(refused({ ...onCloud, on: [] }, { botId: 'local', on: slack })).toBe(true)
  // Disabled by the same update, or moved without Slack rules: fine.
  expect(refused(onCloud, { botId: 'local', enabled: false })).toBe(false)
  expect(refused(onCloud, { botId: 'local', on: [{ source: 'linear' }] })).toBe(false)
  // Staying on the cloud bot, and a rename of a local one's existing automation, aren't refused.
  expect(refused(onCloud, { on: slack })).toBe(false)
  expect(refused({ botId: 'local', enabled: true, on: slack }, {})).toBe(false)
  // Enabling one on the local bot is.
  expect(refused({ botId: 'local', enabled: false, on: slack }, { enabled: true })).toBe(true)
})
