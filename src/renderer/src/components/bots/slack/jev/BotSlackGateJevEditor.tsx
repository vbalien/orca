// The Jev gate's whole configuration as one JSON text: checked as it is typed, with examples, a short
// field guide, what older Orca versions would do with it, and the request it sends for a sample message.
import React, { useId, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Maximize2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useTranslate } from '@/i18n/use-translate'
import {
  narrowsLegacyDisclosure,
  slackGateJevLegacyMirror,
  SLACK_GATE_JEV_SEND_KEYS
} from '../../../../../../shared/bots/slack-gate-jev-config'
import { slackGateJevRequest } from '../../../../../../shared/bots/slack-gate-jev-request'
import { parseSlackGateJevText } from '../../../../../../shared/bots/slack-gate-jev-text'
import { slackGateJevExamples, slackGateJevSampleEvent } from './slack-gate-jev-examples'
import { slackGateJevIssueText } from './slack-gate-jev-issue-text'

export const formatSlackGateJevText = (value: unknown): string => JSON.stringify(value, null, 2)

function Disclosure(props: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Collapsible className="group/disclosure">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className="size-3.5 transition-transform group-data-[state=open]/disclosure:rotate-90" />
          {props.title}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pt-1">{props.children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function JsonText(props: {
  id: string
  describedBy: string
  labelledBy?: string
  value: string
  rows: number
  onChange: (text: string) => void
}): React.JSX.Element {
  return (
    <Textarea
      id={props.id}
      aria-describedby={props.describedBy}
      {...(props.labelledBy ? { 'aria-labelledby': props.labelledBy } : {})}
      spellCheck={false}
      wrap="off"
      rows={props.rows}
      variant="code"
      className="min-h-0 resize-y overflow-x-auto whitespace-pre"
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  )
}

export function BotSlackGateJevEditor(props: {
  text: string
  botName: string
  onChange: (text: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const id = useId()
  const statusId = `${id}-status`
  const [wide, setWide] = useState(false)
  const parsed = useMemo(() => parseSlackGateJevText(props.text), [props.text])
  const examples = slackGateJevExamples(t, props.botName)
  const mirror = parsed.ok ? slackGateJevLegacyMirror(parsed.config) : null
  const status = (elementId: string) =>
    parsed.ok ? (
      <p id={elementId} className="text-status-success">
        {t('bots.slack.gate.jev.valid', 'Looks good.')}
      </p>
    ) : (
      <ul id={elementId} role="alert" className="flex flex-col gap-0.5 text-destructive">
        {parsed.issues.slice(0, 4).map((issue) => {
          const text = slackGateJevIssueText(t, issue)
          return <li key={`${issue.code}:${text}`}>{text}</li>
        })}
        {parsed.issues.length > 4 ? (
          <li>
            {t('bots.slack.gate.jev.moreIssues', '…and {{count}} more.', {
              count: parsed.issues.length - 4
            })}
          </li>
        ) : null}
      </ul>
    )
  const examplesMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant="outline">
          {t('bots.slack.gate.jev.insertExample', 'Insert example')}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {examples.map((example) => (
          <DropdownMenuItem
            key={example.id}
            onSelect={() => props.onChange(formatSlackGateJevText(example.config))}
          >
            {example.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
  return (
    // The opener is the dialog's trigger, so closing the larger editor returns focus to it.
    <Dialog open={wide} onOpenChange={setWide}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-json`}>{t('bots.slack.gate.jev.label', 'Jev rules (JSON)')}</Label>
        <div className="flex flex-wrap gap-1.5">
          {examplesMenu}
          <DialogTrigger asChild>
            <Button size="xs" variant="outline">
              <Maximize2 />
              {t('bots.slack.gate.jev.openLarger', 'Open larger')}
            </Button>
          </DialogTrigger>
        </div>
        <JsonText
          id={`${id}-json`}
          describedBy={statusId}
          value={props.text}
          rows={14}
          onChange={props.onChange}
        />
        {status(statusId)}
        {mirror ? (
          <p className="leading-5 text-muted-foreground">
            {t(
              'bots.slack.gate.jev.olderVersions',
              'Older Orca versions use only: “{{question}}” at ≥ {{threshold}}; criteria, other questions and rules are ignored.',
              { question: mirror.question, threshold: mirror.threshold }
            )}
            {parsed.ok && narrowsLegacyDisclosure(parsed.config)
              ? ` ${t(
                  'bots.slack.gate.jev.olderVersionsSend',
                  'They also ignore "send": the message and the thread around it are sent to TypeSafe.'
                )}`
              : null}
          </p>
        ) : null}
        <Disclosure title={t('bots.slack.gate.jev.help', 'Fields')}>
          <ul className="flex list-disc flex-col gap-1 pl-4 leading-5 text-muted-foreground">
            <li>
              {t(
                'bots.slack.gate.jev.helpQuestions',
                '"questions": TypeSafe questions by name — noul (yes/no, criteria true/false), choice (criteria: name → description) or score (criteria: levels, lowest first).'
              )}
            </li>
            <li>
              {t(
                'bots.slack.gate.jev.helpSend',
                '"send": what Jev gets about the message, each true/false; earlierMessages and laterMessages may be a number (keep the last N). Leave it out for the default. Keys: {{keys}}.',
                { keys: SLACK_GATE_JEV_SEND_KEYS.join(', ') }
              )}
            </li>
            <li>
              {t(
                'bots.slack.gate.jev.helpExtra',
                '"extra": fixed values sent along, e.g. what the bot does.'
              )}
            </li>
            <li>
              {t(
                'bots.slack.gate.jev.helpRules',
                '"rules": { "question", "wakeIf" or "blockIf": { "atLeast" | "atMost": n } or { "oneOf": [choices] }, optional "unsureFrom": n }. Any passing blockIf blocks; wakeIf rules combine by "combine" (all | any); "whenUnsure" (block | wake) decides the band between unsureFrom and the limit.'
              )}
            </li>
          </ul>
        </Disclosure>
        <Disclosure title={t('bots.slack.gate.jev.preview', 'Request preview')}>
          {parsed.ok ? (
            <pre className="max-h-64 overflow-auto scrollbar-sleek rounded-md bg-muted p-2 font-mono text-[10px] leading-[14px]">
              {formatSlackGateJevText(
                slackGateJevRequest(
                  parsed.config,
                  { name: props.botName },
                  slackGateJevSampleEvent(t)
                )
              )}
            </pre>
          ) : (
            <p className="text-muted-foreground">
              {t('bots.slack.gate.jev.previewInvalid', 'Fix the JSON to see the request.')}
            </p>
          )}
        </Disclosure>
        <DialogContent className="max-h-[calc(100vh-4rem)] sm:max-w-[min(56rem,calc(100vw-4rem))]">
          <DialogTitle id={`${id}-wide-title`}>
            {t('bots.slack.gate.jev.label', 'Jev rules (JSON)')}
          </DialogTitle>
          <DialogDescription>
            {t('bots.slack.gate.jev.dialogHelp', 'Changes here are the same text as in the card.')}
          </DialogDescription>
          <div className="flex min-h-0 flex-col gap-3">
            <div>{examplesMenu}</div>
            <JsonText
              id={`${id}-json-wide`}
              labelledBy={`${id}-wide-title`}
              describedBy={`${statusId}-wide`}
              value={props.text}
              rows={26}
              onChange={props.onChange}
            />
            <div className="text-xs">{status(`${statusId}-wide`)}</div>
          </div>
        </DialogContent>
      </div>
    </Dialog>
  )
}
