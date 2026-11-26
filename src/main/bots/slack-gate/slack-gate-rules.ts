// A gate config's rules over its answers: each rule passes, fails or is unsure; unsure leans the way
// `whenUnsure` says (never toward waking for a channel message); any block rule that passes blocks;
// otherwise the wake rules combine all/any. A wake rule whose limit is used up is `limited` and doesn't
// count. The rule the wake rests on is its reason: an unlimited one first, so a limited one is used only
// when it alone wakes.
import type { SlackGateCase } from '../../../shared/bots/bot-slack-gate'
import type {
  SlackGateChoiceValue,
  SlackGateCondition,
  SlackGateRule,
  SlackGateRulesConfig
} from '../../../shared/bots/slack-gate-rules-config'
import type { SlackGateAnswer } from './slack-gate-openai'

export type SlackGateRuleResult = 'pass' | 'fail' | 'unsure' | 'limited'

export type SlackGateRulesOptions = {
  case?: SlackGateCase
  /** Whether a limited rule may wake now (limit and chance); absent, limits are ignored. */
  limitOpen?: (index: number, rule: SlackGateRule) => boolean
}

export type SlackGateRulesVerdict = {
  wake: boolean
  /** Each question's answer: a probability or score, or a choice's value (never message text). */
  answers: Record<string, number | SlackGateChoiceValue>
  /** Each rule's result, by its index. */
  rules: SlackGateRuleResult[]
  /** The first rule's question's number, when it has one. */
  score?: number
  /** The wake rule the wake rests on, by index. */
  reasonRule?: number
  /** It would have woken but for a used-up limit. */
  rateLimited?: true
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

/** Whether every wake rule has a limit and none may wake now: then asking OpenAI can't wake the bot. */
export function slackGateRulesAllLimited(
  config: SlackGateRulesConfig,
  limitOpen: (index: number, rule: SlackGateRule) => boolean
): boolean {
  const wakes = config.rules.flatMap((rule, index) => (rule.wakeIf ? [{ rule, index }] : []))
  return (
    wakes.length > 0 &&
    wakes.every(({ rule, index }) => rule.limit !== undefined && !limitOpen(index, rule))
  )
}

export function decideSlackGateRules(
  config: SlackGateRulesConfig,
  answers: Record<string, SlackGateAnswer>,
  options: SlackGateRulesOptions = {}
): SlackGateRulesVerdict {
  const results = config.rules.map((rule) => ruleResult(rule, answers))
  // A channel message no one addressed to the bot never wakes it on an unsure answer.
  const unsureWakes = config.whenUnsure === 'wake' && options.case !== 'channel_message'
  const counts = (result: SlackGateRuleResult, lean: boolean) =>
    result === 'pass' || (result === 'unsure' && lean)
  const blocked = config.rules.some(
    (rule, index) => rule.blockIf && counts(results[index]!, !unsureWakes)
  )
  const wakeIndexes = config.rules.flatMap((rule, index) => (rule.wakeIf ? [index] : []))
  const passing = new Set(wakeIndexes.filter((index) => counts(results[index]!, unsureWakes)))
  const combined = (counted: Set<number>) =>
    wakeIndexes.length === 0 ||
    (config.combine === 'any'
      ? wakeIndexes.some((index) => counted.has(index))
      : wakeIndexes.every((index) => counted.has(index)))
  const open = new Set(
    [...passing].filter((index) => {
      const rule = config.rules[index]!
      if (rule.limit === undefined || !options.limitOpen || options.limitOpen(index, rule)) {
        return true
      }
      results[index] = 'limited'
      return false
    })
  )
  const woken = !blocked && combined(open)
  const ordered = [...open].sort((a, b) => a - b)
  const reasonRule = ordered.find((index) => config.rules[index]!.limit === undefined) ?? ordered[0]
  const first = config.rules[0] ? answers[config.rules[0].question] : undefined
  return {
    wake: woken,
    answers: Object.fromEntries(
      Object.entries(answers).map(([name, answer]) => [name, answer.value])
    ),
    rules: results,
    ...(first && typeof first.value === 'number' ? { score: first.value } : {}),
    ...(woken && reasonRule !== undefined ? { reasonRule } : {}),
    ...(!woken && !blocked && open.size < passing.size && combined(passing)
      ? { rateLimited: true as const }
      : {})
  }
}
