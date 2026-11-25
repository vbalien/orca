// One validator for the Jev gate config, used by the editor and by the host's schema. It reports codes
// with paths, never English sentences, so the editor can translate and place them.
import {
  canonicalSlackGateJev,
  isPlainObject,
  slackGateJevBytes,
  SLACK_GATE_JEV_LIST_LIMIT_MAX,
  SLACK_GATE_JEV_LIST_SEND_KEYS,
  SLACK_GATE_JEV_MAX_BYTES,
  SLACK_GATE_JEV_MAX_DEPTH,
  SLACK_GATE_JEV_MODEL_MAX,
  SLACK_GATE_JEV_SEND_KEYS,
  SLACK_GATE_LEGACY_QUESTION_MAX,
  type SlackGateJevConfig,
  type SlackGateJevIssue,
  type SlackGateJevPath,
  type SlackGateJevQuestion
} from './slack-gate-jev-config'
import { finiteNumber, Issues, onlyKeys, optionalString } from './slack-gate-jev-issues'
import { validateRule } from './slack-gate-jev-validate-rules'

export type SlackGateJevValidation =
  | { ok: true; config: SlackGateJevConfig }
  | { ok: false; issues: SlackGateJevIssue[] }

const QUESTION_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/
const MAX_QUESTIONS = 10
const MAX_RULES = 20
const TOP_KEYS = new Set(['model', 'questions', 'send', 'extra', 'rules', 'combine', 'whenUnsure'])
const LIST_SEND_KEYS = new Set(SLACK_GATE_JEV_LIST_SEND_KEYS)

function validateQuestion(
  issues: Issues,
  name: string,
  value: unknown
): SlackGateJevQuestion | null {
  const path = ['questions', name]
  if (!QUESTION_NAME.test(name)) {
    issues.add(path, 'bad_name')
  }
  if (!isPlainObject(value)) {
    issues.add(path, 'not_object')
    return null
  }
  const type = value.type
  if (type === 'box') {
    issues.add([...path, 'type'], 'box_unsupported')
    return null
  }
  if (type !== 'noul' && type !== 'choice' && type !== 'score') {
    issues.add([...path, 'type'], 'question_type')
    return null
  }
  const before = issues.list.length
  onlyKeys(issues, value, path, ['type', 'instructions', 'criteria'])
  optionalString(issues, value.instructions, [...path, 'instructions'])
  const criteria = value.criteria
  const criteriaPath = [...path, 'criteria']
  if (type === 'noul') {
    if (criteria !== undefined) {
      if (!isPlainObject(criteria)) {
        issues.add(criteriaPath, 'not_object')
      } else {
        onlyKeys(issues, criteria, criteriaPath, ['true', 'false'])
        optionalString(issues, criteria.true, [...criteriaPath, 'true'])
        optionalString(issues, criteria.false, [...criteriaPath, 'false'])
      }
    }
  } else if (type === 'choice') {
    if (criteria === undefined) {
      issues.add(criteriaPath, 'required')
    } else if (!isPlainObject(criteria)) {
      issues.add(criteriaPath, 'not_object')
    } else {
      const names = Object.keys(criteria)
      if (names.length < 1 || names.length > 255) {
        issues.add(criteriaPath, 'count', { min: 1, max: 255 })
      }
      for (const choice of names) {
        if (typeof criteria[choice] !== 'string') {
          issues.add([...criteriaPath, choice], 'not_string')
        }
      }
    }
  } else if (criteria === undefined) {
    issues.add(criteriaPath, 'required')
  } else if (!Array.isArray(criteria)) {
    issues.add(criteriaPath, 'not_array')
  } else {
    if (criteria.length < 1 || criteria.length > 10) {
      issues.add(criteriaPath, 'count', { min: 1, max: 10 })
    }
    criteria.forEach((level, index) => {
      if (typeof level !== 'string') {
        issues.add([...criteriaPath, index], 'not_string')
      }
    })
  }
  if (issues.list.length > before) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every field was checked above.
  return value as SlackGateJevQuestion
}

/** Depth and finiteness of free-form `extra` values, iteratively. */
function validateExtraValue(issues: Issues, root: unknown, rootPath: SlackGateJevPath): void {
  const stack: { value: unknown; path: SlackGateJevPath; depth: number }[] = [
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
    if (depth > SLACK_GATE_JEV_MAX_DEPTH) {
      issues.add(path, 'too_deep', { max: SLACK_GATE_JEV_MAX_DEPTH })
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
  onlyKeys(issues, send, ['send'], SLACK_GATE_JEV_SEND_KEYS)
  for (const [key, value] of Object.entries(send)) {
    const path = ['send', key]
    if (typeof value === 'boolean') {
      continue
    }
    if (LIST_SEND_KEYS.has(key) && typeof value === 'number') {
      if (!Number.isInteger(value) || value < 0 || value > SLACK_GATE_JEV_LIST_LIMIT_MAX) {
        issues.add(path, 'out_of_range', { min: 0, max: SLACK_GATE_JEV_LIST_LIMIT_MAX })
      }
      continue
    }
    issues.add(path, 'not_boolean_or_number')
  }
}

export function validateSlackGateJev(value: unknown): SlackGateJevValidation {
  const issues = new Issues()
  if (!isPlainObject(value)) {
    issues.add([], 'not_object')
    return { ok: false, issues: issues.list }
  }
  for (const key of Object.keys(value)) {
    if (key === 'assets') {
      issues.add([key], 'assets_unsupported')
    } else if (!TOP_KEYS.has(key)) {
      issues.add([key], 'unknown_key')
    }
  }
  if (value.model !== undefined) {
    if (typeof value.model !== 'string') {
      issues.add(['model'], 'not_string')
    } else if (value.model.trim().length > SLACK_GATE_JEV_MODEL_MAX) {
      issues.add(['model'], 'too_long', { max: SLACK_GATE_JEV_MODEL_MAX })
    }
  }
  const questions = new Map<string, SlackGateJevQuestion | null>()
  if (value.questions === undefined) {
    issues.add(['questions'], 'required')
  } else if (!isPlainObject(value.questions)) {
    issues.add(['questions'], 'not_object')
  } else {
    const names = Object.keys(value.questions)
    if (names.length < 1 || names.length > MAX_QUESTIONS) {
      issues.add(['questions'], 'count', { min: 1, max: MAX_QUESTIONS })
    }
    for (const name of names) {
      questions.set(name, validateQuestion(issues, name, value.questions[name]))
    }
  }
  validateSend(issues, value.send)
  if (value.extra !== undefined) {
    if (!isPlainObject(value.extra)) {
      issues.add(['extra'], 'not_object')
    } else {
      validateExtraValue(issues, value.extra, ['extra'])
      for (const key of Object.keys(value.extra)) {
        if (SLACK_GATE_JEV_SEND_KEYS.some((sendKey) => sendKey === key)) {
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
    value.rules.forEach((rule, index) => {
      const name = validateRule(issues, rule, index, questions)
      if (name) {
        used.add(name)
      }
    })
    for (const name of questions.keys()) {
      if (!used.has(name)) {
        issues.add(['questions', name], 'unused_question', { question: name })
      }
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
  if (issues.list.length > 0) {
    return { ok: false, issues: issues.list }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: validated above field by field.
  const config = canonicalSlackGateJev(value as SlackGateJevConfig)
  const bytes = slackGateJevBytes(config)
  if (bytes > SLACK_GATE_JEV_MAX_BYTES) {
    return {
      ok: false,
      issues: [{ path: [], code: 'too_large', params: { max: SLACK_GATE_JEV_MAX_BYTES, bytes } }]
    }
  }
  return { ok: true, config }
}

/** A stored jev: the legacy one-question form alone, or a config (with or without its mirror). */
export function validateStoredSlackGateJev(value: unknown): SlackGateJevIssue[] {
  if (!isPlainObject(value)) {
    return [{ path: [], code: 'not_object' }]
  }
  if (value.questions !== undefined) {
    // The mirror older builds read rides along; the host rewrites it on every save.
    const { question, threshold, ...config } = value
    const result = validateSlackGateJev(config)
    const issues = result.ok ? [] : [...result.issues]
    if (question !== undefined && typeof question !== 'string') {
      issues.push({ path: ['question'], code: 'not_string' })
    }
    if (threshold !== undefined && typeof threshold !== 'number') {
      issues.push({ path: ['threshold'], code: 'not_number' })
    }
    return issues
  }
  const issues = new Issues()
  onlyKeys(issues, value, [], ['question', 'threshold', 'model'])
  for (const issue of issues.list) {
    issue.code = 'legacy_mixed'
  }
  if (typeof value.question !== 'string') {
    issues.add(['question'], value.question === undefined ? 'required' : 'not_string')
  } else if (value.question.trim().length === 0) {
    issues.add(['question'], 'blank')
  } else if (value.question.length > SLACK_GATE_LEGACY_QUESTION_MAX) {
    issues.add(['question'], 'too_long', { max: SLACK_GATE_LEGACY_QUESTION_MAX })
  }
  if (finiteNumber(issues, value.threshold, ['threshold'])) {
    if (value.threshold < 0 || value.threshold > 1) {
      issues.add(['threshold'], 'out_of_range', { min: 0, max: 1 })
    }
  }
  if (value.model !== undefined) {
    if (typeof value.model !== 'string') {
      issues.add(['model'], 'not_string')
    } else if (value.model.trim().length > SLACK_GATE_JEV_MODEL_MAX) {
      issues.add(['model'], 'too_long', { max: SLACK_GATE_JEV_MODEL_MAX })
    }
  }
  return issues.list
}
