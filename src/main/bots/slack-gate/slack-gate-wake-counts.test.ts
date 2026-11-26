// A limited rule's counts: a reservation holds a count from the decision to its delivery, only a
// delivered wake keeps it, and the counts survive a restart, an unreadable file and a clock set back.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BotStateFile, useBotStateRoot } from './bot-state-file'
import { RESERVATION_WAIT_MS, SlackGateWakeCounts, localDay } from './slack-gate-wake-counts'

let now = new Date(2026, 10, 26, 12, 0, 0).getTime()
const timers: { at: number; run: () => void }[] = []
const counts = () =>
  new SlackGateWakeCounts({
    now: () => now,
    warn: () => {},
    setTimer: (run, ms) => {
      timers.push({ at: now + ms, run })
      return {}
    }
  })
const advance = (ms: number) => {
  now += ms
  for (const timer of timers.splice(0)) {
    if (timer.at <= now) {
      timer.run()
    } else {
      timers.push(timer)
    }
  }
}
const daily = { perDay: 1 }

beforeEach(() => {
  useBotStateRoot(mkdtempSync(join(tmpdir(), 'wake-counts-')))
  now = new Date(2026, 10, 26, 12, 0, 0).getTime()
  timers.length = 0
})
afterEach(() => useBotStateRoot(null))

it('counts only a delivered wake, and holds the count while the delivery is on its way', async () => {
  const store = counts()
  const bot = await store.load('b1', 0)
  const first = store.reserve(bot, { channelId: 'C1', question: 'banter', at: now })!
  expect(await first.persisted).toBe(true)
  // Reserved: the next message sees the limit used, even before the first is delivered.
  expect(store.open(bot, 'C1', 'banter', daily, now)).toBe(false)
  first.release()
  expect(store.open(bot, 'C1', 'banter', daily, now)).toBe(true)
  const second = store.reserve(bot, { channelId: 'C1', question: 'banter', at: now })!
  await second.persisted
  expect(second.admit(now)).toBe(true)
  second.commit(now)
  expect(store.open(bot, 'C1', 'banter', daily, now)).toBe(false)
  // Another channel or rule counts apart.
  expect(store.open(bot, 'C2', 'banter', daily, now)).toBe(true)
  expect(store.open(bot, 'C1', 'asks', daily, now)).toBe(true)
  // The next local day starts over.
  expect(store.open(bot, 'C1', 'banter', daily, new Date(2026, 10, 27, 0, 0, 1).getTime())).toBe(
    true
  )
})

it('gives back a reservation that waited too long, and then refuses its late admission', async () => {
  const store = counts()
  const bot = await store.load('b1', 0)
  const late = store.reserve(bot, { channelId: 'C1', question: 'banter', at: now })!
  await late.persisted
  advance(RESERVATION_WAIT_MS + 1)
  expect(late.admit(now)).toBe(false)
  expect(store.open(bot, 'C1', 'banter', daily, now)).toBe(true)
  // Admitted in time, it is never given back by the timer, however long the delivery takes.
  const slow = store.reserve(bot, { channelId: 'C1', question: 'banter', at: now })!
  await slow.persisted
  expect(slow.admit(now)).toBe(true)
  advance(RESERVATION_WAIT_MS * 3)
  expect(store.open(bot, 'C1', 'banter', daily, now)).toBe(false)
  slow.commit(now)
  expect(store.open(bot, 'C1', 'banter', daily, now)).toBe(false)
})

it('cools down from the last delivered wake, and while one is still on its way', async () => {
  const store = counts()
  const bot = await store.load('b1', 0)
  const cooldown = { cooldownMinutes: 30 }
  const wake = store.reserve(bot, { channelId: 'C1', question: 'banter', at: now })!
  await wake.persisted
  expect(store.open(bot, 'C1', 'banter', cooldown, now + 60 * 60_000)).toBe(false)
  wake.admit(now)
  wake.commit(now)
  expect(store.open(bot, 'C1', 'banter', cooldown, now + 29 * 60_000)).toBe(false)
  expect(store.open(bot, 'C1', 'banter', cooldown, now + 30 * 60_000)).toBe(true)
})

it('counts a wake reserved before midnight and delivered after it on the new day', async () => {
  now = new Date(2026, 10, 26, 23, 59, 59).getTime()
  const store = counts()
  const bot = await store.load('b1', 0)
  const wake = store.reserve(bot, { channelId: 'C1', question: 'banter', at: now })!
  await wake.persisted
  wake.admit(now)
  now = new Date(2026, 10, 27, 0, 0, 1).getTime()
  wake.commit(now)
  expect(store.open(bot, 'C1', 'banter', daily, now)).toBe(false)
})

it('keeps a day’s count when the clock goes back a day, and adds the wakes made meanwhile to it', async () => {
  const store = counts()
  const bot = await store.load('b1', 0)
  const twice = { perDay: 2 }
  const first = store.reserve(bot, { channelId: 'C1', question: 'banter', at: now })!
  await first.persisted
  first.admit(now)
  first.commit(now)
  now -= 24 * 60 * 60_000
  expect(store.open(bot, 'C1', 'banter', twice, now)).toBe(true)
  const second = store.reserve(bot, { channelId: 'C1', question: 'banter', at: now })!
  await second.persisted
  second.admit(now)
  second.commit(now)
  expect(store.open(bot, 'C1', 'banter', twice, now)).toBe(false)
})

it('does not let a run that woke yesterday use today’s count when it is settled late', async () => {
  const store = counts()
  const bot = await store.load('b1', 0)
  const yesterday = now - 24 * 60 * 60_000
  const run = store.reserve(bot, {
    channelId: 'C1',
    question: 'banter',
    at: yesterday,
    automationId: 'a1',
    runId: 'r1'
  })!
  await run.persisted
  const today = store.reserve(bot, { channelId: 'C1', question: 'banter', at: now })!
  await today.persisted
  today.admit(now)
  today.commit(now)
  // Its run started yesterday (settled at that time): today's one count stays one.
  run.commit(yesterday)
  expect(store.open(bot, 'C1', 'banter', { perDay: 2 }, now)).toBe(true)
})

it('counts at the next start a reservation left unsettled, and reconciles a trigger’s by its run', async () => {
  const first = counts()
  const bot = await first.load('b1', 0)
  const pending = first.reserve(bot, { channelId: 'C1', question: 'banter', at: now })!
  await pending.persisted
  const trigger = first.reserve(bot, {
    channelId: 'C1',
    question: 'asks',
    at: now,
    automationId: 'a1',
    runId: 'r1'
  })!
  await trigger.persisted
  // Restart: the plain one may have woken the bot, so it counts; the trigger's waits for its run.
  const second = counts()
  const again = await second.load('b1', 0)
  expect(second.open(again, 'C1', 'banter', daily, now)).toBe(false)
  expect(second.unsettledRuns(again)).toEqual([{ id: trigger.id, automationId: 'a1', runId: 'r1' }])
  // Its run was skipped: it never woke the bot.
  second.settleUnsettled(again, trigger.id, null)
  expect(second.open(again, 'C1', 'asks', daily, now)).toBe(true)
})

it('leaves a trigger reservation out of reconciling while its run is being created', async () => {
  const store = counts()
  const bot = await store.load('b1', 0)
  const trigger = store.reserve(bot, {
    channelId: 'C1',
    question: 'asks',
    at: now,
    automationId: 'a1',
    runId: 'r1'
  })!
  expect(store.unsettledRuns(bot)).toEqual([])
  trigger.creating = false
  expect(store.unsettledRuns(bot)).toHaveLength(1)
})

it('blocks limited rules after an unreadable file until neither the day nor a cooldown can matter, restart included', async () => {
  const file = new BotStateFile('bot-slack-gate-wakes', 'b1')
  await file.write(() => ({ v: 1, keys: {} }))
  writeFileSync(file.path, '{not json')
  const store = counts()
  const bot = await store.load('b1', 0)
  expect(store.open(bot, 'C1', 'banter', daily, now)).toBe(false)
  // The replacement says so on disk: a restart the same day still blocks.
  expect(JSON.parse(readFileSync(file.path, 'utf8'))).toMatchObject({ v: 1 })
  const restarted = counts()
  const again = await restarted.load('b1', 0)
  expect(restarted.open(again, 'C1', 'banter', daily, now)).toBe(false)
  expect(
    restarted.open(again, 'C1', 'banter', daily, new Date(2026, 10, 27, 0, 0, 1).getTime())
  ).toBe(true)
  // A long cooldown keeps it blocked past the next day.
  writeFileSync(file.path, '{not json')
  const longer = counts()
  const blocked = await longer.load('b1', 3 * 24 * 60)
  expect(
    longer.open(blocked, 'C1', 'banter', daily, new Date(2026, 10, 27, 12, 0, 0).getTime())
  ).toBe(false)
})

it('reserves no more than its cap, and never writes message text or question names', async () => {
  const store = counts()
  const bot = await store.load('b1', 0)
  const held = Array.from({ length: 200 }, (_, i) =>
    store.reserve(bot, { channelId: `C${i}`, question: 'secret_question_name', at: now })
  )
  expect(held.every(Boolean)).toBe(true)
  expect(store.reserve(bot, { channelId: 'C9', question: 'other', at: now })).toBeNull()
  await held[0]!.persisted
  const text = readFileSync(new BotStateFile('bot-slack-gate-wakes', 'b1').path, 'utf8')
  expect(text).not.toContain('secret_question_name')
  expect(localDay(now)).toBe('2026-11-26')
})

it('runs a cooldown from now when the clock went back past the last wake, and keeps that', async () => {
  const store = counts()
  const bot = await store.load('b1', 0)
  const woke = store.reserve(bot, { channelId: 'C1', question: 'banter', at: now })!
  await woke.persisted
  woke.admit(now)
  woke.commit(now)
  const cooldown = { cooldownMinutes: 30 }
  // A day back: the wake counts as now, so 31 minutes later the cooldown is over.
  now -= 86_400_000
  expect(store.open(bot, 'C1', 'banter', cooldown, now)).toBe(false)
  advance(31 * 60_000)
  expect(store.open(bot, 'C1', 'banter', cooldown, now)).toBe(true)
  // And after a restart too: the pulled-back time was written.
  await vi.waitFor(async () => {
    const restarted = counts()
    const again = await restarted.load('b1', 0)
    expect(restarted.open(again, 'C1', 'banter', cooldown, now)).toBe(true)
  })
})
