// The Jev gate config as the owner types it: strict JSON, size and nesting checked before parsing,
// duplicate keys refused, and every problem placed on a line of the text.
import {
  findNodeAtLocation,
  getNodeValue,
  parseTree,
  type Node,
  type ParseError
} from 'jsonc-parser'
import type {
  SlackGateJevConfig,
  SlackGateJevIssue,
  SlackGateJevPath
} from './slack-gate-jev-config'
import { validateSlackGateJev } from './slack-gate-jev-validate'

export const SLACK_GATE_JEV_TEXT_MAX_BYTES = 64 * 1024
// Above the config's own depth limit: this only keeps the parser off pathological input.
const TEXT_MAX_DEPTH = 12

export type SlackGateJevTextIssue = SlackGateJevIssue & { line?: number }
export type SlackGateJevTextResult =
  | { ok: true; config: SlackGateJevConfig }
  | { ok: false; issues: SlackGateJevTextIssue[] }

/** 1-based line of a text offset. */
export function lineAt(text: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset && index < text.length; index++) {
    if (text.charCodeAt(index) === 10) {
      line++
    }
  }
  return line
}

/** Where nesting first goes deeper than allowed, outside strings; null when it never does. */
function tooDeepAt(text: string): number | null {
  let depth = 0
  let inString = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (char === '\\') {
        index++
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{' || char === '[') {
      depth++
      if (depth > TEXT_MAX_DEPTH) {
        return index
      }
    } else if (char === '}' || char === ']') {
      depth--
    }
  }
  return null
}

/** The first property name repeated inside one object, at its second occurrence. */
function duplicateKey(tree: Node): { key: string; offset: number } | null {
  const stack: Node[] = [tree]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.type === 'object') {
      const seen = new Set<string>()
      for (const property of node.children ?? []) {
        const keyNode = property.children?.[0]
        const key = typeof keyNode?.value === 'string' ? keyNode.value : null
        if (key !== null && seen.has(key)) {
          return { key, offset: keyNode!.offset }
        }
        if (key !== null) {
          seen.add(key)
        }
      }
    }
    for (const child of node.children ?? []) {
      stack.push(child)
    }
  }
  return null
}

/** The line of a path's node, or of its nearest existing ancestor when the node is missing. */
export function lineOfPath(text: string, tree: Node, path: SlackGateJevPath): number {
  for (let length = path.length; length >= 0; length--) {
    const node = findNodeAtLocation(tree, path.slice(0, length))
    if (node) {
      // A property's value sits on its key's line; point at the key when there is one.
      const anchor = node.parent?.type === 'property' ? node.parent : node
      return lineAt(text, anchor.offset)
    }
  }
  return 1
}

export function parseSlackGateJevText(text: string): SlackGateJevTextResult {
  if (new TextEncoder().encode(text).length > SLACK_GATE_JEV_TEXT_MAX_BYTES) {
    return {
      ok: false,
      issues: [{ path: [], code: 'text_too_large', params: { max: SLACK_GATE_JEV_TEXT_MAX_BYTES } }]
    }
  }
  const deep = tooDeepAt(text)
  if (deep !== null) {
    return {
      ok: false,
      issues: [
        { path: [], code: 'too_deep', params: { max: TEXT_MAX_DEPTH }, line: lineAt(text, deep) }
      ]
    }
  }
  const errors: ParseError[] = []
  let tree: Node | undefined
  try {
    tree = parseTree(text, errors, {
      disallowComments: true,
      allowTrailingComma: false,
      allowEmptyContent: false
    })
  } catch {
    tree = undefined
  }
  if (errors.length > 0 || !tree) {
    const first = errors[0]
    return {
      ok: false,
      issues: [{ path: [], code: 'syntax', line: lineAt(text, first?.offset ?? 0) }]
    }
  }
  const duplicate = duplicateKey(tree)
  if (duplicate) {
    return {
      ok: false,
      issues: [
        {
          path: [],
          code: 'duplicate_key',
          params: { key: duplicate.key },
          line: lineAt(text, duplicate.offset)
        }
      ]
    }
  }
  let value: unknown
  try {
    value = getNodeValue(tree)
  } catch {
    return { ok: false, issues: [{ path: [], code: 'syntax', line: 1 }] }
  }
  const result = validateSlackGateJev(value)
  if (result.ok) {
    return result
  }
  const located = tree
  return {
    ok: false,
    issues: result.issues.map((issue) => ({
      ...issue,
      line: lineOfPath(text, located, issue.path)
    }))
  }
}

/** A config as the editor shows it: indented, or compact when indenting would pass the text limit, so
 *  every config the host accepts opens again as text the editor accepts. */
export function formatSlackGateJevText(value: unknown): string {
  const pretty = JSON.stringify(value, null, 2)
  return new TextEncoder().encode(pretty).length <= SLACK_GATE_JEV_TEXT_MAX_BYTES
    ? pretty
    : JSON.stringify(value)
}

/** `rules[2].wakeIf.atLeast` for a path. */
export function formatSlackGateJevPath(path: SlackGateJevPath): string {
  return path.reduce<string>(
    (joined, part) =>
      typeof part === 'number' ? `${joined}[${part}]` : joined ? `${joined}.${part}` : part,
    ''
  )
}
