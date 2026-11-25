// The Jev config's rules: each names a question and one condition of its type, with an optional unsure band.
import {
  isPlainObject,
  type SlackGateJevPath,
  type SlackGateJevQuestion
} from './slack-gate-jev-config'
import { finiteNumber, type Issues, onlyKeys } from './slack-gate-jev-issues'

function validateCondition(
  issues: Issues,
  condition: unknown,
  path: SlackGateJevPath,
  question: SlackGateJevQuestion | null
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
      if (typeof choice !== 'string') {
        issues.add([...path, kind, index], 'not_string')
      } else if (!Object.hasOwn(question.criteria, choice)) {
        issues.add([...path, kind, index], 'unknown_choice', { choice })
      } else if (seen.has(choice)) {
        issues.add([...path, kind, index], 'duplicate_choice', { choice })
      }
      if (typeof choice === 'string') {
        seen.add(choice)
      }
    })
    return
  }
  if (question.type === 'choice') {
    issues.add([...path, kind], 'condition_for_choice')
    return
  }
  const limit = condition[kind]
  if (finiteNumber(issues, limit, [...path, kind])) {
    const max = question.type === 'noul' ? 1 : Math.max(0, question.criteria.length - 1)
    if (limit < 0 || limit > max) {
      issues.add([...path, kind], 'out_of_range', { min: 0, max })
    }
  }
}

export function validateRule(
  issues: Issues,
  rule: unknown,
  index: number,
  questions: Map<string, SlackGateJevQuestion | null>
): string | null {
  const path = ['rules', index]
  if (!isPlainObject(rule)) {
    issues.add(path, 'not_object')
    return null
  }
  onlyKeys(issues, rule, path, ['question', 'wakeIf', 'blockIf', 'unsureFrom'])
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
      const max = question.type === 'noul' ? 1 : Math.max(0, question.criteria.length - 1)
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
  return typeof name === 'string' ? name : null
}

/** Checks an editable config (the mirror fields, when present, are ignored here). */
