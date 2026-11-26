// What a rules script printed, read as the gate's input from outside: one strict JSON object that decides
// at once ({"wake": …}), asks OpenAI rules the editor would accept ({"ask": …}), or defers to the saved
// rules ({"useSaved": true}). Anything else is a failed check. Errors are fixed sentences: the output may
// carry message text.
import {
  isOneLineText,
  isPlainObject,
  SLACK_GATE_NOTE_MAX,
  type SlackGateRulesConfig
} from '../../../shared/bots/slack-gate-rules-config'
import { parseStrictJsonText } from '../../../shared/bots/slack-gate-rules-text'
import { validateSlackGateRules } from '../../../shared/bots/slack-gate-rules-validate'

/** The most a rules script may print. */
export const SLACK_GATE_SCRIPT_MAX_OUTPUT_BYTES = 64 * 1024

export type SlackGateScriptAnswer =
  | { kind: 'verdict'; wake: boolean; reason?: string }
  | { kind: 'ask'; config: SlackGateRulesConfig }
  | { kind: 'useSaved' }
  | { kind: 'error'; error: string }

export function readRulesScriptOutput(stdout: string): SlackGateScriptAnswer {
  const parsed = parseStrictJsonText(stdout.trim())
  if (!parsed.ok || !isPlainObject(parsed.value)) {
    return { kind: 'error', error: 'The rules script printed no JSON object' }
  }
  const output = parsed.value
  const keys = Object.keys(output).sort().join(',')
  if (keys === 'useSaved' && output.useSaved === true) {
    return { kind: 'useSaved' }
  }
  if ((keys === 'wake' || keys === 'reason,wake') && typeof output.wake === 'boolean') {
    if (output.reason !== undefined && !isOneLineText(output.reason, SLACK_GATE_NOTE_MAX)) {
      return { kind: 'error', error: 'The rules script gave a reason that is not one short line' }
    }
    return {
      kind: 'verdict',
      wake: output.wake,
      ...(typeof output.reason === 'string' ? { reason: output.reason } : {})
    }
  }
  if (keys === 'ask') {
    const rules = validateSlackGateRules(output.ask)
    return rules.ok
      ? { kind: 'ask', config: rules.config }
      : { kind: 'error', error: 'The rules script asked rules the editor would refuse' }
  }
  return { kind: 'error', error: 'The rules script printed an output of an unknown shape' }
}
