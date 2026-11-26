// A Slack-gated trigger's limited-rule counts after a restart, settled by its runs' records, and the
// gate's decision as an automation run's precheck result.
import type { Bot } from '../../shared/bot-types'
import { effectiveSlackGate } from '../../shared/bots/bot-slack-gate'
import { slackGateRulesExtended } from '../../shared/bots/slack-gate-rules-config'
import type {
  AutomationPrecheckResult,
  AutomationRun
} from '../../shared/automations/history/automation-run'
import type { SlackWakeDecision } from '../bots/slack-gate/slack-gate'
import { forgetSlackGateRuns, heldSlackGateRuns } from '../bots/slack-gate/slack-gate-runs'
import type { SlackGateWakeCounts } from '../bots/slack-gate/slack-gate-wake-counts'

const SKIPPED: readonly AutomationRun['status'][] = [
  'skipped_precheck',
  'skipped_missed',
  'skipped_unavailable',
  'skipped_needs_interactive_auth'
]

export function precheckResult(
  decision: SlackWakeDecision,
  kind: string,
  at: number
): AutomationPrecheckResult {
  return {
    command: `Slack wake gate (${kind})`,
    exitCode: decision.exitCode ?? null,
    timedOut: decision.timedOut === true,
    durationMs: decision.durationMs,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    error: decision.error ?? null,
    startedAt: at,
    completedAt: at + decision.durationMs
  }
}

/** Settles counts left by trigger runs this process didn't see start, by their runs' records:
 *  skipped never started (back), still pending waits, anything else may have started (kept). Runs
 *  waiting for their prompt here are settled when it is made, or forgotten once they end. */
export async function settleTriggerCounts(
  deps: {
    runsOf?: (automationIds: readonly string[]) => Map<string, readonly AutomationRun[]>
    counts: SlackGateWakeCounts
    now: () => number
  },
  bot: Pick<Bot, 'id' | 'slackGate'>
): Promise<void> {
  const gate = bot.slackGate ? effectiveSlackGate(bot.slackGate) : null
  const limited =
    gate?.kind === 'openai' &&
    (gate.rulesCommand !== undefined || slackGateRulesExtended(gate.openai).limits)
  if (!deps.runsOf || !limited) {
    return
  }
  const counts = deps.counts
  const loaded = await counts.load(bot.id)
  const waiting = heldSlackGateRuns()
  const waitingIds = new Set(waiting.map((run) => run.runId))
  const unsettled = counts.unsettledRuns(loaded).filter((run) => !waitingIds.has(run.runId))
  const ids = [
    ...new Set(
      [...unsettled, ...waiting].flatMap((run) => (run.automationId ? [run.automationId] : []))
    )
  ]
  if (ids.length === 0) {
    return
  }
  const runs = deps.runsOf(ids)
  const statusOf = (automationId: string | undefined, runId: string) =>
    automationId ? runs.get(automationId)?.find((run) => run.id === runId)?.status : undefined
  const at = deps.now()
  for (const run of unsettled) {
    const status = statusOf(run.automationId, run.runId)
    if (status === 'pending' || status === 'dispatching') {
      continue
    }
    counts.settleUnsettled(loaded, run.id, status && SKIPPED.includes(status) ? null : at)
  }
  forgetSlackGateRuns((automationId, runId) => {
    const status = statusOf(automationId, runId)
    return status !== undefined && status !== 'pending' && status !== 'dispatching'
  })
}
