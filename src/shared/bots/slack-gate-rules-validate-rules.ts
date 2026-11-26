// The gate config's rules: each names a question and one condition of its type, with an optional unsure band.
import {
  isOneLineText,
  isPlainObject,
  SLACK_GATE_LIMIT_MAX_COOLDOWN_MINUTES,
  SLACK_GATE_LIMIT_MAX_PER_DAY,
  SLACK_GATE_NOTE_MAX,
  type SlackGateQuestion,
  type SlackGateRulesPath
} from './slack-gate-rules-config'
import { finiteNumber, type Issues, onlyKeys } from './slack-gate-rules-issues'

/** The highest answer a number question gives: a probability, or the top level's index. */
function topOf(question: Exclude<SlackGateQuestion, { type: 'choice' }>): number {
  return question.type === 'predicate' ? 1 : Math.max(0, question.levels.length - 1)
}

function validateCondition(
  issues: Issues,
  condition: unknown,
  path: SlackGateRulesPath,
  question: SlackGateQuestion | null
): void {
  if (!isPlainObject(condition)) {
    issues.add(path, 'not_object')
    return
  }
  const keys = Object.keys(condition)
  const kind = keys.length === 1 ? keys[0] : undefined
  if (kind !== 'atLeast' && kind !== 'atMost' && kind !== 'oneOf') {
    issues.add(path, 'condition_kind')
    return
  }
  if (!question) {
    return
  }
  if (kind === 'oneOf') {
    if (question.type !== 'choice') {
      issues.add([...path, kind], 'condition_kind')
      return
    }
    const choices = condition.oneOf
    if (!Array.isArray(choices) || choices.length === 0) {
      issues.add([...path, kind], Array.isArray(choices) ? 'count' : 'not_array', { min: 1 })
      return
    }
    const seen = new Set<string>()
    choices.forEach((choice, index) => {
      const at = [...path, kind, index]
      if (typeof choice !== 'string' && typeof choice !== 'boolean') {
        issues.add(at, 'not_choice_value')
        return
      }
      // A string and a boolean of the same text are different choices.
      const id = `${typeof choice}:${String(choice)}`
      if (!question.choices.some((entry) => entry.value === choice)) {
        issues.add(at, 'unknown_choice', { choice: String(choice) })
      } else if (seen.has(id)) {
        issues.add(at, 'duplicate_choice', { choice: String(choice) })
      }
      seen.add(id)
    })
    return
  }
  if (question.type === 'choice') {
    issues.add([...path, kind], 'condition_for_choice')
    return
  }
  const limit = condition[kind]
  if (finiteNumber(issues, limit, [...path, kind])) {
    const max = topOf(question)
    if (limit < 0 || limit > max) {
      issues.add([...path, kind], 'out_of_range', { min: 0, max })
    }
  }
}

export function validateRule(
  issues: Issues,
  rule: unknown,
  index: number,
  questions: Map<string, SlackGateQuestion | null>
): string | null {
  const path = ['rules', index]
  if (!isPlainObject(rule)) {
    issues.add(path, 'not_object')
    return null
  }
  onlyKeys(issues, rule, path, ['question', 'wakeIf', 'blockIf', 'unsureFrom', 'note', 'limit'])
  const name = rule.question
  if (typeof name !== 'string') {
    issues.add([...path, 'question'], name === undefined ? 'required' : 'not_string')
  } else if (!questions.has(name)) {
    issues.add([...path, 'question'], 'unknown_question', { question: name })
  }
  const question = typeof name === 'string' ? (questions.get(name) ?? null) : null
  const effects = (['wakeIf', 'blockIf'] as const).filter((key) => rule[key] !== undefined)
  if (effects.length !== 1) {
    issues.add(path, 'one_effect')
  }
  const effect = effects[0]
  const condition = effect ? rule[effect] : undefined
  if (effect) {
    validateCondition(issues, condition, [...path, effect], question)
  }
  if (
    rule.unsureFrom !== undefined &&
    finiteNumber(issues, rule.unsureFrom, [...path, 'unsureFrom'])
  ) {
    if (!isPlainObject(condition) || 'oneOf' in condition) {
      issues.add([...path, 'unsureFrom'], 'unsure_choice')
    } else if (question && question.type !== 'choice') {
      const max = topOf(question)
      const from = rule.unsureFrom
      const below = typeof condition.atLeast === 'number' && from < condition.atLeast
      const above = typeof condition.atMost === 'number' && from > condition.atMost
      if (from < 0 || from > max) {
        issues.add([...path, 'unsureFrom'], 'out_of_range', { min: 0, max })
      } else if (!below && !above) {
        issues.add([...path, 'unsureFrom'], 'unsure_side')
      }
    }
  }
  if (rule.note !== undefined && !isOneLineText(rule.note, SLACK_GATE_NOTE_MAX)) {
    issues.add([...path, 'note'], typeof rule.note === 'string' ? 'too_long' : 'not_string', {
      max: SLACK_GATE_NOTE_MAX
    })
  }
  if (rule.limit !== undefined) {
    validateLimit(issues, rule.limit, [...path, 'limit'])
    if (effect === 'blockIf') {
      issues.add([...path, 'limit'], 'limit_on_block')
    }
  }
  return typeof name === 'string' ? name : null
}

function validateLimit(issues: Issues, limit: unknown, path: SlackGateRulesPath): void {
  if (!isPlainObject(limit)) {
    issues.add(path, 'not_object')
    return
  }
  onlyKeys(issues, limit, path, ['perDay', 'cooldownMinutes', 'chance'])
  if (Object.keys(limit).length === 0) {
    issues.add(path, 'required')
  }
  for (const [key, max] of [
    ['perDay', SLACK_GATE_LIMIT_MAX_PER_DAY],
    ['cooldownMinutes', SLACK_GATE_LIMIT_MAX_COOLDOWN_MINUTES]
  ] as const) {
    const value = limit[key]
    if (value !== undefined && finiteNumber(issues, value, [...path, key])) {
      if (!Number.isInteger(value) || value < 1 || value > max) {
        issues.add([...path, key], 'out_of_range', { min: 1, max })
      }
    }
  }
  const chance = limit.chance
  if (chance !== undefined && finiteNumber(issues, chance, [...path, 'chance'])) {
    if (chance <= 0 || chance > 1) {
      issues.add([...path, 'chance'], 'out_of_range', { min: 0, max: 1 })
    }
  }
}
