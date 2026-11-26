// The owner's own command as a Slack gate: the event goes in on stdin only, the exit code is the
// verdict, and nothing it started outlives it. POSIX only: Windows can't own a tree past root exit.
import type { ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { runProcess, spawnProcess } from '@orca/process-host'
import {
  forceTerminateProcessTree,
  posixProcessGroupQuiet
} from '@orca/process-host/process-tree-termination'

export type SlackGateCommandOutcome =
  | { kind: 'exit'; code: number | null; stdout?: string; stdoutTooLarge?: true }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'error'; error: string }

export type SlackGateCommandRun = {
  outcome: Promise<SlackGateCommandOutcome>
  /** Settles once nothing the command started is left running: its slot may be reused. */
  released: Promise<void>
}

export const SLACK_GATE_COMMAND_UNSUPPORTED = 'Command gates are not supported on Windows yet.'

const ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR']
const RECHECK_FIRST_MS = 5_000
const RECHECK_MAX_MS = 5 * 60_000

/** Only what a shell needs, plus the gate's key; Orca's own environment never reaches the command. */
export function slackGateCommandEnv(
  source: NodeJS.ProcessEnv,
  key: string | null
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && (ENV_KEYS.includes(name) || name.startsWith('LC_'))) {
      env[name] = value
    }
  }
  if (key) {
    env.ORCA_SLACK_GATE_API_KEY = key
    env.TYPESAFE_API_KEY = key
  }
  return env
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.())
}

/** Waits, on a backoff, until the command's process group is gone or only zombies remain. */
export async function untilGroupQuiet(
  pid: number,
  quiet: (pid: number) => Promise<boolean> = posixProcessGroupQuiet,
  wait: (ms: number) => Promise<void> = sleep
): Promise<void> {
  let delay = RECHECK_FIRST_MS
  for (let checks = 0; !(await quiet(pid).catch(() => false)); checks++) {
    if (checks === 0) {
      console.warn('[slack-gate] a gate command left processes running; its slot stays taken')
    }
    await wait(delay)
    delay = Math.min(delay * 2, RECHECK_MAX_MS)
  }
}

export function runSlackGateCommand(input: {
  command: string
  stdin: string
  key: string | null
  timeoutMs: number
  signal: AbortSignal
  platform?: NodeJS.Platform
  /** Read stdout, up to this many bytes (a rules script); more stops it. Otherwise stdout is ignored. */
  stdoutLimit?: number
}): SlackGateCommandRun {
  if ((input.platform ?? process.platform) === 'win32') {
    const outcome = { kind: 'error', error: SLACK_GATE_COMMAND_UNSUPPORTED } as const
    return { outcome: Promise.resolve(outcome), released: Promise.resolve() }
  }
  let child: ChildProcess | undefined
  let rootCode: number | null | undefined
  let cleanup: Promise<boolean> | undefined
  // From the root's exit, not stream close: a background child holding inherited pipes would
  // otherwise keep the run open until its timeout.
  const cleanGroup = (): Promise<boolean> =>
    (cleanup ??= child
      ? forceTerminateProcessTree(child).catch(() => false)
      : Promise.resolve(true))
  const run = runProcess({
    program: '/bin/sh',
    args: ['-c', input.command],
    cwd: tmpdir(),
    env: slackGateCommandEnv(process.env, input.key),
    input: input.stdin,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    detached: true,
    terminationBarrier: true,
    stdio: ['pipe', input.stdoutLimit ? 'pipe' : 'ignore', 'ignore'],
    ...(input.stdoutLimit
      ? { maxOutputBytes: input.stdoutLimit + 1, killOnOutputLimit: true }
      : {}),
    launch: (spec) => {
      const launched = spawnProcess(spec)
      child = launched
      launched.once('exit', (code) => {
        rootCode = code
        void cleanGroup()
      })
      return { child: launched, withdrawPendingLaunch: () => {} }
    }
  })
  const outcome = run.then(
    (result): SlackGateCommandOutcome => {
      if (input.signal.aborted) {
        return { kind: 'cancelled' }
      }
      if (result.timedOut) {
        return { kind: 'timeout' }
      }
      const code = rootCode === undefined ? result.code : rootCode
      if (!input.stdoutLimit) {
        return { kind: 'exit', code }
      }
      const tooLarge = Buffer.byteLength(result.stdout) > input.stdoutLimit
      return {
        kind: 'exit',
        code,
        stdout: tooLarge ? '' : result.stdout,
        ...(tooLarge ? { stdoutTooLarge: true as const } : {})
      }
    },
    (error: unknown): SlackGateCommandOutcome =>
      input.signal.aborted
        ? { kind: 'cancelled' }
        : { kind: 'error', error: error instanceof Error ? error.message : 'failed to start' }
  )
  const released = outcome.then(async () => {
    const pid = child?.pid
    if (pid === undefined) {
      return
    }
    await cleanGroup()
    await untilGroupQuiet(pid)
  })
  return { outcome, released }
}
