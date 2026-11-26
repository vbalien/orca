// A gate config's rules over its answers: each rule passes, fails or is unsure; unsure leans the way
// `whenUnsure` says; any block rule that passes blocks; otherwise the wake rules combine all/any.
import type {
  SlackGateChoiceValue,
  SlackGateCondition,
  SlackGateRule,
  SlackGateRulesConfig
} from '../../../shared/bots/slack-gate-rules-config'
import type { SlackGateAnswer } from './slack-gate-openai'

export type SlackGateRuleResult = 'pass' | 'fail' | 'unsure'

export type SlackGateRulesVerdict = {
  wake: boolean
  /** Each question's answer: a probability or score, or a choice's value (never message text). */
  answers: Record<string, number | SlackGateChoiceValue>
  /** Each rule's result, by its index. */
  rules: SlackGateRuleResult[]
  /** The first rule's question's number, when it has one. */
  score?: number
}

function conditionResult(
  condition: SlackGateCondition,
  unsureFrom: number | undefined,
  answer: SlackGateAnswer
): SlackGateRuleResult {
  if ('oneOf' in condition) {
    return answer.type === 'choice' && condition.oneOf.includes(answer.value) ? 'pass' : 'fail'
  }
  if (answer.type === 'choice') {
    return 'fail'
  }
  const value = answer.value
  if ('atLeast' in condition) {
    if (value >= condition.atLeast) {
      return 'pass'
    }
    return unsureFrom !== undefined && value >= unsureFrom ? 'unsure' : 'fail'
  }
  if (value <= condition.atMost) {
    return 'pass'
  }
  return unsureFrom !== undefined && value <= unsureFrom ? 'unsure' : 'fail'
}

function ruleResult(
  rule: SlackGateRule,
  answers: Record<string, SlackGateAnswer>
): SlackGateRuleResult {
  const condition = rule.wakeIf ?? rule.blockIf
  const answer = answers[rule.question]
  return condition && answer ? conditionResult(condition, rule.unsureFrom, answer) : 'fail'
}

export function decideSlackGateRules(
  config: SlackGateRulesConfig,
  answers: Record<string, SlackGateAnswer>
): SlackGateRulesVerdict {
  const results = config.rules.map((rule) => ruleResult(rule, answers))
  const unsureWakes = config.whenUnsure === 'wake'
  const counts = (result: SlackGateRuleResult, lean: boolean) =>
    result === 'pass' || (result === 'unsure' && lean)
  const blocked = config.rules.some(
    (rule, index) => rule.blockIf && counts(results[index]!, !unsureWakes)
  )
  const wakeResults = config.rules.flatMap((rule, index) =>
    rule.wakeIf ? [counts(results[index]!, unsureWakes)] : []
  )
  const woken =
    wakeResults.length === 0 ||
    (config.combine === 'any' ? wakeResults.some(Boolean) : wakeResults.every(Boolean))
  const first = config.rules[0] ? answers[config.rules[0].question] : undefined
  return {
    wake: !blocked && woken,
    answers: Object.fromEntries(
      Object.entries(answers).map(([name, answer]) => [name, answer.value])
    ),
    rules: results,
    ...(first && typeof first.value === 'number' ? { score: first.value } : {})
  }
}
