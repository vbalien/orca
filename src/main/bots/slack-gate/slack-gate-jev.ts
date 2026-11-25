// TypeSafe Jev as a Slack gate: the owner's questions about the Slack message, answered in one call
// (https://api.typesafe.ai/openapi.json, POST /v1/systemone). The message leaves Orca.
import type { SlackGateEvent } from '../../../shared/bots/bot-slack-gate'
import {
  isPlainObject,
  slackGateJevConfigOf,
  type SlackGateJevQuestion,
  type StoredSlackGateJev
} from '../../../shared/bots/slack-gate-jev-config'
import { slackGateJevRequest } from '../../../shared/bots/slack-gate-jev-request'
import { cancelUnreadResponseBody } from '../../lib/unread-response-body'

export const TYPESAFE_SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone'

/** One question's answer, reduced to what the rules read: a noul or score number, or a choice name. */
export type SlackGateJevAnswer =
  | { type: 'noul'; value: number }
  | { type: 'score'; value: number }
  | { type: 'choice'; value: string }

export type SlackGateJevOutcome =
  | { kind: 'answers'; answers: Record<string, SlackGateJevAnswer> }
  | { kind: 'error'; error: string }

const unit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

const probabilities = (value: unknown): boolean =>
  isPlainObject(value) && Object.values(value).every(unit)

const legendEntry = (value: unknown): boolean =>
  typeof value === 'string' || Array.isArray(value) || isPlainObject(value)

/** An answer of the question's type with every field TypeSafe requires; null for anything else. */
export function readSlackGateJevAnswer(
  question: SlackGateJevQuestion,
  answer: unknown
): SlackGateJevAnswer | null {
  if (!isPlainObject(answer) || answer.type !== question.type) {
    return null
  }
  switch (question.type) {
    case 'noul':
      return unit(answer.noul) ? { type: 'noul', value: answer.noul } : null
    case 'choice':
      return typeof answer.choice === 'string' &&
        Object.hasOwn(question.criteria, answer.choice) &&
        unit(answer.confidence) &&
        probabilities(answer.probabilities)
        ? { type: 'choice', value: answer.choice }
        : null
    case 'score': {
      const top = question.criteria.length - 1
      return typeof answer.score === 'number' &&
        Number.isFinite(answer.score) &&
        answer.score >= 0 &&
        answer.score <= top &&
        unit(answer.confidence) &&
        isPlainObject(answer.legend) &&
        Object.values(answer.legend).every(legendEntry) &&
        probabilities(answer.probabilities)
        ? { type: 'score', value: answer.score }
        : null
    }
  }
}

/** Every configured question's answer, or an error naming the first that is missing or malformed. */
export function readSlackGateJevAnswers(
  questions: Record<string, SlackGateJevQuestion>,
  body: unknown
): SlackGateJevOutcome {
  const answers = isPlainObject(body) && isPlainObject(body.answers) ? body.answers : null
  if (!answers) {
    return { kind: 'error', error: 'TypeSafe sent no answers' }
  }
  const read: Record<string, SlackGateJevAnswer> = {}
  for (const [name, question] of Object.entries(questions)) {
    const answer = readSlackGateJevAnswer(question, answers[name])
    if (!answer) {
      return { kind: 'error', error: `TypeSafe sent no usable answer for ${name}` }
    }
    read[name] = answer
  }
  return { kind: 'answers', answers: read }
}

export async function askSlackGateJev(input: {
  jev: StoredSlackGateJev
  bot: { name?: string }
  event: SlackGateEvent
  key: string | null
  signal: AbortSignal
  fetch?: typeof fetch
}): Promise<SlackGateJevOutcome> {
  if (!input.key) {
    return { kind: 'error', error: 'No TypeSafe API key is saved for this bot.' }
  }
  const request = slackGateJevRequest(input.jev, input.bot, input.event)
  const response = await (input.fetch ?? fetch)(TYPESAFE_SYSTEM_ONE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
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
  return readSlackGateJevAnswers(slackGateJevConfigOf(input.jev).config.questions, body)
}
