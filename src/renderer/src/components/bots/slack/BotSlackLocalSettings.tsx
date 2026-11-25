// A bot's own Slack app on this computer: its tokens (write-only), the owner and the people who may
// ask, the manifest to create the app with, and the way back to Orca Cloud's app.
import React, { useId, useState } from 'react'
import { toast } from 'sonner'
import { Copy, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTranslate } from '@/i18n/use-translate'
import { updateBot } from '@/lib/bot-catalog'
import type { Bot } from '../../../../../shared/bot-types'
import { LOCAL_SLACK_SOURCE } from '../../../../../shared/connectors/local-slack-conversation'
import { slackLocalManifest } from '../../../../../shared/bots/slack-local-manifest'
import { BotConnectorSection } from '../bot-connector-people'
import { botErrorMessage } from '../bot-presentation'
import type { useBotSlackLocal } from './use-bot-slack-local'
import { BotSlackGateCard } from './BotSlackGateCard'
import { slackLocalErrorText } from './slack-local-error-text'

const MEMBER_ID = /^[A-Z0-9]{2,32}$/

type SlackLocal = ReturnType<typeof useBotSlackLocal>

function memberIds(text: string): string[] | null {
  const ids = text
    .split(/[\s,]+/)
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean)
  return ids.length > 0 && ids.every((id) => MEMBER_ID.test(id)) ? ids : null
}

function TokenFields({ local }: { local: SlackLocal }): React.JSX.Element {
  const t = useTranslate()
  const botId = useId()
  const appId = useId()
  const [botToken, setBotToken] = useState('')
  const [appToken, setAppToken] = useState('')
  const saved = local.status?.tokens.saved === true
  const sealing = local.status?.sealing
  const save = async (): Promise<void> => {
    const ok = await local.setTokens({
      ...(botToken.trim() ? { botToken: botToken.trim() } : {}),
      ...(appToken.trim() ? { appToken: appToken.trim() } : {})
    })
    // Cleared either way: a token is never kept in this window longer than one try.
    setBotToken('')
    setAppToken('')
    if (ok) {
      toast.success(t('bots.slackLocal.tokens.saved', 'Saved. Connecting to Slack…'))
    }
  }
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      {sealing && !sealing.ok ? (
        <p className="text-xs text-destructive">
          {t(
            'bots.slackLocal.tokens.noKeyring',
            "This computer can't seal tokens with an OS keyring, so they can't be saved: {{reason}}",
            { reason: sealing.reason }
          )}
        </p>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor={botId}>{t('bots.slackLocal.tokens.bot', 'Bot User OAuth Token')}</Label>
        <Input
          id={botId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={botToken}
          placeholder={
            saved
              ? t('bots.slackLocal.tokens.savedPlaceholder', 'Saved — paste to replace')
              : t('bots.slackLocal.tokens.botPlaceholder', 'xoxb-…')
          }
          onChange={(event) => setBotToken(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={appId}>{t('bots.slackLocal.tokens.app', 'App-Level Token')}</Label>
        <Input
          id={appId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={appToken}
          placeholder={
            saved
              ? t('bots.slackLocal.tokens.savedPlaceholder', 'Saved — paste to replace')
              : t('bots.slackLocal.tokens.appPlaceholder', 'xapp-…')
          }
          onChange={(event) => setAppToken(event.target.value)}
        />
      </div>
      <Button
        type="submit"
        size="sm"
        disabled={local.busy || (sealing !== undefined && !sealing.ok) || (!botToken && !appToken)}
      >
        {t('bots.slackLocal.tokens.save', 'Save tokens')}
      </Button>
    </form>
  )
}

function OwnerField({ local, teamId }: { local: SlackLocal; teamId: string }): React.JSX.Element {
  const t = useTranslate()
  const id = useId()
  const [value, setValue] = useState(local.status?.ownerUserId ?? '')
  const valid = value.trim() === '' || MEMBER_ID.test(value.trim().toUpperCase())
  return (
    <form
      className="space-y-1.5"
      onSubmit={(event) => {
        event.preventDefault()
        const owner = value.trim().toUpperCase()
        void local.setOwner(teamId, owner === '' ? null : owner)
      }}
    >
      <Label htmlFor={id}>{t('bots.slackLocal.owner.label', 'Your Slack member ID')}</Label>
      <p className="text-xs text-muted-foreground">
        {t(
          'bots.slackLocal.owner.help',
          'In Slack, open your profile, choose ⋯ and Copy member ID. Your requests act as you.'
        )}
      </p>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          value={value}
          placeholder={t('bots.slackLocal.owner.placeholder', 'U0123ABCD')}
          aria-invalid={!valid}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button type="submit" size="sm" variant="outline" disabled={local.busy || !valid}>
          {t('bots.slackLocal.owner.save', 'Save')}
        </Button>
      </div>
    </form>
  )
}

function Askers({
  bot,
  local,
  teamId
}: {
  bot: Bot
  local: SlackLocal
  teamId: string
}): React.JSX.Element {
  const t = useTranslate()
  const id = useId()
  const [value, setValue] = useState('')
  const ids = memberIds(value)
  const askers = local.status?.askers ?? []
  const remove = (memberId: string): void => {
    void updateBot(bot, {
      removeMember: { id: memberId, source: LOCAL_SLACK_SOURCE, workspaceId: teamId }
    }).catch((error: unknown) => toast.error(botErrorMessage(error)))
  }
  return (
    <div className="space-y-2">
      {askers.length > 0 ? (
        <ul className="space-y-1">
          {askers.map((asker) => (
            <li key={asker.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate">
                {asker.name}
                {asker.name !== asker.id ? (
                  <span className="ml-1 text-xs text-muted-foreground">{asker.id}</span>
                ) : null}
              </span>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={t('bots.slackLocal.askers.remove', 'Remove {{name}}', {
                  name: asker.name
                })}
                onClick={() => remove(asker.id)}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t('bots.slackLocal.askers.none', 'Only you can ask, once your member ID is saved.')}
        </p>
      )}
      <form
        className="space-y-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          if (ids) {
            void local.addAskers(teamId, ids).then((ok) => ok && setValue(''))
          }
        }}
      >
        <Label htmlFor={id}>
          {t('bots.slackLocal.askers.add', 'Add people by Slack member ID')}
        </Label>
        <div className="flex items-center gap-2">
          <Input
            id={id}
            value={value}
            placeholder={t('bots.slackLocal.askers.placeholder', 'U0123ABCD, U0456EFGH')}
            onChange={(event) => setValue(event.target.value)}
          />
          <Button type="submit" size="sm" variant="outline" disabled={local.busy || !ids}>
            {t('bots.slackLocal.askers.addButton', 'Add')}
          </Button>
        </div>
      </form>
    </div>
  )
}

export function BotSlackLocalSettings({
  bot,
  local
}: {
  bot: Bot
  local: SlackLocal
}): React.JSX.Element {
  const t = useTranslate()
  const teamId = local.status?.teamId
  const copyManifest = (): void => {
    void navigator.clipboard.writeText(slackLocalManifest(bot.name)).then(
      () => toast.success(t('bots.slackLocal.manifest.copied', 'Manifest copied')),
      () => toast.error(t('bots.slackLocal.manifest.copyFailed', "Couldn't copy the manifest"))
    )
  }
  return (
    <div className="space-y-4">
      <BotConnectorSection title={t('bots.slackLocal.app.title', 'Your Slack app')}>
        <p className="mb-2 text-xs leading-5 text-muted-foreground">
          {t(
            'bots.slackLocal.app.help',
            'Create an app at api.slack.com/apps from this manifest, install it to your workspace, then paste its two tokens below. Slack messages go straight between Slack and this computer.'
          )}
        </p>
        <ol className="mb-2 list-decimal space-y-1 pl-5 text-xs leading-5 text-muted-foreground">
          <li>
            {t(
              'bots.slackLocal.app.botTokenStep',
              'Bot User OAuth Token (xoxb-): OAuth & Permissions, after installing the app.'
            )}
          </li>
          <li>
            {t(
              'bots.slackLocal.app.appTokenStep',
              'App-Level Token (xapp-): Basic Information → App-Level Tokens, with the connections:write scope.'
            )}
          </li>
        </ol>
        <Button type="button" size="sm" variant="outline" onClick={copyManifest}>
          <Copy />
          {t('bots.slackLocal.manifest.copy', 'Copy manifest')}
        </Button>
      </BotConnectorSection>
      <BotConnectorSection title={t('bots.slackLocal.tokens.title', 'Tokens')}>
        <TokenFields local={local} />
      </BotConnectorSection>
      {teamId ? (
        <BotConnectorSection title={t('bots.slackLocal.access.title', 'Who can ask')}>
          <div className="space-y-4">
            <OwnerField
              key={`${teamId}:${local.status?.ownerUserId ?? ''}`}
              local={local}
              teamId={teamId}
            />
            <Askers key={teamId} bot={bot} local={local} teamId={teamId} />
          </div>
        </BotConnectorSection>
      ) : null}
      {local.status && local.status.slackTriggerAutomations.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'bots.slackLocal.triggers',
            "These automations have Slack triggers, which don't run with your own app yet: {{names}}",
            { names: local.status.slackTriggerAutomations.join(', ') }
          )}
        </p>
      ) : null}
      {local.status?.lastReplyError ? (
        <p className="text-xs text-destructive">
          {local.status.lastReplyError === 'reply_uncertain'
            ? t(
                'bots.slackLocal.reply.uncertain',
                "Slack didn't confirm the last answer. Check the thread before asking again."
              )
            : t('bots.slackLocal.reply.failed', "The last answer couldn't be posted ({{code}}).", {
                code: local.status.lastReplyError
              })}
        </p>
      ) : null}
      {local.error ? (
        <p className="text-xs text-destructive">{slackLocalErrorText(t, local.error)}</p>
      ) : null}
      {/* The same "Check before waking" gate as on Orca Cloud's app: it runs after Who can ask. */}
      <BotSlackGateCard bot={bot} />
    </div>
  )
}
