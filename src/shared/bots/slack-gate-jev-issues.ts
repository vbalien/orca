// Collecting the Jev config validator's problems, and the small checks every part of it uses.
import type {
  SlackGateJevIssue,
  SlackGateJevIssueCode,
  SlackGateJevPath
} from './slack-gate-jev-config'

// Enough to fix a config by; a pasted wall of junk never costs more than this many.
const MAX_ISSUES = 50

export class Issues {
  readonly list: SlackGateJevIssue[] = []
  /** Every problem found, also past the ones kept: what tells valid from not. */
  count = 0
  add(path: SlackGateJevPath, code: SlackGateJevIssueCode, params?: SlackGateJevIssue['params']) {
    this.count++
    if (this.list.length < MAX_ISSUES) {
      this.list.push({ path, code, ...(params ? { params } : {}) })
    }
  }
}

export function onlyKeys(
  issues: Issues,
  value: Record<string, unknown>,
  path: SlackGateJevPath,
  allowed: readonly string[]
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      issues.add([...path, key], 'unknown_key')
    }
  }
}

export function optionalString(issues: Issues, value: unknown, path: SlackGateJevPath): void {
  if (value !== undefined && typeof value !== 'string') {
    issues.add(path, 'not_string')
  }
}

export function finiteNumber(
  issues: Issues,
  value: unknown,
  path: SlackGateJevPath
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
