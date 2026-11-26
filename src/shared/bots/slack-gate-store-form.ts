// How a gate is stored so that builds which don't know its newer fields still run it safely. A note
// only explains, so older builds get the rules without it. A limit or a rules script can't be honored by
// them, so they get a stand-in that blocks every checked message and an error policy that blocks too;
// the real rules and policy wait in `newer`. Builds that know `newer` run it (effectiveSlackGate).
import type { BotSlackGate, BotSlackGateEdit } from './bot-slack-gate'
import { slackGateRulesExtended, type SlackGateRulesConfig } from './slack-gate-rules-config'

const STAND_IN_QUESTION = 'orca_needs_newer_build'

/** Rules every valid answer blocks: a block rule at or above 0, the lowest probability there is. */
export const SLACK_GATE_BLOCK_ALL_RULES: SlackGateRulesConfig = {
  questions: [{ type: 'predicate', name: STAND_IN_QUESTION, instructions: 'Answer true.' }],
  rules: [{ question: STAND_IN_QUESTION, blockIf: { atLeast: 0 } }]
}

/** Whether rules are the block-everything stand-in (an older Orca saved the gate without `newer`). */
export function isBlockAllStandIn(config: SlackGateRulesConfig): boolean {
  return config.questions.length === 1 && config.questions[0]?.name === STAND_IN_QUESTION
}

function withoutNotes(config: SlackGateRulesConfig): SlackGateRulesConfig {
  return {
    ...config,
    rules: config.rules.map(({ note: _note, ...rule }) => rule)
  }
}

/** The stored form of an edited gate. */
export function toStoredSlackGate(gate: BotSlackGateEdit): BotSlackGate {
  if (gate.kind !== 'openai') {
    return gate
  }
  const { notes, limits } = slackGateRulesExtended(gate.openai)
  if (limits || gate.rulesCommand) {
    return {
      ...gate,
      openai: SLACK_GATE_BLOCK_ALL_RULES,
      onError: 'block',
      newer: { openai: gate.openai, onError: gate.onError }
    }
  }
  return notes
    ? { ...gate, openai: withoutNotes(gate.openai), newer: { openai: gate.openai } }
    : gate
}

/** What a build that knows none of these fields keeps of a stored gate when it rewrites the profile:
 *  the unknown fields dropped, and no gate at all when nothing it knows is checked. */
export function oldSchemaView(gate: BotSlackGate | null | undefined): unknown {
  if (!gate) {
    return null
  }
  if (gate.appliesTo.length === 0) {
    return null
  }
  const { channelMessages: _channels, ...known } = gate
  if (known.kind !== 'openai') {
    return known
  }
  const { rulesCommand: _script, newer: _newer, ...old } = known
  return old
}

/** Whether a stored gate uses anything older builds drop. */
export function slackGateUsesNewerFields(gate: BotSlackGate): boolean {
  return (
    gate.channelMessages !== undefined ||
    gate.appliesTo.length === 0 ||
    (gate.kind === 'openai' && (gate.newer !== undefined || gate.rulesCommand !== undefined))
  )
}
