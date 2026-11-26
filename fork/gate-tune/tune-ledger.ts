// The tuning tool's spend ledger: live runs reserve their budget before any request and settle it after,
// one run at a time under a lock. A run that died keeps its reservation counted.
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  realpathSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  truncateSync,
  statSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fail } from './tune-cases'

type LedgerLine = { run: string; kind: 'reserve' | 'settle'; usd: number; at: string }

const USD_PER_INPUT_TOKEN = 0.1 / 1_000_000
const USD_PER_CACHED_TOKEN = 0.01 / 1_000_000
// Writing the prompt cache (30 minutes) costs 1.25 times plain input; Decisions caches by default.
const USD_PER_CACHE_WRITE_TOKEN = 0.125 / 1_000_000

/** Spend for input tokens: plain, cache reads, and cache writes. Tokens held for an attempt whose usage
 *  is unknown count at the highest rate. */
export type Spend = { tokens: number; cached: number; writes: number; held: number }
export const usdOf = ({ tokens, cached, writes, held }: Spend) =>
  (tokens - cached - writes - held) * USD_PER_INPUT_TOKEN +
  cached * USD_PER_CACHED_TOKEN +
  (writes + held) * USD_PER_CACHE_WRITE_TOKEN
/** A budget reserved before any request, at the highest rate. */
export const reservedUsd = (tokens: number) => tokens * USD_PER_CACHE_WRITE_TOKEN

function readLine(text: string, index: number): LedgerLine {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    fail(`ledger line ${index + 1}: not JSON`)
  }
  const get = (name: string): unknown =>
    typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined
  const run = get('run')
  const kind = get('kind')
  const usd = get('usd')
  if (
    typeof run !== 'string' ||
    (kind !== 'reserve' && kind !== 'settle') ||
    typeof usd !== 'number' ||
    !Number.isFinite(usd) ||
    usd < 0
  ) {
    fail(`ledger line ${index + 1}: needs "run", "kind": reserve | settle and a "usd" of 0 or more`)
  }
  return { run, kind, usd, at: String(get('at') ?? '') }
}

/** Every run's spend: what it settled, or what it reserved when it never settled (it may have spent it). */
export function ledgerUsd(path: string): number {
  if (!existsSync(path)) {
    return 0
  }
  const runs = new Map<string, { reserve: number; settle?: number }>()
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((text, index) => {
      if (text.trim().length === 0) {
        return
      }
      const line = readLine(text, index)
      const run = runs.get(line.run) ?? { reserve: 0 }
      if (line.kind === 'settle') {
        run.settle = line.usd
      } else {
        run.reserve = line.usd
      }
      runs.set(line.run, run)
    })
  return [...runs.values()].reduce((sum, run) => sum + (run.settle ?? run.reserve), 0)
}

/** One live run at a time. A lock left by a run that died is removed by hand, never taken over, so two
 *  runs can't both pass the ledger check. */
export function lockLedger(given: string): { ledger: string; unlock: () => void } {
  mkdirSync(dirname(given), { recursive: true, mode: 0o700 })
  // Its folder resolved, so every path to one ledger takes the same lock.
  const ledger = realTarget(given)
  assertPrivateTarget(dirname(ledger))
  // One regular file, one lock: another name for it (a link of either kind, even a dangling one) would
  // take a lock of its own, and anything but a file can't be read safely.
  const entry = lstatOrNull(ledger)
  if (entry && (!entry.isFile() || entry.nlink > 1)) {
    fail(`${ledger} must be one regular file with no other name (no links)`)
  }
  assertPrivateTarget(ledger)
  const lock = `${ledger}.lock`
  let fd: number
  try {
    fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  } catch (error) {
    fail(
      Reflect.get(Object(error), 'code') === 'EEXIST'
        ? `${lock} exists: another live run holds it, or one died; remove it once no run is going`
        : `${lock} can't be created`
    )
  }
  try {
    writeFileSync(fd, String(process.pid))
  } catch {
    // The lock is this run's own: a failed write must not leave it to block later runs.
    rmSync(lock, { force: true })
    fail(`${lock} can't be written`)
  } finally {
    closeSync(fd)
  }
  return { ledger, unlock: () => rmSync(lock, { force: true }) }
}

/** A file or folder this tool writes must, if it exists, be yours and closed to everyone else: its mode
 *  is only set when it is created. */
export function assertPrivateTarget(path: string): void {
  if (!existsSync(path)) {
    return
  }
  const stat = statSync(path)
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    fail(`${path} must be yours and private (chmod ${stat.isDirectory() ? '700' : '600'})`)
  }
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if (Reflect.get(Object(error), 'code') === 'ENOENT') {
      return null
    }
    fail(`${path} can't be checked`)
  }
}

/** Where a path really is: its folder resolved (links and all), then its own name. Throws when the folder
 *  is not there. */
export function realTarget(path: string): string {
  return join(realpathSync(dirname(resolve(path))), basename(path))
}

function samePath(target: string, other: string): boolean {
  try {
    return target === realTarget(other)
  } catch {
    return target === resolve(other)
  }
}

/** Before any request: opens the result file once (without emptying it) and keeps that descriptor to the
 *  end, so nothing can swap the path in between. It must be a regular private file of yours, in a folder,
 *  and none of the run's own files (cases, config, key, ledger, lock), which it would otherwise overwrite. */
export function openResultFile(path: string, others: readonly string[]): number {
  // By path first, so a refused result never leaves a file behind (a lock file would block later runs).
  let target: string
  try {
    target = realTarget(path)
  } catch {
    fail(`${dirname(path)} is not a folder`)
  }
  if (others.some((other) => samePath(target, other))) {
    fail(`${path} is one of this run's own files (cases, config, key, ledger or lock)`)
  }
  const existed = lstatOrNull(target) !== null
  let fd: number
  try {
    // Non-blocking, so a FIFO can't hang the open before it is refused as not a regular file.
    fd = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600
    )
  } catch {
    fail(
      `${path} can't be opened for the results (a link, a folder, or a folder you can't write in)`
    )
  }
  const stat = fstatSync(fd)
  const own = others.flatMap((other) => {
    try {
      return [statSync(other)]
    } catch {
      return []
    }
  })
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    own.some((other) => other.dev === stat.dev && other.ino === stat.ino)
  ) {
    closeSync(fd)
    if (!existed) {
      rmSync(target, { force: true })
    }
    fail(`${path} must be a private file of yours (chmod 600) and none of this run's own files`)
  }
  return fd
}

/** Replaces the result file's content through the descriptor opened for it, and closes it. */
export function writeResultFile(fd: number, text: string): void {
  try {
    ftruncateSync(fd)
    // All of it or an error: a short write would leave cut JSON behind.
    writeFileSync(fd, text)
  } finally {
    closeSync(fd)
  }
}

/** Appends one line whole, or not at all: a failed write is cut back so the ledger stays readable. */
export function writeLedger(path: string, line: LedgerLine): void {
  const before = lstatOrNull(path)?.size ?? 0
  try {
    appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 })
  } catch (error) {
    try {
      truncateSync(path, before)
    } catch {
      // Nothing more to do here; the next run refuses an unreadable ledger rather than guess.
    }
    throw error
  }
}
