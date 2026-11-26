// A refused change to a bot's own Slack app, in the reader's language; anything else as it came.
import type { useTranslate } from '@/i18n/use-translate'
import { readSlackLocalError } from '../../../../../shared/bots/slack-local-errors'

/** `computer`: the bot's computer as this window names it (useBotAccessPlace). */
export function slackLocalErrorText(
  t: ReturnType<typeof useTranslate>,
  message: string,
  computer: string
): string {
  const error = readSlackLocalError(message)
  const code = error?.detail ?? 'network'
  switch (error?.code) {
    case 'cloud_app_present':
      return t(
        'bots.slackLocal.errors.cloudAppPresent',
        "Remove this bot's Orca Cloud Slack app first (its Slack settings, Remove), then use your own app."
      )
    case 'slack_triggers':
      return t(
        'bots.slackLocal.errors.slackTriggers',
        "This bot has automations with Slack triggers, which don't run with your own Slack app yet. Remove their Slack triggers first."
      )
    case 'not_local':
      return t('bots.slackLocal.errors.notLocal', "This bot doesn't use your own Slack app.")
    case 'no_keyring':
      return t(
        'bots.slackLocal.errors.noKeyring',
        'Slack tokens were not saved: {{computer}} has no OS keyring to seal them with.',
        { computer }
      )
    case 'bot_token_format':
      return t(
        'bots.slackLocal.errors.botTokenFormat',
        'Paste the Bot User OAuth Token, which starts with xoxb-.'
      )
    case 'app_token_format':
      return t(
        'bots.slackLocal.errors.appTokenFormat',
        'Paste the App-Level Token, which starts with xapp-.'
      )
    case 'tokens_refused':
      return t(
        'bots.slackLocal.errors.tokensRefused',
        "Slack didn't accept these tokens ({{code}}).",
        {
          code
        }
      )
    case 'app_unknown':
      return t(
        'bots.slackLocal.errors.appUnknown',
        "Slack didn't say which app these tokens belong to, so they were not saved. Try again."
      )
    case 'app_mismatch':
      return t(
        'bots.slackLocal.errors.appMismatch',
        'The two tokens belong to different Slack apps. Paste both from the same app.'
      )
    case 'app_claimed':
      return t(
        'bots.slackLocal.errors.appClaimed',
        'Another bot already uses this Slack app. Each bot needs its own app.'
      )
    case 'no_bot':
      return t('bots.slackLocal.errors.noBot', 'This bot no longer exists.')
    case 'team_changed':
      return t(
        'bots.slackLocal.errors.teamChanged',
        'The bot now uses another Slack workspace. Check the people again and retry.'
      )
    case undefined:
      return message
  }
}
