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
  BotSlackGateSchema,
  SLACK_GATE_CASES,
  SLACK_GATE_MAX_TIMEOUT_SECONDS,
  type BotSlackGate,
  type SlackGateCase
} from '../../../../../shared/bots/bot-slack-gate'
import {
  formatSlackGateRulesText,
  parseSlackGateRulesText
} from '../../../../../shared/bots/slack-gate-rules-text'
import { BotSlackGateRulesEditor } from './rules/BotSlackGateRulesEditor'
import { SLACK_GATE_DEFAULT_RULES } from '../../../../../shared/bots/slack-gate-default-rules'
import { callSlackGateHost, saveSlackGate, SlackGateHostTooOldError } from './rules/slack-gate-save'
import type { SlackGateKeyStatus } from '../../../../../shared/rpc-contract/bots-slack-gate-params'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import { BotConnectorSection } from '../bot-connector-people'

type Draft = {
  on: boolean
  kind: BotSlackGate['kind']
  appliesTo: SlackGateCase[]
  timeoutSeconds: number
  onError: BotSlackGate['onError']
  command: string
  rulesText: string
}

/** A gate kind this Orca runs; an older host or a kept list can carry another (TypeSafe Jev). */
function knownGate(gate: Bot['slackGate']): BotSlackGate | null {
  return gate?.kind === 'openai' || gate?.kind === 'command' ? gate : null
}

// A new gate is on and checks only thread replies with the default rules (mentions and DMs wake as
// before), and wakes when the check fails: a missed request costs more than an extra wake.
function draftOf(saved: Bot['slackGate']): Draft {
  const gate = knownGate(saved)
  return {
    on: gate?.on ?? true,
    kind: gate?.kind ?? 'openai',
    appliesTo: gate ? [...gate.appliesTo] : ['thread_reply'],
    timeoutSeconds: gate?.timeoutSeconds ?? 10,
    onError: gate?.onError ?? 'wake',
    command: gate?.kind === 'command' ? gate.command : '',
    rulesText: formatSlackGateRulesText(
      gate?.kind === 'openai' ? gate.openai : SLACK_GATE_DEFAULT_RULES
    )
  }
}

function gateOf(draft: Draft): BotSlackGate | null {
  const common = {
    on: draft.on,
    appliesTo: draft.appliesTo,
    timeoutSeconds: draft.timeoutSeconds,
    onError: draft.onError
  }
  const rules = draft.kind === 'openai' ? parseSlackGateRulesText(draft.rulesText) : null
  if (rules && !rules.ok) {
    return null
  }
  const parsed = BotSlackGateSchema.safeParse(
    draft.kind === 'command'
      ? { ...common, kind: 'command', command: draft.command }
      : { ...common, kind: 'openai', openai: rules?.config }
  )
  return parsed.success ? parsed.data : null
}

/** Saves the gate (null removes it) on the bot's host, then reads its bots again. */
async function saveGate(bot: Bot, gate: BotSlackGate | null): Promise<void> {
  try {
    await saveSlackGate((method, params) => callBotRpc(bot, method, params), bot.id, gate)
  } finally {
    await refreshBotHost(bot.hostId)
  }
}

const CASE_LABELS: Record<SlackGateCase, [string, string]> = {
  mention: ['bots.slack.gate.case.mention', 'Mentions'],
  dm: ['bots.slack.gate.case.dm', 'Direct messages'],
  thread_reply: ['bots.slack.gate.case.threadReply', 'Replies in its threads'],
  trigger: ['bots.slack.gate.case.trigger', 'Automation events']
}

export function BotSlackGateCard({ bot }: { bot: Bot }): React.JSX.Element {
  const t = useTranslate()
  // One card per Slack workspace can be mounted at once: ids must be this card's own.
  const id = useId()
  const [draft, setDraft] = useState<Draft>(() => draftOf(bot.slackGate))
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

  const set = (patch: Partial<Draft>) => setDraft((before) => ({ ...before, ...patch }))
  // Parsed once per edit; the editor parses the same text for its messages.
  const gate = useMemo(() => gateOf(draft), [draft])
  const failed = (error: unknown) =>
    toast.error(
      error instanceof SlackGateHostTooOldError
        ? t(
            'bots.slack.gate.hostTooOld',
            'Update Orca on this bot’s computer to use OpenAI Decisions checks.'
          )
        : error instanceof Error && error.message
          ? error.message
          : t('bots.slack.gate.saveFailed', 'Could not save the gate.')
    )
  const save = (next: BotSlackGate | null) => {
    setSaving(true)
    void saveGate(bot, next).then(
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
        </fieldset>
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
          </div>
        )}
        {/* Keyed by host, bot and kind: a typed key never carries over to another one's slot. */}
        <GateKeyField
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
        </div>
      </div>
    </BotConnectorSection>
  )
}

const KEY_METHODS = {
  openai: ['bots.slackGate.setOpenAIKey', 'bots.slackGate.clearOpenAIKey'],
  command: ['bots.slackGate.setKey', 'bots.slackGate.clearKey']
} as const

/** The selected kind's key: OpenAI's for an OpenAI check, the command's own for a command. */
function GateKeyField(props: {
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
