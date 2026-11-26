// The gate's key on the bot's computer: OpenAI's for an OpenAI check, the command's own for a command.
// The typed key goes to the host once and is never shown again.
import React, { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTranslate } from '@/i18n/use-translate'
import { callBotRpc } from '@/lib/bot-hosts'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotSlackGate } from '../../../../../shared/bots/bot-slack-gate'
import type { SlackGateKeyStatus } from '../../../../../shared/rpc-contract/bots-slack-gate-params'
import { callSlackGateHost } from './rules/slack-gate-save'

const KEY_METHODS = {
  openai: ['bots.slackGate.setOpenAIKey', 'bots.slackGate.clearOpenAIKey'],
  command: ['bots.slackGate.setKey', 'bots.slackGate.clearKey']
} as const

/** The selected kind's key: OpenAI's for an OpenAI check, the command's own for a command. */
export function BotSlackGateKeyField(props: {
  bot: Bot
  kind: BotSlackGate['kind']
  status: SlackGateKeyStatus | null
  onStatus: (status: SlackGateKeyStatus) => void
  onError: (error: unknown) => void
}): React.JSX.Element {
  const t = useTranslate()
  const id = useId()
  const [input, setInput] = useState('')
  const [setMethod, clearMethod] = KEY_METHODS[props.kind]
  const saved =
    props.kind === 'openai' ? props.status?.openaiKeySet === true : props.status?.apiKeySet === true
  const unsealed = props.status?.sealing === 'unavailable'
  const call = async (method: string) => {
    try {
      const status = await callSlackGateHost(
        (name, params) => callBotRpc<SlackGateKeyStatus>(props.bot, name, params),
        method,
        { botId: props.bot.id, ...(method === setMethod ? { key: input } : {}) }
      )
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both key methods answer a SlackGateKeyStatus.
      props.onStatus(status as SlackGateKeyStatus)
      setInput('')
    } catch (error) {
      props.onError(error)
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${id}-key`}>
        {props.kind === 'openai'
          ? t('bots.slack.gate.openaiKey', 'OpenAI API key')
          : t('bots.slack.gate.key', 'API key')}{' '}
        <span className="font-normal text-muted-foreground">
          {saved
            ? t('bots.slack.gate.keySaved', 'Saved')
            : t('bots.slack.gate.keyMissing', 'Not saved')}
        </span>
      </Label>
      {unsealed ? (
        <p className="text-muted-foreground">
          {t(
            'bots.slack.gate.keyUnsealed',
            'Saving a key needs the system keychain on this bot’s computer, which it does not offer Orca.'
          )}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Input
          id={`${id}-key`}
          type="password"
          autoComplete="off"
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!input.trim() || unsealed}
          onClick={() => void call(setMethod)}
        >
          {t('bots.slack.gate.keySave', 'Save key')}
        </Button>
        {saved ? (
          <Button size="sm" variant="ghost" onClick={() => void call(clearMethod)}>
            {t('bots.slack.gate.keyRemove', 'Remove')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
