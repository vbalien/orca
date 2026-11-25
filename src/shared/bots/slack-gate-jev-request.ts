// What a Jev gate sends to TypeSafe for one Slack event: the configured questions as they are, and a
// `state` of the event facts the config picks plus its fixed extra values. Never Slack or Orca ids.
// Shared so the editor's preview shows the very body the host sends.
import { SLACK_GATE_DEFAULT_MODEL, type SlackGateEvent } from './bot-slack-gate'
import {
  slackGateJevConfigOf,
  slackGateJevSends,
  type SlackGateJevConfig,
  type SlackGateJevQuestion,
  type StoredSlackGateJev
} from './slack-gate-jev-config'

/** Context items without text, shown to every gate kind by these words (Jev reads only texts). */
export const SLACK_GATE_CONTEXT_MARKER_TEXT = {
  more: '(earlier messages in this thread are not shown)',
  unreadable: '(this thread could not be read)'
} as const

export type SlackGateJevRequest = {
  model: string
  state: Record<string, unknown>
  questions: Record<string, SlackGateJevQuestion>
}

const isMarker = (kind: string): kind is keyof typeof SLACK_GATE_CONTEXT_MARKER_TEXT =>
  kind === 'more' || kind === 'unreadable'

/** Exactly the body gates saved before configurable rules sent; their behaviour must not move. */
function legacyState(event: SlackGateEvent): Record<string, unknown> {
  return {
    case: event.case,
    place: event.placeKind,
    fromRole: event.from.role ?? 'member',
    message: event.text,
    ...(event.later?.length ? { laterMessages: event.later.map((entry) => entry.text) } : {}),
    ...(event.earlierOwn ? { earlierOwn: event.earlierOwn } : {}),
    ...(event.context?.length ? { earlierMessages: event.context.map((entry) => entry.text) } : {}),
    ...(event.truncated ? { truncated: true } : {})
  }
}

/** Earlier messages, the last `limit` of them, with a marker first whenever some are not shown. */
function earlierMessages(event: SlackGateEvent, limit: true | number): string[] {
  const context = event.context ?? []
  const markers = context.flatMap((entry) =>
    isMarker(entry.kind) ? [SLACK_GATE_CONTEXT_MARKER_TEXT[entry.kind]] : []
  )
  const messages = context.filter((entry) => !isMarker(entry.kind)).map((entry) => entry.text)
  const kept = limit === true ? messages : limit === 0 ? [] : messages.slice(-limit)
  const lead = [...new Set(markers)]
  if ((kept.length < messages.length || event.contextIncomplete) && lead.length === 0) {
    lead.push(SLACK_GATE_CONTEXT_MARKER_TEXT[event.contextIncomplete ?? 'more'])
  }
  return [...lead, ...kept]
}

function configuredState(
  config: SlackGateJevConfig,
  bot: { name?: string },
  event: SlackGateEvent
): Record<string, unknown> {
  const state: Record<string, unknown> = {}
  for (const [key, limit] of slackGateJevSends(config)) {
    switch (key) {
      case 'message':
        state.message = event.text
        break
      case 'laterMessages': {
        const later = (event.later ?? []).map((entry) => entry.text)
        const kept = limit === true ? later : limit === 0 ? [] : later.slice(-limit)
        if (kept.length > 0) {
          state.laterMessages = kept
        }
        break
      }
      case 'earlierMessages': {
        const earlier = earlierMessages(event, limit)
        if (earlier.length > 0) {
          state.earlierMessages = earlier
        }
        break
      }
      case 'earlierOwn':
        if (event.earlierOwn) {
          state.earlierOwn = event.earlierOwn
        }
        break
      case 'case':
        state.case = event.case
        break
      case 'place':
        state.place = event.placeKind
        break
      case 'fromRole':
        state.fromRole = event.from.role ?? 'member'
        break
      case 'fromName':
        if (event.from.name) {
          state.fromName = event.from.name
        }
        break
      case 'fromApp':
        state.fromApp = event.from.app === true
        break
      case 'mentioned':
        if (event.mentioned !== undefined) {
          state.mentioned = event.mentioned
        }
        break
      case 'trigger':
        if (event.trigger) {
          state.trigger = event.trigger.event
        }
        break
      case 'botName':
        if (bot.name) {
          state.botName = bot.name
        }
        break
      case 'truncated':
        if (event.truncated) {
          state.truncated = true
        }
        break
    }
  }
  return { ...state, ...config.extra }
}

export function slackGateJevRequest(
  jev: StoredSlackGateJev,
  bot: { name?: string },
  event: SlackGateEvent
): SlackGateJevRequest {
  const { config, legacy } = slackGateJevConfigOf(jev)
  return {
    model: config.model?.trim() || SLACK_GATE_DEFAULT_MODEL,
    state: legacy ? legacyState(event) : configuredState(config, bot, event),
    questions: config.questions
  }
}
