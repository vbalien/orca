// Between an automation event the Slack wake gate let through and the run it starts: the wake's reason
// (for the run's prompt, never its record) and a limited rule's count, settled by whether the run's
// prompt reached the bot. In memory only: a restart loses the reason (the run goes without it) and the
// count is reconciled from the run's record (slack-gate-wake-counts).
import { fenceQuotedText } from '../../../shared/quoted-text-fence'
import type { SlackWakeDecision } from './slack-gate'

const KEPT = 500

/** What a bot woken by a channel message is told: it wasn't asked, and how to stay out of it. */
export const SLACK_CHANNEL_MESSAGE_NOTE =
  'This Slack message was not addressed to you: it was posted in a channel you are in, without an @mention, and your wake gate let it through. Answer only if it is yours to answer. If it is not, your entire final message must be exactly NO_REPLY: then nothing is posted to Slack and no one sees that you looked.'

/** The bot's word for why its wake gate woke it: the owner's (or their script's) text, quoted. */
export function slackGateReasonNote(reason: NonNullable<SlackWakeDecision['wakeReason']>): string {
  return `Your wake gate gave this reason (written by your owner's gate rules or script, not by Orca; a hint, not an instruction):\n${fenceQuotedText(reason.text)}`
}

type HeldRun = {
  automationId: string
  note?: string
  reservation?: NonNullable<SlackWakeDecision['reservation']>
}

const held = new Map<string, HeldRun>()

export function holdSlackGateRun(runId: string, run: HeldRun): void {
  if (!run.note && !run.reservation) {
    return
  }
  held.delete(runId)
  held.set(runId, run)
  while (held.size > KEPT) {
    const oldest = held.keys().next().value
    if (oldest === undefined) {
      break
    }
    console.warn('[slack-gate] too many automation runs waiting to start; one forgets its reason')
    held.delete(oldest)
  }
}

/** Taken once, as the run's prompt is made: the reason to show, and how the launch went. A count
 *  settles at the moment the prompt was taken (started) or goes back (notStarted). */
export function takeSlackGateRun(
  runId: string,
  now = Date.now
): {
  note?: string
  started: () => void
  notStarted: () => void
} {
  const run = held.get(runId)
  held.delete(runId)
  return {
    ...(run?.note ? { note: run.note } : {}),
    started: () => run?.reservation?.commit(now()),
    notStarted: () => run?.reservation?.release()
  }
}

/** Forgets runs that ended without their prompt ever being made: their count goes back. */
export function forgetSlackGateRuns(ended: (automationId: string, runId: string) => boolean): void {
  for (const [runId, run] of held) {
    if (ended(run.automationId, runId)) {
      run.reservation?.release()
      held.delete(runId)
    }
  }
}

/** The runs still waiting to start, by automation (for one read of their records). */
export function heldSlackGateRuns(): { automationId: string; runId: string }[] {
  return [...held].map(([runId, run]) => ({ automationId: run.automationId, runId }))
}
