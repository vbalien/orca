// "Rules from a script": a command on the bot's computer that writes the OpenAI rules for each message
// (or decides itself). Only Orca on that computer chooses it; elsewhere it is shown, not edited.
import React from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { SlackGateKeyStatus } from '../../../../../shared/rpc-contract/bots-slack-gate-params'

export function BotSlackGateScriptField(props: {
  id: string
  value: string
  onChange: (value: string) => void
  /** Orca here is the bot's computer and can run commands. */
  editable: boolean
  hostHasFeatures: boolean
  computer: string
  lastRun: SlackGateKeyStatus['scriptRun']
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const { id, lastRun } = props
  const at = lastRun ? new Date(lastRun.at).toLocaleString(locale) : ''
  return (
    <>
      <Label htmlFor={`${id}-rules-command`} className="mt-2">
        {t('bots.slack.gate.rulesCommand', 'Rules from a script (optional)')}
      </Label>
      <Input
        id={`${id}-rules-command`}
        variant="code"
        value={props.value}
        disabled={!props.editable || !props.hostHasFeatures}
        aria-describedby={`${id}-rules-command-help`}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <p id={`${id}-rules-command-help`} className="leading-5 text-muted-foreground">
        {props.editable
          ? t(
              'bots.slack.gate.rulesCommandHelp',
              'Gets each message as JSON on stdin and prints the rules to ask OpenAI, or decides itself. It never gets the key. Keep it outside the bot’s folders: the bot’s agent runs as the same user and could change it.'
            )
          : t(
              'bots.slack.gate.rulesCommandRemote',
              'Set in Orca on {{computer}}: a script runs there, so only that computer chooses it.',
              { computer: props.computer }
            )}
      </p>
      {lastRun ? (
        <p className="leading-5 text-muted-foreground">
          {lastRun.outcome === 'error'
            ? t('bots.slack.gate.rulesCommandFailed', 'Last run {{at}}: failed ({{error}}).', {
                at,
                error: lastRun.error ?? ''
              })
            : t('bots.slack.gate.rulesCommandRan', 'Last run {{at}}: {{outcome}}.', {
                at,
                outcome:
                  lastRun.outcome === 'ask'
                    ? t('bots.slack.gate.rulesCommandAsked', 'asked OpenAI')
                    : lastRun.outcome === 'useSaved'
                      ? t('bots.slack.gate.rulesCommandSaved', 'used the saved rules')
                      : t('bots.slack.gate.rulesCommandDecided', 'decided itself')
              })}
        </p>
      ) : null}
    </>
  )
}

/** Limited rules held after the wake counts file could not be read (they wake nothing until then). */
export function LimitsHeld(props: {
  heldUntil: number | 'replaced' | undefined
}): React.JSX.Element | null {
  const t = useTranslate()
  const locale = useIntlLocale()
  if (props.heldUntil === undefined) {
    return null
  }
  return (
    <p className="leading-5 text-muted-foreground">
      {props.heldUntil === 'replaced'
        ? t(
            'bots.slack.gate.limitsHeldReplacing',
            'The wake counts file could not be read: limited rules wake nothing until it is replaced.'
          )
        : t(
            'bots.slack.gate.limitsHeld',
            'The wake counts file could not be read: limited rules wake nothing until {{at}}.',
            { at: new Date(props.heldUntil).toLocaleString(locale) }
          )}
    </p>
  )
}
