// The OpenAI Decisions wake gate's configuration, as the owner writes it in JSON: OpenAI's own questions,
// which event facts go into the request's input, fixed extra values, and the rules that turn answers into
// wake or block. One validator serves the editor and the host; it reports codes, which the UI translates.

export const SLACK_GATE_SEND_KEYS = [
  'message',
  'laterMessages',
  'earlierMessages',
  'earlierSpeakers',
  'earlierOwn',
  'case',
  'place',
  'fromRole',
  'fromName',
  'fromApp',
  'mentioned',
  'trigger',
  'botName',
  'truncated'
] as const
export type SlackGateSendKey = (typeof SLACK_GATE_SEND_KEYS)[number]

/** What a gate sends when its config names no `send`. */
export const SLACK_GATE_DEFAULT_SEND: readonly SlackGateSendKey[] = [
  'message',
  'laterMessages',
  'earlierMessages',
  'earlierOwn',
  'case',
  'place',
  'fromRole',
  'truncated'
]
export const SLACK_GATE_LIST_SEND_KEYS: readonly string[] = ['earlierMessages', 'laterMessages']
export const SLACK_GATE_LIST_LIMIT_MAX = 50

export type SlackGateChoiceValue = string | boolean

export type SlackGateQuestion =
  | { type: 'predicate'; name: string; instructions: string }
  | {
      type: 'choice'
      name: string
      instructions: string
      choices: { value: SlackGateChoiceValue; description?: string }[]
    }
  | {
      type: 'score'
      name: string
      instructions: string
      levels: { label: string; description?: string }[]
    }

export type SlackGateCondition =
  | { atLeast: number }
  | { atMost: number }
  | { oneOf: SlackGateChoiceValue[] }

export type SlackGateRule = {
  question: string
  wakeIf?: SlackGateCondition
  blockIf?: SlackGateCondition
  unsureFrom?: number
}

export type SlackGateRulesConfig = {
  model?: string
  questions: SlackGateQuestion[]
  send?: Partial<Record<SlackGateSendKey, boolean | number>>
  extra?: Record<string, unknown>
  rules: SlackGateRule[]
  combine?: 'all' | 'any'
  whenUnsure?: 'wake' | 'block'
}

export const SLACK_GATE_RULES_ISSUE_CODES = [
  'syntax',
  'duplicate_key',
  'too_deep',
  'text_too_large',
  'too_large',
  'not_object',
  'not_string',
  'not_number',
  'not_array',
  'not_boolean_or_number',
  'not_choice_value',
  'unknown_key',
  'required',
  'blank',
  'too_long',
  'not_finite',
  'out_of_range',
  'bad_name',
  'duplicate_question',
  'count',
  'question_type',
  'extra_collision',
  'unknown_question',
  'one_effect',
  'condition_kind',
  'condition_for_choice',
  'unknown_choice',
  'duplicate_choice',
  'unsure_side',
  'unsure_choice',
  'unused_question',
  'enum'
] as const
export type SlackGateRulesIssueCode = (typeof SLACK_GATE_RULES_ISSUE_CODES)[number]
export type SlackGateRulesPath = (string | number)[]
export type SlackGateRulesIssue = {
  path: SlackGateRulesPath
  code: SlackGateRulesIssueCode
  params?: Record<string, string | number>
}

export const SLACK_GATE_RULES_MAX_BYTES = 16 * 1024
export const SLACK_GATE_RULES_MAX_DEPTH = 8
export const SLACK_GATE_MODEL_MAX = 100

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The config as kept: known keys in order, the model trimmed (blank → default). */
export function canonicalSlackGateRules(config: SlackGateRulesConfig): SlackGateRulesConfig {
  const model = config.model?.trim()
  return {
    ...(model ? { model } : {}),
    questions: config.questions,
    ...(config.send ? { send: config.send } : {}),
    ...(config.extra ? { extra: config.extra } : {}),
    rules: config.rules,
    ...(config.combine ? { combine: config.combine } : {}),
    ...(config.whenUnsure ? { whenUnsure: config.whenUnsure } : {})
  }
}

export function slackGateRulesBytes(config: SlackGateRulesConfig): number {
  return new TextEncoder().encode(JSON.stringify(canonicalSlackGateRules(config))).length
}

/** How many earlier messages a config sends: 0 when none (left out or a limit of 0), Infinity for all. */
export function slackGateEarlierLimit(config: SlackGateRulesConfig): number {
  const limit = slackGateRulesSends(config).get('earlierMessages')
  return limit === undefined ? 0 : limit === true ? Number.POSITIVE_INFINITY : limit
}

/** The event facts a config sends, with any list limits. */
export function slackGateRulesSends(
  config: SlackGateRulesConfig
): Map<SlackGateSendKey, true | number> {
  const sends = new Map<SlackGateSendKey, true | number>()
  if (!config.send) {
    for (const key of SLACK_GATE_DEFAULT_SEND) {
      sends.set(key, true)
    }
    return sends
  }
  for (const key of SLACK_GATE_SEND_KEYS) {
    const value = config.send[key]
    if (value === true || typeof value === 'number') {
      sends.set(key, value)
    }
  }
  return sends
}
