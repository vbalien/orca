// The choice between Orca Cloud's Slack app and the bot's own app on this computer.
import React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import { useBotSlackLocal } from './use-bot-slack-local'
import { slackLocalErrorText } from './slack-local-error-text'

/** In an installed Orca Cloud workspace's body: which app it is, and how to change it. */
export function BotSlackConnectionLine(): React.JSX.Element {
  const t = useTranslate()
  return (
    <p className="mt-3 text-xs leading-5 text-muted-foreground">
      {t(
        'bots.slackLocal.connection.orca',
        'Connected through Orca Cloud’s Slack app. To use your own Slack app on this computer instead, remove this one first, then add Slack again.'
      )}
    </p>
  )
}

/** Before Orca Cloud's setup (and its sign-in): use the bot's own Slack app instead. */
export function BotSlackUseOwnApp({
  bot,
  onDone
}: {
  bot: Bot
  onDone: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const local = useBotSlackLocal(bot)
  const choose = async (): Promise<void> => {
    if (await local.switchToLocal()) {
      toast.success(
        t(
          'bots.slackLocal.chosen',
          'Open Slack in {{name}}’s Connectors to finish setting it up.',
          {
            name: bot.name
          }
        )
      )
      onDone()
    }
  }
  return (
    <div className="mb-4 space-y-1.5 rounded-md border border-border p-3">
      <p className="text-xs leading-5 text-muted-foreground">
        {t(
          'bots.slackLocal.choose.help',
          'Or use a Slack app you make yourself. This computer talks to it directly, so messages don’t go through Orca Cloud.'
        )}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={local.busy}
        onClick={() => void choose()}
      >
        {t('bots.slackLocal.choose.button', 'Use my own Slack app')}
      </Button>
      {local.error ? (
        <p className="text-xs text-destructive">{slackLocalErrorText(t, local.error)}</p>
      ) : null}
    </div>
  )
}
