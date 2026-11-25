// Why a change to a bot's own Slack app was refused, as a stable code the desktop UI translates.
export const SLACK_LOCAL_ERROR_CODES = [
  'cloud_app_present',
  'slack_triggers',
  'not_local',
  'no_keyring',
  'bot_token_format',
  'app_token_format',
  'tokens_refused',
  'app_unknown',
  'app_mismatch',
  'app_claimed',
  'no_bot',
  'team_changed'
] as const
export type SlackLocalErrorCode = (typeof SLACK_LOCAL_ERROR_CODES)[number]

const PREFIX = 'slack_local:'
const PATTERN = /slack_local:([a-z_]+)(?::([A-Za-z0-9_.-]{1,64}))?/

/** `slack_local:<code>[:<detail>]`; the detail is Slack's own error code, never a token. */
export function slackLocalErrorMessage(code: SlackLocalErrorCode, detail?: string): string {
  return `${PREFIX}${code}${detail ? `:${detail}` : ''}`
}

export function readSlackLocalError(
  message: string
): { code: SlackLocalErrorCode; detail?: string } | null {
  const match = PATTERN.exec(message)
  const code = SLACK_LOCAL_ERROR_CODES.find((known) => known === match?.[1])
  return code ? { code, ...(match?.[2] ? { detail: match[2] } : {}) } : null
}
