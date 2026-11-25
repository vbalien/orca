// The Connectors row for a bot whose Slack runs through its own app on this computer.
import React from 'react'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { SlackIcon } from '@/components/icons/SlackIcon'
import type { IntegrationCardStatusTone } from '@/components/integrations/presentation/integration-card-shell'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import { BotAppBrandLogo } from '../apps/BotAppBrandLogo'
import { BotConnectorRowFrame } from '../BotConnectorRow'
import type { BotConnectorTitle } from '../bot-connector-titles'
import { BotSlackLocalSettings } from './BotSlackLocalSettings'
import { useBotSlackLocal, type BotSlackLocalStatus } from './use-bot-slack-local'

type Translate = ReturnType<typeof useTranslate>

function face(
  status: BotSlackLocalStatus | null,
  t: Translate
): { description: string; status: { label: string; tone: IntegrationCardStatusTone } | null } {
  const where = status?.teamName ?? status?.teamId
  switch (status?.connection.state) {
    case 'connected':
      return {
        description: where
          ? t('bots.slackLocal.state.connectedTo', 'Your own app in {{place}}, on this computer', {
              place: where
            })
          : t('bots.slackLocal.state.connected', 'Your own app, on this computer'),
        // Connected, yet an answer didn't make it: the settings say which.
        status: status.lastReplyError
          ? {
              label: t('bots.slackLocal.state.replyProblem', 'Answer not posted'),
              tone: 'attention'
            }
          : null
      }
    case 'needs_tokens':
      return {
        description: t('bots.slackLocal.state.needsTokens', 'Paste your Slack app’s tokens'),
        status: { label: t('bots.slackLocal.state.setUp', 'Set up'), tone: 'attention' }
      }
    case 'error':
      return {
        description: t('bots.slackLocal.state.error', 'Slack refused the connection ({{code}})', {
          code: status.connection.error ?? 'error'
        }),
        status: { label: t('bots.slackLocal.state.errorLabel', 'Not connected'), tone: 'attention' }
      }
    case 'paused':
      return {
        description: t(
          'bots.slackLocal.state.paused',
          'Not listening: the bot is paused or bots are off'
        ),
        status: null
      }
    case 'connecting':
    case 'off':
    case undefined:
      return {
        description: t('bots.slackLocal.state.connecting', 'Connecting to Slack…'),
        status: null
      }
  }
}

export function BotSlackLocalCard({
  bot,
  title,
  defaultOpen
}: {
  bot: Bot
  title?: BotConnectorTitle
  defaultOpen?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const local = useBotSlackLocal(bot)
  const confirm = useConfirmationDialog()
  const shown = face(local.status, t)
  const switchBack = async (): Promise<void> => {
    const confirmed = await confirm({
      title: t('bots.slackLocal.switchBack.title', 'Use Orca Cloud’s Slack app for {{name}}?', {
        name: bot.name
      }),
      description: t(
        'bots.slackLocal.switchBack.note',
        'This computer stops listening to your own app and forgets its tokens and the people added for it. Then add Slack again from Connectors.'
      ),
      confirmLabel: t('bots.slackLocal.switchBack.confirm', 'Switch'),
      confirmVariant: 'destructive'
    })
    if (confirmed) {
      await local.switchToOrca(true)
    }
  }
  return (
    <BotConnectorRowFrame
      icon={null}
      logo={<BotAppBrandLogo app={{ id: 'slack', Icon: SlackIcon }} />}
      name={title ?? t('bots.slackLocal.name', 'Slack (your own app)')}
      description={shown.description}
      status={shown.status}
      checking={local.status === null}
      defaultOpen={defaultOpen}
      actions={{
        remove: {
          label: t('bots.slackLocal.switchBack.menu', 'Switch to Orca Cloud’s Slack app…'),
          onSelect: () => void switchBack(),
          disabled: local.busy
        }
      }}
      narrowSpans
    >
      <BotSlackLocalSettings bot={bot} local={local} />
    </BotConnectorRowFrame>
  )
}
