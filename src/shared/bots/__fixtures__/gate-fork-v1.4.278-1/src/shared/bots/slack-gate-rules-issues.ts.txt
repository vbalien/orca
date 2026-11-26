// Collecting the gate rules validator's problems, and the small checks every part of it uses.
import type {
  SlackGateRulesIssue,
  SlackGateRulesIssueCode,
  SlackGateRulesPath
} from './slack-gate-rules-config'

// Enough to fix a config by; a pasted wall of junk never costs more than this many.
const MAX_ISSUES = 50

export class Issues {
  readonly list: SlackGateRulesIssue[] = []
  /** Every problem found, also past the ones kept: what tells valid from not. */
  count = 0
  add(
    path: SlackGateRulesPath,
    code: SlackGateRulesIssueCode,
    params?: SlackGateRulesIssue['params']
  ) {
    this.count++
    if (this.list.length < MAX_ISSUES) {
      this.list.push({ path, code, ...(params ? { params } : {}) })
    }
  }
}

export function onlyKeys(
  issues: Issues,
  value: Record<string, unknown>,
  path: SlackGateRulesPath,
  allowed: readonly string[]
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      issues.add([...path, key], 'unknown_key')
    }
  }
}

export function optionalString(issues: Issues, value: unknown, path: SlackGateRulesPath): void {
  if (value !== undefined && typeof value !== 'string') {
    issues.add(path, 'not_string')
  }
}

export function finiteNumber(
  issues: Issues,
  value: unknown,
  path: SlackGateRulesPath
): value is number {
  if (typeof value !== 'number') {
    issues.add(path, 'not_number')
    return false
  }
  if (!Number.isFinite(value)) {
    issues.add(path, 'not_finite')
    return false
  }
  return true
}

/** Text the field needs: present, a string, not blank. */
export function requiredText(issues: Issues, value: unknown, path: SlackGateRulesPath): void {
  if (value === undefined) {
    issues.add(path, 'required')
  } else if (typeof value !== 'string') {
    issues.add(path, 'not_string')
  } else if (value.trim().length === 0) {
    issues.add(path, 'blank')
  }
}
