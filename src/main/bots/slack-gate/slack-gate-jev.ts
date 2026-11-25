// TypeSafe Jev as a Slack gate: one noul question about the Slack message, answered as a
// probability (https://api.typesafe.ai/openapi.json, POST /v1/systemone). The message leaves Orca.
import {
  SLACK_GATE_DEFAULT_MODEL,
  type BotSlackGate,
  type SlackGateEvent
} from '../../../shared/bots/bot-slack-gate'
import { cancelUnreadResponseBody } from '../../lib/unread-response-body'

export const TYPESAFE_SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone'

export type SlackGateJevOutcome = { kind: 'score'; noul: number } | { kind: 'error'; error: string }

type Jev = Extract<BotSlackGate, { kind: 'jev' }>['jev']

/** What Jev reads: the message, its place and its context, never Slack or Orca ids. */
export function slackGateJevRequest(jev: Jev, event: SlackGateEvent): unknown {
  return {
    model: jev.model?.trim() || SLACK_GATE_DEFAULT_MODEL,
    state: {
      case: event.case,
      place: event.placeKind,
      fromRole: event.from.role ?? 'member',
      message: event.text,
      ...(event.later?.length ? { laterMessages: event.later.map((entry) => entry.text) } : {}),
      ...(event.earlierOwn ? { earlierOwn: event.earlierOwn } : {}),
      ...(event.context?.length
        ? { earlierMessages: event.context.map((entry) => entry.text) }
        : {}),
      ...(event.truncated ? { truncated: true } : {})
    },
    questions: { wake: { type: 'noul', instructions: jev.question } }
  }
}

function noulOf(body: unknown): number | null {
  if (typeof body !== 'object' || body === null || !('answers' in body)) {
    return null
  }
  const answers = body.answers
  if (typeof answers !== 'object' || answers === null || !('wake' in answers)) {
    return null
  }
  const wake = answers.wake
  if (typeof wake !== 'object' || wake === null || !('type' in wake) || !('noul' in wake)) {
    return null
  }
  const { type, noul } = wake
  return type === 'noul' &&
    typeof noul === 'number' &&
    Number.isFinite(noul) &&
    noul >= 0 &&
    noul <= 1
    ? noul
    : null
}

export async function askSlackGateJev(input: {
  jev: Jev
  event: SlackGateEvent
  key: string | null
  signal: AbortSignal
  fetch?: typeof fetch
}): Promise<SlackGateJevOutcome> {
  if (!input.key) {
    return { kind: 'error', error: 'No TypeSafe API key is saved for this bot.' }
  }
  const response = await (input.fetch ?? fetch)(TYPESAFE_SYSTEM_ONE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(slackGateJevRequest(input.jev, input.event)),
    signal: input.signal
  })
  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    return { kind: 'error', error: `TypeSafe answered ${response.status}` }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    await cancelUnreadResponseBody(response)
    return { kind: 'error', error: 'TypeSafe sent an unreadable answer' }
  }
  const noul = noulOf(body)
  return noul === null
    ? { kind: 'error', error: 'TypeSafe sent no usable noul answer' }
    : { kind: 'score', noul }
}
