// How many gate checks run at once for a bot: a few, with a short line behind them. Channel messages
// queue apart, so a busy channel never starves mentions and replies.
import type { SlackGateOutcome } from './slack-gate-types'

export const SLACK_GATE_RUNNING_PER_BOT = 2
export const SLACK_GATE_WAITING_PER_BOT = 16
const CHANNEL_RUNNING_PER_BOT = 1
const CHANNEL_WAITING_PER_BOT = 8
// A runner that ignores its stop gets this long before the decision goes on without it.
const STOP_GRACE_MS = 2_000

class BotSlots {
  running = 0
  readonly waiting: (() => void)[] = []
  constructor(
    readonly maxRunning: number,
    readonly maxWaiting: number
  ) {}
}

export type SlackGateWork = () => Promise<{
  outcome: Promise<SlackGateOutcome>
  released: Promise<void>
}>

export class SlackGateSlots {
  private readonly slots = new Map<string, BotSlots>()

  /** Runs `work` in one of the bot's slots, held until its `released` settles. A stop or deadline
   *  ends the wait for an answer even while `work` is still starting (a stalled key read). */
  async run(
    botId: string,
    lane: 'main' | 'channel',
    signal: AbortSignal,
    work: SlackGateWork
  ): Promise<SlackGateOutcome> {
    const laneKey = `${lane}:${botId}`
    const slots =
      this.slots.get(laneKey) ??
      (lane === 'channel'
        ? new BotSlots(CHANNEL_RUNNING_PER_BOT, CHANNEL_WAITING_PER_BOT)
        : new BotSlots(SLACK_GATE_RUNNING_PER_BOT, SLACK_GATE_WAITING_PER_BOT))
    this.slots.set(laneKey, slots)
    if (slots.running < slots.maxRunning) {
      slots.running += 1
    } else if (slots.waiting.length >= slots.maxWaiting) {
      return { kind: 'error', error: 'Too many gate checks are waiting for this bot' }
    } else if (!(await this.handedSlot(slots, signal))) {
      return { kind: 'error', error: 'Stopped while waiting' }
    }
    const started = work()
    void started
      .then((run) => run.released)
      .catch(() => undefined)
      .then(() => this.free(laneKey, slots))
    const giveUp = new Promise<SlackGateOutcome>((resolve) => {
      const onAbort = () => {
        const timer = setTimeout(
          () => resolve({ kind: 'error', error: 'Did not stop in time' }),
          STOP_GRACE_MS
        )
        timer.unref?.()
      }
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
    const outcome = started.then(
      (run) => run.outcome,
      (): SlackGateOutcome => ({ kind: 'error', error: 'The gate could not start' })
    )
    return await Promise.race([outcome, giveUp])
  }

  /** Waits for a running check to hand its slot over; false when stopped first. */
  private handedSlot(slots: BotSlots, signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const ready = () => {
        signal.removeEventListener('abort', give)
        resolve(true)
      }
      const give = () => {
        const at = slots.waiting.indexOf(ready)
        if (at !== -1) {
          slots.waiting.splice(at, 1)
        }
        resolve(false)
      }
      slots.waiting.push(ready)
      signal.addEventListener('abort', give, { once: true })
    })
  }

  /** A finished check hands its slot straight to the next waiter, so the count never dips. */
  private free(laneKey: string, slots: BotSlots): void {
    const next = slots.waiting.shift()
    if (next) {
      next()
      return
    }
    slots.running -= 1
    if (slots.running === 0 && this.slots.get(laneKey) === slots) {
      this.slots.delete(laneKey)
    }
  }
}
