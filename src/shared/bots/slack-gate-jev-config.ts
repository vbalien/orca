// The Jev wake gate's configuration, as the owner writes it in JSON: TypeSafe's own questions, which event
// facts go into TypeSafe's `state`, fixed extra state, and the rules that turn answers into wake or block.
// One validator serves the editor and the host; it reports codes, which the UI translates.

export const SLACK_GATE_JEV_SEND_KEYS = [
  'message',
  'laterMessages',
  'earlierMessages',
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
export type SlackGateJevSendKey = (typeof SLACK_GATE_JEV_SEND_KEYS)[number]

/** What a gate sends when its config names no `send`. */
export const SLACK_GATE_JEV_DEFAULT_SEND: readonly SlackGateJevSendKey[] = [
  'message',
  'laterMessages',
  'earlierMessages',
  'earlierOwn',
  'case',
  'place',
  'fromRole',
  'truncated'
]
// What older builds always send: turning any of these off or capping them is lost on a rollback.
const LEGACY_TEXT_KEYS: readonly SlackGateJevSendKey[] = [
  'message',
  'laterMessages',
  'earlierMessages',
  'earlierOwn'
]
export const SLACK_GATE_JEV_LIST_SEND_KEYS: readonly string[] = ['earlierMessages', 'laterMessages']
export const SLACK_GATE_JEV_LIST_LIMIT_MAX = 50

export type SlackGateJevQuestion =
  | { type: 'noul'; instructions?: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions?: string; criteria: Record<string, string> }
  | { type: 'score'; instructions?: string; criteria: string[] }

export type SlackGateJevCondition = { atLeast: number } | { atMost: number } | { oneOf: string[] }

export type SlackGateJevRule = {
  question: string
  wakeIf?: SlackGateJevCondition
  blockIf?: SlackGateJevCondition
  unsureFrom?: number
}

export type SlackGateJevConfig = {
  model?: string
  questions: Record<string, SlackGateJevQuestion>
  send?: Partial<Record<SlackGateJevSendKey, boolean | number>>
  extra?: Record<string, unknown>
  rules: SlackGateJevRule[]
  combine?: 'all' | 'any'
  whenUnsure?: 'wake' | 'block'
}

/** `slackGate.jev` as stored: a config with its compatibility mirror, or a legacy one-question gate. */
export type StoredSlackGateJev = Partial<SlackGateJevConfig> & {
  question?: string
  threshold?: number
}

export const SLACK_GATE_JEV_ISSUE_CODES = [
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
  'unknown_key',
  'required',
  'blank',
  'too_long',
  'not_finite',
  'out_of_range',
  'bad_name',
  'count',
  'question_type',
  'box_unsupported',
  'assets_unsupported',
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
  'enum',
  'legacy_mixed'
] as const
export type SlackGateJevIssueCode = (typeof SLACK_GATE_JEV_ISSUE_CODES)[number]
export type SlackGateJevPath = (string | number)[]
export type SlackGateJevIssue = {
  path: SlackGateJevPath
  code: SlackGateJevIssueCode
  params?: Record<string, string | number>
}

export const SLACK_GATE_JEV_MAX_BYTES = 16 * 1024
export const SLACK_GATE_JEV_MAX_DEPTH = 8
export const SLACK_GATE_JEV_MODEL_MAX = 100
/** The longest question builds before configurable rules accept. */
export const SLACK_GATE_LEGACY_QUESTION_MAX = 2000
const MIRROR_FALLBACK = { question: 'Should this bot wake for this message?', threshold: 0.5 }

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The config as kept: known keys in order, the model trimmed (blank → default). */
export function canonicalSlackGateJev(config: SlackGateJevConfig): SlackGateJevConfig {
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

export function slackGateJevBytes(config: SlackGateJevConfig): number {
  return new TextEncoder().encode(JSON.stringify(canonicalSlackGateJev(config))).length
}

/** The config a stored jev means. A legacy gate asks one noul question, `wake` at its threshold. */
export function slackGateJevConfigOf(jev: StoredSlackGateJev): {
  config: SlackGateJevConfig
  legacy: boolean
} {
  if (jev.questions && jev.rules) {
    return {
      config: canonicalSlackGateJev({ ...jev, questions: jev.questions, rules: jev.rules }),
      legacy: false
    }
  }
  const model = jev.model?.trim()
  return {
    config: {
      ...(model ? { model } : {}),
      questions: { wake: { type: 'noul', instructions: jev.question ?? '' } },
      rules: [{ question: 'wake', wakeIf: { atLeast: jev.threshold ?? 0.5 } }]
    },
    legacy: true
  }
}

/** What older Orca builds (which know only `question` and `threshold`) run instead of this config. */
export function slackGateJevLegacyMirror(config: SlackGateJevConfig): {
  question: string
  threshold: number
} {
  const rule = config.rules.find((entry) => entry.wakeIf)
  const question = rule ? config.questions[rule.question] : undefined
  const instructions = question?.type === 'noul' ? question.instructions : undefined
  if (
    rule?.wakeIf &&
    'atLeast' in rule.wakeIf &&
    typeof instructions === 'string' &&
    instructions.trim().length > 0 &&
    instructions.length <= SLACK_GATE_LEGACY_QUESTION_MAX
  ) {
    return { question: instructions, threshold: rule.wakeIf.atLeast }
  }
  return MIRROR_FALLBACK
}

/** The stored form of a config: canonical, with the mirror older builds read. */
export function storedSlackGateJev(config: SlackGateJevConfig): StoredSlackGateJev {
  return { ...canonicalSlackGateJev(config), ...slackGateJevLegacyMirror(config) }
}

/** Whether older builds would send more Slack text than this config allows (they ignore `send`). */
export function narrowsLegacyDisclosure(config: SlackGateJevConfig): boolean {
  const send = config.send
  if (!send) {
    return false
  }
  return LEGACY_TEXT_KEYS.some((key) => send[key] !== true)
}

/** The event facts a config sends, with any list limits. */
export function slackGateJevSends(
  config: SlackGateJevConfig
): Map<SlackGateJevSendKey, true | number> {
  const sends = new Map<SlackGateJevSendKey, true | number>()
  if (!config.send) {
    for (const key of SLACK_GATE_JEV_DEFAULT_SEND) {
      sends.set(key, true)
    }
    return sends
  }
  for (const key of SLACK_GATE_JEV_SEND_KEYS) {
    const value = config.send[key]
    if (value === true || typeof value === 'number') {
      sends.set(key, value)
    }
  }
  return sends
}
