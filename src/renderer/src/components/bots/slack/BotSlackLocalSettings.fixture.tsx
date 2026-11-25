import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { Bot } from '../../../../../shared/bot-types'
import { BotSlackLocalSettings } from './BotSlackLocalSettings'
import type { BotSlackLocalStatus, useBotSlackLocal } from './use-bot-slack-local'

const bot: Bot = {
  id: 'bot-own',
  name: 'Elyang',
  hostId: 'local',
  folder: 'elyang',
  folderWorkspaceId: 'fw-elyang',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  slackConnection: { mode: 'local' },
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}

const base: BotSlackLocalStatus = {
  mode: 'local',
  tokens: { saved: false },
  askers: [],
  connection: { state: 'needs_tokens' },
  sealing: { ok: true },
  slackTriggerAutomations: []
}

function local(status: BotSlackLocalStatus, error: string | null = null) {
  const done = async () => true
  const value: ReturnType<typeof useBotSlackLocal> = {
    status,
    error,
    busy: false,
    refresh: async () => {},
    switchToLocal: done,
    switchToOrca: done,
    setTokens: done,
    setOwner: done,
    addAskers: done
  }
  return value
}

// 420: the bot's Connectors page at a narrow settings width.
export const needsTokens = defineFixture({
  width: 420,
  render: () => <BotSlackLocalSettings bot={bot} local={local(base)} />
})
export const noKeyring = defineFixture({
  width: 420,
  render: () => (
    <BotSlackLocalSettings
      bot={bot}
      local={local({ ...base, sealing: { ok: false, reason: 'No OS keyring is available.' } })}
    />
  )
})
export const connected = defineFixture({
  width: 420,
  render: () => (
    <BotSlackLocalSettings
      bot={bot}
      local={local({
        ...base,
        tokens: { saved: true },
        teamId: 'T0123',
        teamName: 'Acme',
        ownerUserId: 'U0OWNER',
        askers: [{ id: 'U0DANA', name: 'Dana Lee' }],
        connection: { state: 'connected' },
        lastReplyError: 'reply_uncertain',
        slackTriggerAutomations: ['Triage new issues']
      })}
    />
  )
})
export const refused = defineFixture({
  width: 420,
  render: () => (
    <BotSlackLocalSettings
      bot={bot}
      local={local(
        { ...base, tokens: { saved: true }, connection: { state: 'error', error: 'invalid_auth' } },
        "Slack didn't accept these tokens (invalid_auth)."
      )}
    />
  )
})
