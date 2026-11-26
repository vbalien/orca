// The Slack wake gate's decision and the shapes its parts pass around.
import type { Bot } from '../../../shared/bot-types'
import type { SlackGateChoiceValue } from '../../../shared/bots/slack-gate-rules-config'
import type { SlackGateKeySlot } from './slack-gate-key'
import type { runSlackGateCommand } from './slack-gate-command'
import type { askSlackGateOpenAI } from './slack-gate-openai'
import type { SlackGateRuleResult } from './slack-gate-rules'
import type { Reservation, SlackGateWakeCounts } from './slack-gate-wake-counts'

export type SlackWakeDecision = {
  verdict: 'wake' | 'block'
  reason: 'not_gated' | 'passed' | 'blocked' | 'error' | 'cancelled' | 'expired' | 'rate_limited'
  durationMs: number
  exitCode?: number | null
  timedOut?: boolean
  score?: number
  /** OpenAI: each question's answer (numbers or choice values) and each rule's result. No message text. */
  answers?: Record<string, number | SlackGateChoiceValue>
  rules?: SlackGateRuleResult[]
  /** OpenAI: the questions it declined to answer, by name (a failed check; by number for script rules). */
  refused?: string[]
  error?: string
  /** Whose rules decided: the editor's saved rules, or ones a rules script wrote for this message. */
  rulesFrom?: 'saved' | 'script'
  /** Why it woke: the rule's question and note, or the rules script's reason. Never logged. */
  wakeReason?: { text: string; from: 'rules' | 'script' }
  /** A limited rule's count for this wake, held until the caller knows whether the wake was delivered:
   *  `admit` at the delivery's admission, then `commit` or `release`. Never logged. */
  reservation?: Reservation
}

/** What a rules script last did for a bot, for the settings page: no message text. */
export type SlackGateScriptRun = {
  at: number
  outcome: 'verdict' | 'ask' | 'useSaved' | 'error'
  error?: string
}

export type SlackGateBot = Pick<Bot, 'id' | 'name' | 'slackGate'>

export type SlackGateDeps = {
  readKey: (botId: string, slot: SlackGateKeySlot) => Promise<string | null>
  runCommand: typeof runSlackGateCommand
  askOpenAI: typeof askSlackGateOpenAI
  now: () => number
  /** Defaults to the process's own (slackGateWakeCounts). */
  counts?: SlackGateWakeCounts
  /** chance's draw, in [0, 1). */
  random?: () => number
}

/** How one check ended, before it becomes a decision. */
export type SlackGateOutcome =
  | {
      kind: 'verdict'
      wake: boolean
      exitCode?: number | null
      score?: number
      answers?: Record<string, number | SlackGateChoiceValue>
      rules?: SlackGateRuleResult[]
      rulesFrom?: 'saved' | 'script'
      rateLimited?: true
      wakeReason?: SlackWakeDecision['wakeReason']
      reservation?: Reservation
    }
  | {
      kind: 'error'
      error: string
      exitCode?: number | null
      timedOut?: true
      refused?: string[]
      rulesFrom?: 'saved' | 'script'
    }

export type SlackGateDecideOptions = {
  signal?: AbortSignal
  deadlineAt?: number
  /** A trigger's run: its reservation carries it and is delivering at once. */
  run?: { automationId: string; runId: string }
}
