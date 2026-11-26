// The tuning tool's inputs: labelled cases (JSONL) checked field by field and turned into the gate's own
// events, and a rules file read the way the editor reads it. Problems name a line and a field, never text.
import { readFileSync } from 'node:fs'
import {
  SLACK_GATE_CONTEXT_MARKER_TEXT,
  type SlackGateEvent
} from '../../src/shared/bots/bot-slack-gate'
import { SLACK_GATE_DEFAULT_RULES } from '../../src/shared/bots/slack-gate-default-rules'
import {
  slackGateRulesSends,
  type SlackGateRulesConfig
} from '../../src/shared/bots/slack-gate-rules-config'
import { parseSlackGateRulesText } from '../../src/shared/bots/slack-gate-rules-text'

type Speaker = 'this_bot' | 'app' | 'person'
export type TuneCase = {
  id: string
  expect: 'wake' | 'block'
  botName?: string
  event: {
    case?: 'thread_reply' | 'mention' | 'dm'
    message: string
    earlier?: { from: Speaker; text: string }[]
    /** Earlier messages came before these, as the app marks when it shows only the last few. */
    earlierMore?: boolean
    later?: string[]
    mentioned?: boolean
    fromRole?: 'owner' | 'member'
  }
}

export class TuneStop extends Error {}
export function fail(message: string): never {
  throw new TuneStop(message)
}

const TEXT_CAP = 4000
const TEXT_BUDGET = 64 * 1024
const EARLIER_MAX = 20
const KIND_OF: Record<Speaker, string> = { this_bot: 'self', app: 'bot', person: 'earlier' }
// Event facts a case can't express: a config that sends them would not see what the app sends.
const UNSUPPORTED_SENDS = ['earlierOwn', 'fromName', 'fromApp', 'trigger'] as const

const isText = (value: unknown): value is string => typeof value === 'string'
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isSpeaker = (value: unknown): value is Speaker =>
  value === 'this_bot' || value === 'app' || value === 'person'

/** The case, or its first problem as a field path and a fixed phrase. */
function readCase(value: unknown): TuneCase | string {
  if (!isRecord(value) || !isRecord(value.event)) {
    return 'event: not an object'
  }
  const { id, expect, botName } = value
  const event = value.event
  if (!isText(id) || id.length === 0) {
    return 'id: needs text'
  }
  if (expect !== 'wake' && expect !== 'block') {
    return 'expect: wake or block'
  }
  if (botName !== undefined && !isText(botName)) {
    return 'botName: needs text'
  }
  const gateCase = event.case
  if (
    gateCase !== undefined &&
    gateCase !== 'thread_reply' &&
    gateCase !== 'mention' &&
    gateCase !== 'dm'
  ) {
    return 'event.case: thread_reply, mention or dm'
  }
  if (!isText(event.message)) {
    return 'event.message: needs text'
  }
  if (event.earlierMore !== undefined && typeof event.earlierMore !== 'boolean') {
    return 'event.earlierMore: true or false'
  }
  if (event.mentioned !== undefined && typeof event.mentioned !== 'boolean') {
    return 'event.mentioned: true or false'
  }
  const role = event.fromRole
  if (role !== undefined && role !== 'owner' && role !== 'member') {
    return 'event.fromRole: owner or member'
  }
  const later = event.later
  if (later !== undefined && (!Array.isArray(later) || !later.every(isText))) {
    return 'event.later: a list of texts'
  }
  const earlier: { from: Speaker; text: string }[] = []
  if (event.earlier !== undefined) {
    if (!Array.isArray(event.earlier) || event.earlier.length > EARLIER_MAX) {
      return `event.earlier: a list of at most ${EARLIER_MAX}`
    }
    for (const [index, item] of event.earlier.entries()) {
      if (!isRecord(item) || !isText(item.text) || !isSpeaker(item.from)) {
        return `event.earlier[${index}]: { "from": this_bot | app | person, "text" }`
      }
      earlier.push({ from: item.from, text: item.text })
    }
  }
  const texts = [
    event.message,
    ...(later ?? []),
    // The app's "not shown" note takes its share of the same text budget.
    ...(event.earlierMore === true ? [SLACK_GATE_CONTEXT_MARKER_TEXT.more] : []),
    ...earlier.map((item) => item.text)
  ]
  if (
    texts.some((text) => text.length > TEXT_CAP) ||
    texts.reduce((sum, text) => sum + text.length, 0) > TEXT_BUDGET
  ) {
    return `event: past the app's limits (${TEXT_CAP} characters a text, ${TEXT_BUDGET} in all)`
  }
  return {
    id,
    expect,
    ...(botName !== undefined ? { botName } : {}),
    event: {
      ...(gateCase !== undefined ? { case: gateCase } : {}),
      message: event.message,
      ...(event.earlier !== undefined ? { earlier } : {}),
      ...(later !== undefined ? { later } : {}),
      ...(typeof event.mentioned === 'boolean' ? { mentioned: event.mentioned } : {}),
      ...(event.earlierMore === true ? { earlierMore: true } : {}),
      ...(role !== undefined ? { fromRole: role } : {})
    }
  }
}

/** Cases from the file's text as it was read once (the run's hash is of the same text). */
export function readCases(text: string): TuneCase[] {
  const ids = new Set<string>()
  return text.split('\n').flatMap((line, index) => {
    if (line.trim().length === 0) {
      return []
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // Never the parser's message: it quotes the line, which can be a real Slack message.
      fail(`line ${index + 1}: not JSON`)
    }
    const read = readCase(parsed)
    if (typeof read === 'string') {
      fail(`line ${index + 1}: ${read}`)
    }
    if (ids.has(read.id)) {
      fail(`line ${index + 1}: id: used twice`)
    }
    ids.add(read.id)
    return [read]
  })
}

export function readConfig(path: string | undefined): SlackGateRulesConfig {
  if (!path) {
    return SLACK_GATE_DEFAULT_RULES
  }
  const parsed = parseSlackGateRulesText(readFileSync(path, 'utf8'))
  if (!parsed.ok) {
    fail(
      `the config is not valid: ${parsed.issues
        .slice(0, 5)
        .map((issue) => `line ${issue.line ?? '?'} ${issue.code}`)
        .join('; ')} (open it in the gate's editor for the fields; key names are not printed here)`
    )
  }
  const sends = slackGateRulesSends(parsed.config)
  const unsupported = UNSUPPORTED_SENDS.filter((key) => sends.has(key))
  if (unsupported.length > 0) {
    fail(`cases can't express what this config sends: ${unsupported.join(', ')}`)
  }
  return parsed.config
}

/** The event the app would build for a case: placeholders for ids, a DM's place for a DM. */
export function eventOf(entry: TuneCase): SlackGateEvent {
  const event = entry.event
  const gateCase = event.case ?? 'thread_reply'
  return {
    eventId: entry.id,
    case: gateCase,
    teamId: 'T0',
    channelId: gateCase === 'dm' ? 'D0' : 'C0',
    placeKind: gateCase === 'dm' ? 'direct_message' : 'public_channel',
    from: { userId: 'U0', role: event.fromRole ?? 'member' },
    text: event.message,
    ...(event.later?.length
      ? { later: event.later.map((text) => ({ case: gateCase, text })) }
      : {}),
    ...(event.mentioned !== undefined ? { mentioned: event.mentioned } : {}),
    ...(event.earlier?.length || event.earlierMore
      ? {
          context: [
            ...(event.earlierMore ? [{ kind: 'more', text: '' }] : []),
            ...(event.earlier ?? []).map((item) => ({ kind: KIND_OF[item.from], text: item.text }))
          ]
        }
      : {})
  }
}
