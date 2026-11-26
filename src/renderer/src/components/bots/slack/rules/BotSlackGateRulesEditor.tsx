// The OpenAI Decisions gate's whole configuration as one JSON text: checked as it is typed, with examples,
// a short field guide, and the request it sends for a sample message.
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
import { SLACK_GATE_SEND_KEYS } from '../../../../../../shared/bots/slack-gate-rules-config'
import { slackGateOpenAIRequest } from '../../../../../../shared/bots/slack-gate-openai-request'
import {
  formatSlackGateRulesText,
  parseSlackGateRulesText
} from '../../../../../../shared/bots/slack-gate-rules-text'
import {
  SLACK_GATE_RULES_EXAMPLES,
  type SlackGateRulesExample
} from '../../../../../../shared/bots/slack-gate-default-rules'
import { SLACK_GATE_SAMPLE_EVENT } from './slack-gate-rules-examples'
import { slackGateRulesIssueText } from './slack-gate-rules-issue-text'

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

const EXAMPLE_LABELS: Record<SlackGateRulesExample['id'], [string, string]> = {
  default: ['bots.slack.gate.rules.example.default', 'Default: skip replies not meant for the bot'],
  smallTalk: ['bots.slack.gate.rules.example.smallTalk', 'Block small talk'],
  topic: ['bots.slack.gate.rules.example.topic', 'Topic and urgency']
}

export function BotSlackGateRulesEditor(props: {
  text: string
  botName: string
  onChange: (text: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const id = useId()
  const statusId = `${id}-status`
  const [wide, setWide] = useState(false)
  const parsed = useMemo(() => parseSlackGateRulesText(props.text), [props.text])
  const request = parsed.ok
    ? slackGateOpenAIRequest(parsed.config, { name: props.botName }, SLACK_GATE_SAMPLE_EVENT)
    : null
  const status = (elementId: string) =>
    parsed.ok ? (
      <p id={elementId} className="text-status-success">
        {t('bots.slack.gate.rules.valid', 'Looks good.')}
      </p>
    ) : (
      <ul id={elementId} role="alert" className="flex flex-col gap-0.5 text-destructive">
        {parsed.issues.slice(0, 4).map((issue) => {
          const text = slackGateRulesIssueText(t, issue)
          return <li key={`${issue.code}:${text}`}>{text}</li>
        })}
        {parsed.issues.length > 4 ? (
          <li>
            {t('bots.slack.gate.rules.moreIssues', '…and {{count}} more.', {
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
          {t('bots.slack.gate.rules.insertExample', 'Insert example')}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {SLACK_GATE_RULES_EXAMPLES.map((example) => (
          <DropdownMenuItem
            key={example.id}
            onSelect={() => props.onChange(formatSlackGateRulesText(example.config))}
          >
            {t(...EXAMPLE_LABELS[example.id])}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
  return (
    // The opener is the dialog's trigger, so closing the larger editor returns focus to it.
    <Dialog open={wide} onOpenChange={setWide}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-json`}>
          {t('bots.slack.gate.rules.label', 'OpenAI Decisions rules (JSON)')}
        </Label>
        <div className="flex flex-wrap gap-1.5">
          {examplesMenu}
          <DialogTrigger asChild>
            <Button size="xs" variant="outline">
              <Maximize2 />
              {t('bots.slack.gate.rules.openLarger', 'Open larger')}
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
        <Disclosure title={t('bots.slack.gate.rules.help', 'Fields')}>
          <ul className="flex list-disc flex-col gap-1 pl-4 leading-5 text-muted-foreground">
            <li>
              {t(
                'bots.slack.gate.rules.helpMentions',
                'The default rules suit replies in a thread; mentions wake without a check. Through Orca Cloud, a mention in a thread the bot has no chat in can’t be told from a reply and is checked, and a very short one can read as not meant for the bot.'
              )}
            </li>
            <li>
              {t(
                'bots.slack.gate.rules.helpQuestions',
                '"questions": a list of OpenAI Decisions questions, each with a unique "name" and "instructions" — predicate (yes/no, answered as a probability 0–1), choice ("choices": [{ "value", "description" }], values text or true/false) or score ("levels": [{ "label", "description" }], lowest first; answered 0 to levels − 1).'
              )}
            </li>
            <li>
              {t(
                'bots.slack.gate.rules.helpSend',
                '"send": what OpenAI gets about the message, each true/false; earlierMessages and laterMessages may be a number (keep the last N); earlierSpeakers marks each earlier message from this_bot, app, person or note. Leave it out for the default. Keys: {{keys}}.',
                { keys: SLACK_GATE_SEND_KEYS.join(', ') }
              )}
            </li>
            <li>
              {t(
                'bots.slack.gate.rules.helpExtra',
                '"extra": fixed values sent along, e.g. what the bot does.'
              )}
            </li>
            <li>
              {t(
                'bots.slack.gate.rules.helpRules',
                '"rules": { "question", "wakeIf" or "blockIf": { "atLeast" | "atMost": n } or { "oneOf": [choices] }, optional "unsureFrom": n }. Any passing blockIf blocks; wakeIf rules combine by "combine" (all | any); "whenUnsure" (block | wake) decides the band between unsureFrom and the limit.'
              )}
            </li>
          </ul>
        </Disclosure>
        <Disclosure title={t('bots.slack.gate.rules.preview', 'Request preview')}>
          {request ? (
            <pre className="max-h-64 overflow-auto scrollbar-sleek rounded-md bg-muted p-2 font-mono text-3xs">
              {formatSlackGateRulesText(request)}
            </pre>
          ) : (
            <p className="text-muted-foreground">
              {t('bots.slack.gate.rules.previewInvalid', 'Fix the JSON to see the request.')}
            </p>
          )}
        </Disclosure>
        <DialogContent
          aria-labelledby={`${id}-wide-title`}
          className="max-h-[calc(100vh-4rem)] sm:max-w-[min(56rem,calc(100vw-4rem))]"
        >
          <DialogTitle id={`${id}-wide-title`}>
            {t('bots.slack.gate.rules.label', 'OpenAI Decisions rules (JSON)')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'bots.slack.gate.rules.dialogHelp',
              'Changes here are the same text as in the card.'
            )}
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
