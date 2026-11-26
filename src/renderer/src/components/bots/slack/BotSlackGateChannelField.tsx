// The channels whose messages the gate checks (own Slack app), with what turning it on costs.
import React from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTranslate } from '@/i18n/use-translate'
import { SLACK_GATE_CHANNELS_MAX } from '../../../../../shared/bots/bot-slack-gate'

export function BotSlackGateChannelField(props: {
  id: string
  value: string
  onChange: (value: string) => void
  invalid: boolean
  /** The rules send `case`, so they can tell a channel message from a thread reply. */
  rulesTellChannel: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const { id } = props
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${id}-channels`}>
        {t('bots.slack.gate.channel.ids', 'Channels to check')}
      </Label>
      <Input
        id={`${id}-channels`}
        variant="code"
        value={props.value}
        aria-invalid={props.invalid}
        aria-describedby={`${id}-channels-help`}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <p id={`${id}-channels-help`} className="leading-5 text-muted-foreground">
        {props.invalid
          ? t(
              'bots.slack.gate.channel.idsInvalid',
              'Enter one to {{max}} channel ids (they start with C or G), separated by commas.',
              { max: SLACK_GATE_CHANNELS_MAX }
            )
          : t(
              'bots.slack.gate.channel.idsHelp',
              'In Slack, open the channel’s name, then copy the Channel ID at the bottom. Invite the bot to the channel too.'
            )}
      </p>
      <p className="leading-5 font-medium">
        {t(
          'bots.slack.gate.channel.notice',
          'Every message people who can ask post in these channels is sent to OpenAI (or your command) to decide, one request per message. If the check fails or is unsure, a channel message never wakes the bot.'
        )}
      </p>
      {!props.rulesTellChannel ? (
        <p className="leading-5 text-muted-foreground">
          {t(
            'bots.slack.gate.channel.noCase',
            'These rules don’t tell channel messages apart from thread replies (send “case”). Insert the “Channel messages” example to start from rules that do.'
          )}
        </p>
      ) : null}
    </div>
  )
}
