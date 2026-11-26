// How often each limited wake rule woke a bot, per channel and rule: the rule's limit is checked against
// it, a wake reserves one count before it is delivered, and only a delivered wake keeps it. Kept in a
// private file per bot with no message text and no question names (a hash of each), so counts survive a
// restart. See plan "빈도 제한": a reservation is written before its delivery goes, an unsettled one is
// counted at the next start, and an unreadable file blocks limited rules until it can't matter.
import { randomUUID } from 'node:crypto'
import type { SlackGateLimit } from '../../../shared/bots/slack-gate-rules-config'
import { BotStateFile } from './bot-state-file'
import {
  localDay,
  nextLocalMidnight,
  slackGateWakeKey,
  StateFile,
  type BotCounts,
  type CountEntry,
  type LiveEntry,
  type Reservation
} from './slack-gate-wake-counts-model'
import {
  countWake,
  keptKeys,
  pendingFor,
  pendingStatusOf,
  type SlackGatePendingStatus,
  closedCounts,
  pruneCounts,
  serializeCounts
} from './slack-gate-wake-counts-entries'

export {
  localDay,
  slackGateWakeKey,
  type Reservation,
  type ReservationPhase,
  type SlackGateBotCounts
} from './slack-gate-wake-counts-model'

const FOLDER = 'bot-slack-gate-wakes'
/** A reservation that never got as far as its delivery's admission goes back after this long. */
export const RESERVATION_WAIT_MS = 2 * 60_000
const MAX_PENDING = 200
const MAX_KEYS = 1000
const OLD_PENDING_WARN_MS = 10 * 60_000
const WARN_EVERY_MS = 60_000

export type SlackGateWakeCountsDeps = {
  now: () => number
  warn?: (message: string, fields?: Record<string, unknown>) => void
  setTimer?: (run: () => void, ms: number) => { unref?: () => void }
}

export class SlackGateWakeCounts {
  private readonly bots = new Map<string, Promise<BotCounts>>()
  private readonly lastWarn = new Map<string, { at: number; count: number }>()
  // Deleted bots: a check still under way for one counts in memory only, never in a file again.
  private readonly forgotten = new Set<string>()

  constructor(private readonly deps: SlackGateWakeCountsDeps) {}

  private warn(cause: string, fields: Record<string, unknown> = {}): void {
    const now = this.deps.now()
    const seen = this.lastWarn.get(cause) ?? { at: 0, count: 0 }
    seen.count++
    if (now - seen.at >= WARN_EVERY_MS) {
      ;(this.deps.warn ?? console.warn)(`[slack-gate] ${cause}`, { ...fields, times: seen.count })
      this.lastWarn.set(cause, { at: now, count: 0 })
    } else {
      this.lastWarn.set(cause, seen)
    }
  }

  /** The bot's counts, read once. `longestCooldownMinutes`: how long an unreadable file blocks. */
  /** The bot's counts, read once. `longestCooldownMinutes` (slackGateRecoveryCooldown) sets how long
   *  an unreadable file holds limited rules; every caller passes its gate's. */
  load(botId: string, longestCooldownMinutes: number): Promise<BotCounts> {
    let loading = this.bots.get(botId)
    if (!loading) {
      loading = this.forgotten.has(botId)
        ? Promise.resolve(closedCounts(new BotStateFile(FOLDER, botId)))
        : this.read(botId, longestCooldownMinutes)
      this.bots.set(botId, loading)
    }
    return loading
  }

  private async read(botId: string, longestCooldownMinutes: number): Promise<BotCounts> {
    const file = new BotStateFile(FOLDER, botId)
    const bot: BotCounts = { file, keys: new Map(), pending: new Map(), unsafe: false }
    const read = await file.read()
    const parsed = read.kind === 'ok' ? StateFile.safeParse(read.value) : null
    if (read.kind === 'missing') {
      return bot
    }
    if (!parsed?.success) {
      // Lost counts may have used up today's limit or be cooling down: block until neither can matter.
      const now = this.deps.now()
      bot.unsafe = true
      bot.blockedUntil = Math.max(nextLocalMidnight(now), now + longestCooldownMinutes * 60_000)
      this.warn('wake counts unreadable; limited rules wait', { botId })
      // The unreadable file is replaced only once it is kept aside; until then limited rules wait.
      if (!(await file.preserveUnreadable())) {
        this.warn('wake counts unreadable and could not be kept aside; limited rules wait', {
          botId
        })
        return bot
      }
      if (await file.write(() => serializeCounts(bot, this.deps.now()))) {
        bot.unsafe = false
      }
      return bot
    }
    const state = parsed.data
    bot.blockedUntil = state.blockedUntil
    for (const [channelId, keys] of Object.entries(state.keys)) {
      bot.keys.set(channelId, new Map(Object.entries(keys)))
    }
    // Left unsettled by the last run: a trigger's is reconciled with its run; any other may have been
    // delivered, so it counts now.
    const now = this.deps.now()
    let changed = false
    for (const entry of state.pending ?? []) {
      if (entry.runId) {
        bot.pending.set(entry.id, { ...entry, phase: 'delivering' })
      } else {
        countWake(bot, entry, now)
        changed = true
      }
    }
    if (changed) {
      void file.write(() => serializeCounts(bot, this.deps.now()))
    }
    return bot
  }

  /** Whether a limit lets this rule wake now (chance is the caller's). Needs `load` first. */
  open(bot: BotCounts, channelId: string, question: string, limit: SlackGateLimit, at: number) {
    if (bot.unsafe || (bot.blockedUntil !== undefined && at < bot.blockedUntil)) {
      return false
    }
    const key = slackGateWakeKey(question)
    const entry = bot.keys.get(channelId)?.get(key)
    // The clock went back past the last wake: that wake counts as now, so a cooldown runs from here
    // instead of waiting for the clock to catch up (plan "날짜 역행").
    if (entry && entry.lastAt > at) {
      entry.lastAt = at
      void bot.file.write(() => serializeCounts(bot, this.deps.now()))
    }
    const pending = pendingFor(bot, channelId, key)
    if (!entry && pending.length === 0 && keptKeys(bot, at) >= MAX_KEYS) {
      this.warn('too many limited rules to count; this one waits', { channels: bot.keys.size })
      return false
    }
    const day = entry && entry.day > localDay(at) ? entry.day : localDay(at)
    const today = entry?.day === day ? entry.count : 0
    if (limit.perDay !== undefined && today + pending.length >= limit.perDay) {
      return false
    }
    if (limit.cooldownMinutes !== undefined) {
      if (pending.length > 0) {
        return false
      }
      if (entry && at - entry.lastAt < limit.cooldownMinutes * 60_000) {
        return false
      }
    }
    return true
  }

  /** What stdin's `wakes` tells a rules script about one channel. */
  channelWakes(bot: BotCounts, channelId: string, at: number) {
    const keys = bot.keys.get(channelId) ?? new Map<string, CountEntry>()
    return Object.fromEntries(
      [...keys].map(([key, entry]) => [
        key,
        {
          today: entry.day === localDay(at) ? entry.count : 0,
          lastAt: entry.lastAt,
          ...(pendingFor(bot, channelId, key).length > 0 ? { pending: true } : {})
        }
      ])
    )
  }

  /** Reserves one count for a rule about to wake the bot; null when no more can be reserved. The
   *  caller awaits `persisted` before delivering. A trigger's starts delivering at once (no admission
   *  to refuse a late one), carrying its run. */
  reserve(
    bot: BotCounts,
    input: {
      channelId: string
      question: string
      at: number
      automationId?: string
      runId?: string
    }
  ): Reservation | null {
    const live = [...bot.pending.values()].filter((entry) => entry.phase !== 'settled')
    if (live.length >= MAX_PENDING) {
      this.warn('too many wakes waiting to be counted; this one waits', { pending: live.length })
      return null
    }
    const key = slackGateWakeKey(input.question)
    const current = bot.keys.get(input.channelId)?.get(key)
    // A new rule's count needs room, as open() saw it; another reservation may have taken it since.
    if (
      !current &&
      !pendingFor(bot, input.channelId, key).length &&
      keptKeys(bot, input.at) >= MAX_KEYS
    ) {
      this.warn('too many limited rules to count; this one waits', { channels: bot.keys.size })
      return null
    }
    const today = localDay(input.at)
    const entry: LiveEntry = {
      id: randomUUID(),
      channelId: input.channelId,
      key,
      rd: current && current.day > today ? current.day : today,
      at: input.at,
      ...(input.automationId ? { automationId: input.automationId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      phase: input.runId ? 'delivering' : 'waiting',
      ...(input.runId ? { creating: true } : {})
    }
    bot.pending.set(entry.id, entry)
    const persisted = bot.file.write(() => serializeCounts(bot, this.deps.now()))
    const save = () => {
      pruneCounts(bot, this.deps.now())
      void bot.file.write(() => serializeCounts(bot, this.deps.now()))
    }
    const settle = (at: number | null) => {
      if (entry.phase === 'settled') {
        return
      }
      if (at !== null) {
        countWake(bot, entry, at)
      }
      entry.phase = 'settled'
      bot.pending.delete(entry.id)
      save()
    }
    if (entry.phase === 'waiting') {
      const timer = (this.deps.setTimer ?? setTimeout)(() => {
        if (entry.phase === 'waiting') {
          settle(null)
        }
      }, RESERVATION_WAIT_MS)
      timer.unref?.()
    }
    const oldTimer = (this.deps.setTimer ?? setTimeout)(() => {
      if (entry.phase === 'delivering') {
        this.warn('a wake has waited long to be counted', { ageMs: this.deps.now() - entry.at })
      }
    }, OLD_PENDING_WARN_MS)
    oldTimer.unref?.()
    const reservation: Reservation = {
      id: entry.id,
      persisted: persisted.then((ok) => {
        if (!ok) {
          this.warn('could not write a wake count; not waking', {})
          settle(null)
        }
        return ok
      }),
      admit: () => {
        if (entry.phase !== 'waiting') {
          return entry.phase === 'delivering'
        }
        entry.phase = 'delivering'
        return true
      },
      commit: (at) => settle(at),
      release: () => settle(null),
      get creating() {
        return entry.creating === true
      },
      set creating(value: boolean) {
        entry.creating = value
      },
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.automationId ? { automationId: input.automationId } : {})
    }
    return reservation
  }

  /** Trigger reservations to reconcile with their runs' records: every one whose run exists (created
   *  in this process, or left from the last), never one whose run is still being created. */
  unsettledRuns(bot: BotCounts): { id: string; automationId?: string; runId: string }[] {
    return [...bot.pending.values()].flatMap((entry) =>
      entry.phase !== 'settled' && entry.runId && !entry.creating
        ? [
            {
              id: entry.id,
              ...(entry.automationId ? { automationId: entry.automationId } : {}),
              runId: entry.runId
            }
          ]
        : []
    )
  }

  settleUnsettled(bot: BotCounts, id: string, at: number | null): void {
    const entry = bot.pending.get(id)
    if (!entry || entry.phase === 'settled') {
      return
    }
    if (at !== null) {
      countWake(bot, entry, at)
    }
    entry.phase = 'settled'
    bot.pending.delete(id)
    void bot.file.write(() => serializeCounts(bot, this.deps.now()))
  }

  /** The bot is gone: its counts with it. */
  /** The bot was deleted: its file goes, and nothing writes it again. */
  async forget(botId: string): Promise<void> {
    this.forgotten.add(botId)
    const loading = this.bots.get(botId)
    this.bots.delete(botId)
    const bot = loading ? await loading.catch(() => null) : null
    await (bot?.file ?? new BotStateFile(FOLDER, botId)).remove()
  }

  /** For status: how many wakes wait to be counted, the oldest one's age, and whether limited rules
   *  are held after an unreadable file (until `blockedUntil`, or until it is replaced). */
  async pendingStatus(botId: string): Promise<SlackGatePendingStatus> {
    const loading = this.bots.get(botId)
    return loading ? pendingStatusOf(await loading, this.deps.now()) : { pending: 0 }
  }
}
