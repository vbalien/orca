// "Check before waking": the bot's Slack wake gate, OpenAI Decisions or a command that decides whether a
// Slack message or automation event wakes the bot. A section of its own in the Slack connector page.
import React, { useEffect, useId, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
import { refreshBotHost } from '@/lib/bot-catalog'
import { botRefKey, callBotRpc } from '@/lib/bot-hosts'
import { isWindowsDesktopClient } from '@/lib/files/os-open/windows-path-access'
import type { Bot } from '../../../../../shared/bot-types'
import {
  SLACK_GATE_CASES,
  SLACK_GATE_CHANNELS_MAX,
  SLACK_GATE_MAX_TIMEOUT_SECONDS,
  type BotSlackGateEdit,
  type SlackGateSettingCase
} from '../../../../../shared/bots/bot-slack-gate'
import {
  formatSlackGateRulesText,
  parseSlackGateRulesText
} from '../../../../../shared/bots/slack-gate-rules-text'
import { channelIdsOf, draftOf, gateOf, knownGate, type SlackGateDraft } from './slack-gate-draft'
import { BotSlackGateKeyField } from './BotSlackGateKeyField'
import { BotSlackGateScriptField } from './BotSlackGateScriptField'
import { BotSlackGateChannelField } from './BotSlackGateChannelField'
import {
  slackGateRulesExtended,
  slackGateRulesSends
} from '../../../../../shared/bots/slack-gate-rules-config'
import { isBlockAllStandIn } from '../../../../../shared/bots/slack-gate-store-form'
import { usesLocalSlack } from '../../../../../shared/bots/bot-slack-connection'
import { BotSlackGateRulesEditor } from './rules/BotSlackGateRulesEditor'
import {
  SLACK_GATE_CHANNEL_DEFAULT_RULES,
  SLACK_GATE_DEFAULT_RULES
} from '../../../../../shared/bots/slack-gate-default-rules'
import { callSlackGateHost, saveSlackGate, SlackGateHostTooOldError } from './rules/slack-gate-save'
import { useBotAccessPlace } from '../use-bot-access-place'
import type { SlackGateKeyStatus } from '../../../../../shared/rpc-contract/bots-slack-gate-params'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import { BotConnectorSection } from '../bot-connector-people'

/** Saves the gate (null removes it) on the bot's host, then reads its bots again. */
async function saveGate(
  bot: Bot,
  gate: BotSlackGateEdit | null,
  hostHasFeatures: boolean
): Promise<void> {
  try {
    await saveSlackGate(
      (method, params) => callBotRpc(bot, method, params),
      bot.id,
      gate,
      hostHasFeatures
    )
  } finally {
    await refreshBotHost(bot.hostId)
  }
}

const CASE_LABELS: Record<SlackGateSettingCase, [string, string]> = {
  mention: ['bots.slack.gate.case.mention', 'Mentions'],
  dm: ['bots.slack.gate.case.dm', 'Direct messages'],
  thread_reply: ['bots.slack.gate.case.threadReply', 'Replies in its threads'],
  trigger: ['bots.slack.gate.case.trigger', 'Automation events']
}

export function BotSlackGateCard({ bot }: { bot: Bot }): React.JSX.Element {
  const t = useTranslate()
  // One card per Slack workspace can be mounted at once: ids must be this card's own.
  const id = useId()
  const [draft, setDraft] = useState<SlackGateDraft>(() => draftOf(bot.slackGate))
  // The gate as saved; when it changes (a save, a removal, another device) an untouched form follows.
  const saved = bot.slackGate ?? null
  const [seen, setSeen] = useState(saved)
  if (JSON.stringify(saved) !== JSON.stringify(seen)) {
    setSeen(saved)
    if (JSON.stringify(draft) === JSON.stringify(draftOf(seen))) {
      setDraft(draftOf(saved))
    }
  }
  const [saving, setSaving] = useState(false)
  const [keyStatus, setKeyStatus] = useState<SlackGateKeyStatus | null>(null)
  const commandUnsupported = bot.hostId === LOCAL_EXECUTION_HOST_ID && isWindowsDesktopClient()
  const place = useBotAccessPlace(bot.hostId)
  const features = keyStatus?.features ?? []
  const hostHasFeatures = features.length > 0
  const localApp = usesLocalSlack(bot)

  useEffect(() => {
    let current = true
    callBotRpc<SlackGateKeyStatus>(bot, 'bots.slackGate.status', { botId: bot.id }).then(
      (status) => current && setKeyStatus(status),
      () => current && setKeyStatus(null)
    )
    return () => {
      current = false
    }
  }, [bot])

  const set = (patch: Partial<SlackGateDraft>) => setDraft((before) => ({ ...before, ...patch }))
  // Parsed once per edit; the editor parses the same text for its messages.
  const gate = useMemo(() => gateOf(draft), [draft])
  const failed = (error: unknown) =>
    toast.error(
      error instanceof SlackGateHostTooOldError
        ? error.feature === 'openai'
          ? t(
              'bots.slack.gate.hostTooOld',
              'Update Orca on this bot’s computer to use OpenAI Decisions checks.'
            )
          : t(
              'bots.slack.gate.hostTooOldNewer',
              'Update Orca on this bot’s computer to use channel messages, rules scripts, notes or limits.'
            )
        : error instanceof Error && error.message
          ? error.message
          : t('bots.slack.gate.saveFailed', 'Could not save the gate.')
    )
  const save = (next: BotSlackGateEdit | null) => {
    setSaving(true)
    void saveGate(bot, next, hostHasFeatures).then(
      () => {
        setSaving(false)
        toast.success(t('bots.slack.gate.saved', 'Gate saved.'))
      },
      (error: unknown) => {
        setSaving(false)
        failed(error)
      }
    )
  }
  const unknownKind = Boolean(bot.slackGate) && !knownGate(bot.slackGate)
  const savedGate = knownGate(bot.slackGate)
  // An older Orca saved the gate and kept only the block-everything stand-in for its newer rules.
  const standIn =
    savedGate?.kind === 'openai' && !savedGate.newer && isBlockAllStandIn(savedGate.openai)
  const restore = () => {
    setSaving(true)
    void callSlackGateHost(
      (method, params) => callBotRpc(bot, method, params),
      'bots.slackGate.restore',
      { botId: bot.id }
    )
      .then(() => refreshBotHost(bot.hostId))
      .then(
        () => {
          setSaving(false)
          toast.success(t('bots.slack.gate.restored', 'Gate settings restored.'))
        },
        (error: unknown) => {
          setSaving(false)
          failed(error)
        }
      )
  }
  const parsedRules = draft.kind === 'openai' ? parseSlackGateRulesText(draft.rulesText) : null
  const rulesConfig = parsedRules?.ok ? parsedRules.config : null
  // Rules a failed check can't honor never wake the bot then (plan "확인 실패").
  const failsClosed =
    draft.kind === 'openai' &&
    (draft.rulesCommand.trim().length > 0 ||
      (rulesConfig !== null && slackGateRulesExtended(rulesConfig).limits))
  const channelIds = channelIdsOf(draft.channelsText)
  const channelsInvalid =
    draft.channelMessages &&
    (channelIds === null || channelIds.length === 0 || channelIds.length > SLACK_GATE_CHANNELS_MAX)
  const rulesTellChannel = rulesConfig === null || slackGateRulesSends(rulesConfig).has('case')
  const setChannelMessages = (on: boolean) => {
    // Turning channel messages on with the untouched thread rules switches to rules for both.
    const untouched = draft.rulesText === formatSlackGateRulesText(SLACK_GATE_DEFAULT_RULES)
    if (on && draft.kind === 'openai' && untouched) {
      set({
        channelMessages: true,
        rulesText: formatSlackGateRulesText(SLACK_GATE_CHANNEL_DEFAULT_RULES)
      })
      toast.message(
        t(
          'bots.slack.gate.channel.rulesSwitched',
          'Rules switched to the default for thread replies and channel messages.'
        )
      )
      return
    }
    set({ channelMessages: on })
  }
  const scriptEditable = place.local && !commandUnsupported

  return (
    <BotConnectorSection title={t('bots.slack.gate.title', 'Check before waking')}>
      <div className="flex flex-col gap-3 text-xs">
        <p className="leading-5 text-muted-foreground">
          {t(
            'bots.slack.gate.intro',
            'Run a check first; the bot wakes only when the check lets the message through.'
          )}
        </p>
        {unknownKind ? (
          <p className="leading-5 text-muted-foreground">
            {t(
              'bots.slack.gate.unknownKind',
              'Orca on this bot’s computer uses a check this Orca does not know (such as TypeSafe Jev), and may still run it. Update Orca there, or remove the check.'
            )}
          </p>
        ) : standIn ? (
          <p className="leading-5 text-muted-foreground">
            {t(
              'bots.slack.gate.standIn',
              'An older Orca saved these rules without its newer settings; until they are back, the check blocks every message it checks.'
            )}
          </p>
        ) : bot.slackGateRetired === 'jev' && !bot.slackGate ? (
          <p className="leading-5 text-muted-foreground">
            {t(
              'bots.slack.gate.retiredJev',
              'The earlier TypeSafe Jev check is no longer available and was turned off.'
            )}
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={`${id}-on`}>{t('bots.slack.gate.on', 'Check messages')}</Label>
          <Switch id={`${id}-on`} checked={draft.on} onCheckedChange={(on) => set({ on })} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-kind`}>{t('bots.slack.gate.kind', 'Check with')}</Label>
          <Select
            value={draft.kind}
            onValueChange={(kind) => set({ kind: kind === 'command' ? 'command' : 'openai' })}
          >
            <SelectTrigger id={`${id}-kind`} size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="openai">
                {t('bots.slack.gate.kindOpenAI', 'OpenAI Decisions')}
              </SelectItem>
              <SelectItem value="command" disabled={commandUnsupported}>
                {t('bots.slack.gate.kindCommand', 'A command on this computer')}
              </SelectItem>
            </SelectContent>
          </Select>
          {commandUnsupported ? (
            <p className="text-muted-foreground">
              {t('bots.slack.gate.windows', 'Command checks are not available on Windows yet.')}
            </p>
          ) : null}
        </div>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 font-medium">{t('bots.slack.gate.appliesTo', 'Check')}</legend>
          {SLACK_GATE_CASES.map((gateCase) => {
            const caseId = `${id}-${gateCase}`
            const [key, text] = CASE_LABELS[gateCase]
            return (
              <div key={gateCase} className="flex items-center gap-2">
                <Checkbox
                  id={caseId}
                  checked={draft.appliesTo.includes(gateCase)}
                  onCheckedChange={(checked) =>
                    set({
                      appliesTo: SLACK_GATE_CASES.filter((entry) =>
                        entry === gateCase ? checked === true : draft.appliesTo.includes(entry)
                      )
                    })
                  }
                />
                <Label htmlFor={caseId}>{t(key, text)}</Label>
              </div>
            )
          })}
          {localApp || draft.channelMessages ? (
            <div className="flex items-center gap-2">
              <Checkbox
                id={`${id}-channel`}
                checked={draft.channelMessages}
                disabled={!hostHasFeatures}
                onCheckedChange={(checked) => setChannelMessages(checked === true)}
              />
              <Label htmlFor={`${id}-channel`}>
                {t('bots.slack.gate.case.channelMessage', 'Channel messages (your own Slack app)')}
              </Label>
            </div>
          ) : null}
        </fieldset>
        {draft.channelMessages ? (
          <BotSlackGateChannelField
            id={id}
            value={draft.channelsText}
            onChange={(channelsText) => set({ channelsText })}
            invalid={channelsInvalid}
            rulesTellChannel={rulesTellChannel}
          />
        ) : null}
        {draft.kind === 'command' ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-command`}>{t('bots.slack.gate.command', 'Command')}</Label>
            <Input
              id={`${id}-command`}
              variant="code"
              value={draft.command}
              onChange={(event) => set({ command: event.target.value })}
            />
            <p className="leading-5 text-muted-foreground">
              {t(
                'bots.slack.gate.commandHelp',
                'Gets the message as JSON on stdin. Exit 0 wakes the bot, exit 1 does not.'
              )}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <BotSlackGateRulesEditor
              text={draft.rulesText}
              botName={bot.name}
              onChange={(rulesText) => set({ rulesText })}
            />
            <p className="leading-5 text-muted-foreground">
              {t('bots.slack.gate.openaiNotice', 'Slack message text is sent to OpenAI.')}
            </p>
            <BotSlackGateScriptField
              id={id}
              value={draft.rulesCommand}
              onChange={(rulesCommand) => set({ rulesCommand })}
              editable={scriptEditable}
              hostHasFeatures={hostHasFeatures}
              computer={place.computer}
              lastRun={keyStatus?.scriptRun}
            />
          </div>
        )}
        {failsClosed ? (
          <p className="leading-5 text-muted-foreground">
            {t(
              'bots.slack.gate.failsClosed',
              'With a rules script or limits, a check that fails never wakes the bot, whatever “If the check fails” says.'
            )}
          </p>
        ) : null}
        {/* Keyed by host, bot and kind: a typed key never carries over to another one's slot. */}
        <BotSlackGateKeyField
          key={`${botRefKey(bot)}:${draft.kind}`}
          bot={bot}
          kind={draft.kind}
          status={keyStatus}
          onStatus={setKeyStatus}
          onError={failed}
        />
        <div className="flex gap-2">
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor={`${id}-timeout`}>
              {t('bots.slack.gate.timeout', 'Time limit (seconds)')}
            </Label>
            <Input
              id={`${id}-timeout`}
              type="number"
              min={1}
              max={SLACK_GATE_MAX_TIMEOUT_SECONDS}
              value={draft.timeoutSeconds}
              onChange={(event) => set({ timeoutSeconds: Math.round(Number(event.target.value)) })}
            />
          </div>
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor={`${id}-on-error`}>
              {t('bots.slack.gate.onError', 'If the check fails')}
            </Label>
            <Select
              value={draft.onError}
              onValueChange={(onError) => set({ onError: onError === 'block' ? 'block' : 'wake' })}
            >
              <SelectTrigger id={`${id}-on-error`} size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="wake">
                  {t('bots.slack.gate.onErrorWake', 'Wake the bot')}
                </SelectItem>
                <SelectItem value="block">
                  {t('bots.slack.gate.onErrorBlock', 'Stay asleep')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" disabled={!gate || saving} onClick={() => save(gate)}>
            {t('bots.slack.gate.save', 'Save')}
          </Button>
          {bot.slackGate ? (
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => save(null)}>
              {t('bots.slack.gate.remove', 'Remove check')}
            </Button>
          ) : null}
          {keyStatus?.restorable ? (
            <Button size="sm" variant="outline" disabled={saving} onClick={restore}>
              {t('bots.slack.gate.restore', 'Restore settings an older Orca dropped')}
            </Button>
          ) : null}
        </div>
      </div>
    </BotConnectorSection>
  )
}
