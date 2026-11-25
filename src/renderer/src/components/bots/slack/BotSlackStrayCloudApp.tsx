// Orca Cloud's Slack app still there for a bot that uses its own app (recorded, or a hand-off redeemed
// after the switch, which only the cloud knows): said, and removable without touching the own app.
import React, { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { refreshBotHost } from '@/lib/bot-catalog'
import { botSlackCalls } from '@/lib/bot-connector-host-calls'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import type { Bot } from '../../../../../shared/bot-types'
import type { ConnectorBotSlackState } from '../../../../../shared/connector-bot-slack-contract'

// A hand-off can be redeemed at any time, and sign-in can come later: asked again while shown.
const RECHECK_MS = 60_000

const gone = (entry: ConnectorBotSlackState): boolean =>
  entry.state === 'not_created' || entry.state === 'grant_expired'

export function BotSlackStrayCloudApp({ bot }: { bot: Bot }): React.JSX.Element | null {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  // The cloud's word when it can be asked; signed out, only what this computer recorded.
  const [inCloud, setInCloud] = useState(false)
  const recorded = Boolean(bot.slack) || (bot.slackApps?.length ?? 0) > 0
  const read = useCallback(async () => {
    const state = await botSlackCalls(bot.hostId).state({ botId: bot.id })
    // A failed read keeps what was last known.
    if (state.ok) {
      setInCloud([state.value, ...(state.value.teams ?? [])].some((entry) => !gone(entry)))
    }
  }, [bot.hostId, bot.id])
  useEffect(() => {
    void read()
    return installWindowVisibilityInterval({ run: () => void read(), intervalMs: RECHECK_MS })
  }, [read])
  if (!recorded && !inCloud) {
    return null
  }
  const remove = async (): Promise<void> => {
    setBusy(true)
    const removed = await botSlackCalls(bot.hostId).remove({ botId: bot.id })
    setBusy(false)
    if (!removed.ok) {
      toast.error(t('bots.slackLocal.strayCloud.failed', "Couldn't remove Orca Cloud's Slack app"))
      return
    }
    await refreshBotHost(bot.hostId)
    await read()
  }
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-xs leading-5 text-muted-foreground">
        {t(
          'bots.slackLocal.strayCloud.note',
          "Orca Cloud's Slack app is still installed for this bot. While the bot uses your own app, messages to that app aren't answered."
        )}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => void remove()}
      >
        {t('bots.slackLocal.strayCloud.remove', "Remove Orca Cloud's Slack app")}
      </Button>
    </div>
  )
}
