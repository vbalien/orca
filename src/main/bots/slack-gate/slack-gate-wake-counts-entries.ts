// The wake counts' bookkeeping on one bot's loaded counts: what is written to its file, which counts
// are kept, and one delivered wake's count.
import type { BotStateFile } from './bot-state-file'
import {
  localDay,
  type BotCounts,
  type CountEntry,
  type PendingEntry
} from './slack-gate-wake-counts-model'

const KEEP_DAYS = 14

export function serializeCounts(bot: BotCounts, now: number): unknown {
  return {
    v: 1,
    ...(bot.blockedUntil !== undefined && bot.blockedUntil > now
      ? { blockedUntil: bot.blockedUntil }
      : {}),
    keys: Object.fromEntries(
      [...bot.keys].map(([channelId, keys]) => [channelId, Object.fromEntries(keys)])
    ),
    pending: [...bot.pending.values()]
      .filter((entry) => entry.phase !== 'settled')
      .map(({ phase: _phase, creating: _creating, ...entry }) => entry)
  }
}

export function pendingFor(bot: BotCounts, channelId: string, key: string) {
  return [...bot.pending.values()].filter(
    (entry) => entry.phase !== 'settled' && entry.channelId === channelId && entry.key === key
  )
}

/** Counts kept whatever the cap: today's or still cooling down (14 days covers every cooldown), and
 *  those reservations will add. */
export function keptKeys(bot: BotCounts, at: number): number {
  const kept = new Set<string>()
  for (const [channelId, keys] of bot.keys) {
    for (const [key, entry] of keys) {
      if (entry.day >= localDay(at) || at - entry.lastAt < KEEP_DAYS * 86_400_000) {
        kept.add(`${channelId} ${key}`)
      }
    }
  }
  // A reservation not counted yet will be: it takes its place now.
  for (const entry of bot.pending.values()) {
    if (entry.phase !== 'settled') {
      kept.add(`${entry.channelId} ${entry.key}`)
    }
  }
  return kept.size
}

export function pruneCounts(bot: BotCounts, at: number): void {
  for (const [channelId, keys] of bot.keys) {
    for (const [key, entry] of keys) {
      const busy = pendingFor(bot, channelId, key).length > 0
      if (!busy && entry.day < localDay(at) && at - entry.lastAt >= KEEP_DAYS * 86_400_000) {
        keys.delete(key)
      }
    }
    if (keys.size === 0) {
      bot.keys.delete(channelId)
    }
  }
}

/** One count for a delivered wake, on the day rule `max(rd, today(at))` (plan "확정 날짜"). */
export function countWake(bot: BotCounts, entry: PendingEntry, at: number): void {
  const keys = bot.keys.get(entry.channelId) ?? new Map<string, CountEntry>()
  bot.keys.set(entry.channelId, keys)
  const current = keys.get(entry.key) ?? { day: '', count: 0, lastAt: 0 }
  const day = entry.rd > localDay(at) ? entry.rd : localDay(at)
  const next =
    day === current.day
      ? { ...current, count: current.count + 1 }
      : day > current.day
        ? { day, count: 1, lastAt: current.lastAt }
        : { ...current }
  keys.set(entry.key, { ...next, lastAt: Math.max(current.lastAt, at) })
}

/** A deleted bot's counts: in memory only, its file never written again. */
export function closedCounts(file: BotStateFile): BotCounts {
  file.close()
  return { file, keys: new Map(), pending: new Map(), unsafe: false }
}

export type SlackGatePendingStatus = {
  pending: number
  oldestMs?: number
  heldUntil?: number | 'replaced'
}

/** For status: how many wakes wait to be counted, the oldest one's age, and whether limited rules
 *  are held after an unreadable file (until `blockedUntil`, or until it is replaced). */
export function pendingStatusOf(bot: BotCounts, now: number): SlackGatePendingStatus {
  const ages = [...bot.pending.values()]
    .filter((entry) => entry.phase !== 'settled')
    .map((entry) => now - entry.at)
  const heldUntil = bot.unsafe
    ? ('replaced' as const)
    : bot.blockedUntil !== undefined && bot.blockedUntil > now
      ? bot.blockedUntil
      : undefined
  return {
    pending: ages.length,
    ...(ages.length > 0 ? { oldestMs: Math.max(...ages) } : {}),
    ...(heldUntil !== undefined ? { heldUntil } : {})
  }
}

/** What stdin's `wakes` tells a rules script about one channel, as open() sees the counts: a last
 *  wake past now (the clock went back) is now (`pulled`: the caller writes that), and a day ahead
 *  of today counts as today. */
export function channelWakesOf(
  bot: BotCounts,
  channelId: string,
  at: number
): { wakes: Record<string, { today: number; lastAt: number; pending?: true }>; pulled: boolean } {
  const keys = bot.keys.get(channelId) ?? new Map<string, CountEntry>()
  let pulled = false
  const wakes = Object.fromEntries(
    [...keys].map(([key, entry]) => {
      if (entry.lastAt > at) {
        entry.lastAt = at
        pulled = true
      }
      const day = entry.day > localDay(at) ? entry.day : localDay(at)
      return [
        key,
        {
          today: entry.day === day ? entry.count : 0,
          lastAt: entry.lastAt,
          ...(pendingFor(bot, channelId, key).length > 0 ? { pending: true as const } : {})
        }
      ]
    })
  )
  return { wakes, pulled }
}
