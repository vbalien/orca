// OpenAI Decisions as a Slack gate: the owner's questions about the Slack message, answered in one call
// (https://developers.openai.com/api/reference/resources/decisions/methods/create). The message leaves Orca.
import type { SlackGateEvent } from '../../../shared/bots/bot-slack-gate'
import {
  isPlainObject,
  slackGateEarlierLimit,
  type SlackGateChoiceValue,
  type SlackGateQuestion,
  type SlackGateRulesConfig
} from '../../../shared/bots/slack-gate-rules-config'
import { slackGateOpenAIRequest } from '../../../shared/bots/slack-gate-openai-request'
import { cancelUnreadResponseBody } from '../../lib/unread-response-body'

export const OPENAI_DECISIONS_URL = 'https://api.openai.com/v1/decisions'

/** One question's answer, reduced to what the rules read: a probability or score, or a choice's value. */
export type SlackGateAnswer =
  | { type: 'predicate'; value: number }
  | { type: 'score'; value: number }
  | { type: 'choice'; value: SlackGateChoiceValue }

export type SlackGateOpenAIOutcome =
  | { kind: 'answers'; answers: Record<string, SlackGateAnswer> }
  /** `refused`: the questions OpenAI declined, by name; their reasons are never kept. */
  | { kind: 'error'; error: string; refused?: string[] }

const unit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

const choiceValue = (value: unknown): value is SlackGateChoiceValue =>
  typeof value === 'string' || typeof value === 'boolean'

/** `probabilities` as OpenAI documents it: a list (maybe empty) of well-formed entries. */
function probabilities(value: unknown, entry: (item: Record<string, unknown>) => boolean): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => isPlainObject(item) && unit(item.probability) && entry(item))
  )
}

/** An answer of the question's type with every field OpenAI documents; null for anything else. */
export function readSlackGateAnswer(
  question: SlackGateQuestion,
  answer: Record<string, unknown>
): SlackGateAnswer | null {
  if (answer.type !== question.type) {
    return null
  }
  switch (question.type) {
    case 'predicate':
      return unit(answer.probability) ? { type: 'predicate', value: answer.probability } : null
    case 'choice': {
      const choice = answer.choice
      return choiceValue(choice) &&
        question.choices.some((entry) => entry.value === choice) &&
        unit(answer.confidence) &&
        probabilities(answer.probabilities, (item) => choiceValue(item.value))
        ? { type: 'choice', value: choice }
        : null
    }
    case 'score': {
      const top = question.levels.length - 1
      const level = (value: unknown) =>
        typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= top
      return typeof answer.score === 'number' &&
        Number.isFinite(answer.score) &&
        answer.score >= 0 &&
        answer.score <= top &&
        unit(answer.confidence) &&
        probabilities(
          answer.probabilities,
          (item) => typeof item.label === 'string' && level(item.value)
        )
        ? { type: 'score', value: answer.score }
        : null
    }
  }
}

/** Every question's answer, matched by order and name. Any refusal fails the check, naming every
 *  question refused; otherwise the first missing or malformed answer does. */
export function readSlackGateAnswers(
  questions: readonly SlackGateQuestion[],
  body: unknown
): SlackGateOpenAIOutcome {
  const answers = isPlainObject(body) && Array.isArray(body.answers) ? body.answers : null
  if (!answers) {
    return { kind: 'error', error: 'OpenAI sent no answers' }
  }
  const refused = questions.flatMap((question, index) => {
    const answer = answers[index]
    return isPlainObject(answer) && answer.type === 'refusal' && answer.name === question.name
      ? [question.name]
      : []
  })
  if (refused.length > 0) {
    return { kind: 'error', error: `OpenAI declined to answer ${refused.join(', ')}`, refused }
  }
  const read: Record<string, SlackGateAnswer> = {}
  for (const [index, question] of questions.entries()) {
    const answer = answers[index]
    const usable =
      isPlainObject(answer) && answer.name === question.name
        ? readSlackGateAnswer(question, answer)
        : null
    if (!usable) {
      return { kind: 'error', error: `OpenAI sent no usable answer for ${question.name}` }
    }
    read[question.name] = usable
  }
  return { kind: 'answers', answers: read }
}

export async function askSlackGateOpenAI(input: {
  config: SlackGateRulesConfig
  bot: { name?: string }
  event: SlackGateEvent
  key: string | null
  signal: AbortSignal
  fetch?: typeof fetch
}): Promise<SlackGateOpenAIOutcome> {
  if (!input.key) {
    return { kind: 'error', error: 'No OpenAI API key is saved for this bot.' }
  }
  // Without the thread it was told to read, a short reply can't be judged: a failed check, not a block.
  if (input.event.contextIncomplete === 'unreadable' && slackGateEarlierLimit(input.config) > 0) {
    return { kind: 'error', error: 'The Slack thread could not be read for the check' }
  }
  const request = slackGateOpenAIRequest(input.config, input.bot, input.event)
  if (!request) {
    return { kind: 'error', error: 'The Slack message is too large to send to OpenAI' }
  }
  const response = await (input.fetch ?? fetch)(OPENAI_DECISIONS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    // Never re-sent elsewhere: a redirect would carry the Slack text to another origin.
    redirect: 'error',
    signal: input.signal
  })
  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    return { kind: 'error', error: `OpenAI answered ${response.status}` }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    await cancelUnreadResponseBody(response)
    return { kind: 'error', error: 'OpenAI sent an unreadable answer' }
  }
  return readSlackGateAnswers(input.config.questions, body)
}
