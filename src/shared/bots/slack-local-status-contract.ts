// `bots.slackLocal.*` answers: a bot's own Slack app as its settings show it, never its tokens.
export type SlackLocalConnectionState =
  | 'off'
  /** Local, but the bot is paused or bots are off, so nothing listens. */
  | 'paused'
  | 'needs_tokens'
  | 'connecting'
  | 'connected'
  | 'error'

export type SlackLocalStatus = {
  mode: 'orca' | 'local'
  tokens: { saved: boolean }
  teamId?: string
  teamName?: string
  appId?: string
  botUserId?: string
  ownerUserId?: string
  askers: { id: string; name: string }[]
  connection: { state: SlackLocalConnectionState; error?: string }
  lastReplyError?: string
  sealing: { ok: true } | { ok: false; reason: string }
  /** Enabled automations of the bot with Slack triggers, which don't run on its own app. */
  slackTriggerAutomations: string[]
}
