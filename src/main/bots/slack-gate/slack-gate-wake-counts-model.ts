// The wake counts' shapes: the per-bot file as written (counts by local day, reservations not yet
// settled) and the reservation a limited wake holds until its delivery is known.
import { createHash } from 'node:crypto'
import * as z from 'zod'
import type { BotStateFile } from './bot-state-file'

/** The local calendar day of a time, as YYYY-MM-DD (compares as text). */
export function localDay(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The start of the local day after `at`. */
export function nextLocalMidnight(at: number): number {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()
}

/** The key a limited rule is counted under; stdin's `wakes` names it the same way. */
export function slackGateWakeKey(questionName: string): string {
  return createHash('sha256').update(questionName).digest('hex').slice(0, 16)
}

/** A local calendar day as YYYY-MM-DD, a real one (the counts compare days as text). */
const Day = z.string().refine((day) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) {
    return false
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return localDay(date.getTime()) === day
})

export const Count = z.object({
  day: Day,
  count: z.number().int().nonnegative(),
  lastAt: z.number()
})
export const Pending = z.object({
  id: z.string(),
  channelId: z.string(),
  key: z.string(),
  rd: Day,
  at: z.number(),
  automationId: z.string().optional(),
  runId: z.string().optional()
})
export const StateFile = z.object({
  v: z.literal(1),
  blockedUntil: z.number().optional(),
  keys: z.record(z.string(), z.record(z.string(), Count)),
  pending: z.array(Pending).optional()
})
export type CountEntry = z.infer<typeof Count>
export type PendingEntry = z.infer<typeof Pending>
/** `creating`: a trigger's run is still being made; reconciling leaves it alone. */
/** `orphan`: a trigger's reservation read back after a restart, which no hook in this process settles. */
export type LiveEntry = PendingEntry & {
  phase: ReservationPhase
  creating?: boolean
  orphan?: true
}

export type ReservationPhase = 'waiting' | 'delivering' | 'settled'

export type Reservation = {
  readonly id: string
  /** Settles once the reservation is on disk: false when it couldn't be written (deliver nothing). */
  readonly persisted: Promise<boolean>
  /** The delivery's admission: false when the reservation already went back (too late to deliver). */
  admit(at: number): boolean
  commit(at: number): void
  release(): void
  /** A trigger reservation while its run is being created: left out of run-record reconciling. */
  creating: boolean
  readonly runId?: string
  readonly automationId?: string
}

export type SlackGateBotCounts = BotCounts
export type BotCounts = {
  botId: string
  file: BotStateFile
  keys: Map<string, Map<string, CountEntry>>
  pending: Map<string, LiveEntry>
  blockedUntil?: number
  /** Not yet safe: counts limited rules as used up (unreadable file not replaced yet). */
  unsafe: boolean
}
