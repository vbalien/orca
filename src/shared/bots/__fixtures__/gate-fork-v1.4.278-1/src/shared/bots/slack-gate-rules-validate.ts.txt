// One validator for the gate rules config, used by the editor and by the host's schema. It reports codes
// with paths, never English sentences, so the editor can translate and place them.
import {
  canonicalSlackGateRules,
  isPlainObject,
  slackGateRulesBytes,
  SLACK_GATE_LIST_LIMIT_MAX,
  SLACK_GATE_LIST_SEND_KEYS,
  SLACK_GATE_MODEL_MAX,
  SLACK_GATE_RULES_MAX_BYTES,
  SLACK_GATE_RULES_MAX_DEPTH,
  SLACK_GATE_SEND_KEYS,
  type SlackGateQuestion,
  type SlackGateRulesConfig,
  type SlackGateRulesIssue,
  type SlackGateRulesPath
} from './slack-gate-rules-config'
import { Issues, onlyKeys, optionalString, requiredText } from './slack-gate-rules-issues'
import { validateRule } from './slack-gate-rules-validate-rules'

export type SlackGateRulesValidation =
  | { ok: true; config: SlackGateRulesConfig }
  | { ok: false; issues: SlackGateRulesIssue[] }

const QUESTION_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/
const MAX_QUESTIONS = 10
const MAX_RULES = 20
const TOP_KEYS = new Set(['model', 'questions', 'send', 'extra', 'rules', 'combine', 'whenUnsure'])
const LIST_SEND_KEYS = new Set(SLACK_GATE_LIST_SEND_KEYS)

/** OpenAI's `choices` (2–255 distinct values, a string and a boolean of the same text being distinct)
 *  or `levels` (2–10 labels, lowest first), each with an optional description. */
function validateOptions(
  issues: Issues,
  list: unknown,
  path: SlackGateRulesPath,
  kind: 'choices' | 'levels'
): void {
  if (list === undefined) {
    issues.add(path, 'required')
    return
  }
  if (!Array.isArray(list)) {
    issues.add(path, 'not_array')
    return
  }
  const [min, max] = kind === 'choices' ? [2, 255] : [2, 10]
  if (list.length < min || list.length > max) {
    issues.add(path, 'count', { min, max })
  }
  const seen = new Set<string>()
  list.forEach((entry, index) => {
    const at = [...path, index]
    if (!isPlainObject(entry)) {
      issues.add(at, 'not_object')
      return
    }
    const key = kind === 'choices' ? 'value' : 'label'
    onlyKeys(issues, entry, at, [key, 'description'])
    optionalString(issues, entry.description, [...at, 'description'])
    if (kind === 'levels') {
      requiredText(issues, entry.label, [...at, 'label'])
      return
    }
    const value = entry.value
    if (value === undefined) {
      issues.add([...at, 'value'], 'required')
    } else if (typeof value !== 'string' && typeof value !== 'boolean') {
      issues.add([...at, 'value'], 'not_choice_value')
    } else {
      const id = `${typeof value}:${String(value)}`
      if (seen.has(id)) {
        issues.add([...at, 'value'], 'duplicate_choice', { choice: String(value) })
      }
      seen.add(id)
    }
  })
}

function validateQuestion(
  issues: Issues,
  value: unknown,
  index: number,
  names: Set<string>
): { name: string | null; question: SlackGateQuestion | null } {
  const path = ['questions', index]
  if (!isPlainObject(value)) {
    issues.add(path, 'not_object')
    return { name: null, question: null }
  }
  const before = issues.count
  const name = typeof value.name === 'string' ? value.name : null
  if (value.name === undefined) {
    issues.add([...path, 'name'], 'required')
  } else if (name === null) {
    issues.add([...path, 'name'], 'not_string')
  } else if (!QUESTION_NAME.test(name)) {
    issues.add([...path, 'name'], 'bad_name')
  } else if (names.has(name)) {
    issues.add([...path, 'name'], 'duplicate_question', { question: name })
  }
  if (name !== null) {
    names.add(name)
  }
  const type = value.type
  if (type !== 'predicate' && type !== 'choice' && type !== 'score') {
    issues.add([...path, 'type'], 'question_type')
    return { name, question: null }
  }
  const options = type === 'choice' ? 'choices' : type === 'score' ? 'levels' : null
  onlyKeys(issues, value, path, ['type', 'name', 'instructions', ...(options ? [options] : [])])
  requiredText(issues, value.instructions, [...path, 'instructions'])
  if (options) {
    validateOptions(issues, value[options], [...path, options], options)
  }
  if (issues.count > before) {
    return { name, question: null }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every field was checked above.
  return { name, question: value as SlackGateQuestion }
}

/** Depth and finiteness of free-form `extra` values, iteratively. */
function validateExtraValue(issues: Issues, root: unknown, rootPath: SlackGateRulesPath): void {
  const stack: { value: unknown; path: SlackGateRulesPath; depth: number }[] = [
    { value: root, path: rootPath, depth: 1 }
  ]
  while (stack.length > 0) {
    const { value, path, depth } = stack.pop()!
    if (typeof value === 'number' && !Number.isFinite(value)) {
      issues.add(path, 'not_finite')
    }
    if (typeof value !== 'object' || value === null) {
      continue
    }
    if (depth > SLACK_GATE_RULES_MAX_DEPTH) {
      issues.add(path, 'too_deep', { max: SLACK_GATE_RULES_MAX_DEPTH })
      continue
    }
    const entries: [string | number, unknown][] = Array.isArray(value)
      ? value.map((entry, index) => [index, entry])
      : Object.entries(value)
    for (const [key, child] of entries) {
      stack.push({ value: child, path: [...path, key], depth: depth + 1 })
    }
  }
}

function validateSend(issues: Issues, send: unknown): void {
  if (send === undefined) {
    return
  }
  if (!isPlainObject(send)) {
    issues.add(['send'], 'not_object')
    return
  }
  onlyKeys(issues, send, ['send'], SLACK_GATE_SEND_KEYS)
  for (const [key, value] of Object.entries(send)) {
    const path = ['send', key]
    if (typeof value === 'boolean') {
      continue
    }
    if (LIST_SEND_KEYS.has(key) && typeof value === 'number') {
      if (!Number.isInteger(value) || value < 0 || value > SLACK_GATE_LIST_LIMIT_MAX) {
        issues.add(path, 'out_of_range', { min: 0, max: SLACK_GATE_LIST_LIMIT_MAX })
      }
      continue
    }
    issues.add(path, 'not_boolean_or_number')
  }
}

export function validateSlackGateRules(value: unknown): SlackGateRulesValidation {
  const issues = new Issues()
  if (!isPlainObject(value)) {
    issues.add([], 'not_object')
    return { ok: false, issues: issues.list }
  }
  for (const key of Object.keys(value)) {
    if (!TOP_KEYS.has(key)) {
      issues.add([key], 'unknown_key')
    }
  }
  if (value.model !== undefined) {
    if (typeof value.model !== 'string') {
      issues.add(['model'], 'not_string')
    } else if (value.model.trim().length > SLACK_GATE_MODEL_MAX) {
      issues.add(['model'], 'too_long', { max: SLACK_GATE_MODEL_MAX })
    }
  }
  const questions = new Map<string, SlackGateQuestion | null>()
  if (value.questions === undefined) {
    issues.add(['questions'], 'required')
  } else if (!Array.isArray(value.questions)) {
    issues.add(['questions'], 'not_array')
  } else {
    if (value.questions.length < 1 || value.questions.length > MAX_QUESTIONS) {
      issues.add(['questions'], 'count', { min: 1, max: MAX_QUESTIONS })
    }
    const names = new Set<string>()
    value.questions.slice(0, MAX_QUESTIONS).forEach((entry, index) => {
      const { name, question } = validateQuestion(issues, entry, index, names)
      if (name !== null && !questions.has(name)) {
        questions.set(name, question)
      }
    })
  }
  validateSend(issues, value.send)
  if (value.extra !== undefined) {
    if (!isPlainObject(value.extra)) {
      issues.add(['extra'], 'not_object')
    } else {
      validateExtraValue(issues, value.extra, ['extra'])
      for (const key of Object.keys(value.extra)) {
        if (SLACK_GATE_SEND_KEYS.some((sendKey) => sendKey === key)) {
          issues.add(['extra', key], 'extra_collision')
        }
      }
    }
  }
  const used = new Set<string>()
  if (value.rules === undefined) {
    issues.add(['rules'], 'required')
  } else if (!Array.isArray(value.rules)) {
    issues.add(['rules'], 'not_array')
  } else {
    if (value.rules.length < 1 || value.rules.length > MAX_RULES) {
      issues.add(['rules'], 'count', { min: 1, max: MAX_RULES })
    }
    value.rules.slice(0, MAX_RULES).forEach((rule, index) => {
      const name = validateRule(issues, rule, index, questions)
      if (name) {
        used.add(name)
      }
    })
    if (Array.isArray(value.questions)) {
      value.questions.slice(0, MAX_QUESTIONS).forEach((entry, index) => {
        const name = isPlainObject(entry) ? entry.name : undefined
        if (typeof name === 'string' && questions.has(name) && !used.has(name)) {
          used.add(name)
          issues.add(['questions', index], 'unused_question', { question: name })
        }
      })
    }
  }
  for (const [key, allowed] of [
    ['combine', ['all', 'any']],
    ['whenUnsure', ['wake', 'block']]
  ] as const) {
    const given = value[key]
    if (given !== undefined && !allowed.some((entry) => entry === given)) {
      issues.add([key], 'enum', { allowed: allowed.join(', ') })
    }
  }
  if (issues.count > 0) {
    return { ok: false, issues: issues.list }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: validated above field by field.
  const config = canonicalSlackGateRules(value as SlackGateRulesConfig)
  const bytes = slackGateRulesBytes(config)
  if (bytes > SLACK_GATE_RULES_MAX_BYTES) {
    return {
      ok: false,
      issues: [{ path: [], code: 'too_large', params: { max: SLACK_GATE_RULES_MAX_BYTES, bytes } }]
    }
  }
  return { ok: true, config }
}
