import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runSlackGateCommand, untilGroupQuiet } from './slack-gate-command'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-slack-gate-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const run = (command: string, fields: { timeoutMs?: number; key?: string | null } = {}) =>
  runSlackGateCommand({
    command,
    stdin: JSON.stringify({ v: 1, text: "it's $(rm -rf /) `x`" }),
    key: fields.key ?? null,
    timeoutMs: fields.timeoutMs ?? 5_000,
    signal: new AbortController().signal
  })

describe.skipIf(process.platform === 'win32')('runSlackGateCommand', () => {
  it('takes the verdict from the exit code, never from what the command prints', async () => {
    expect(await run('echo \'{"wake":true}\'; exit 1').outcome).toEqual({ kind: 'exit', code: 1 })
    expect(await run('exit 0').outcome).toEqual({ kind: 'exit', code: 0 })
    expect(await run('exit 3').outcome).toEqual({ kind: 'exit', code: 3 })
  })

  it('hands the event only on stdin, with a minimal environment and the key', async () => {
    process.env.ORCA_SLACK_GATE_TEST_SECRET = 'leak'
    try {
      const out = join(dir, 'seen')
      const result = await run(
        `cat > '${out}'; env | sort >> '${out}'; test -z "$ORCA_SLACK_GATE_TEST_SECRET" && test "$TYPESAFE_API_KEY" = k1`,
        { key: 'k1' }
      ).outcome
      expect(result).toEqual({ kind: 'exit', code: 0 })
      const seen = readFileSync(out, 'utf8')
      expect(seen.startsWith(JSON.stringify({ v: 1, text: "it's $(rm -rf /) `x`" }))).toBe(true)
      expect(seen).not.toContain('ORCA_SLACK_GATE_TEST_SECRET')
    } finally {
      delete process.env.ORCA_SLACK_GATE_TEST_SECRET
    }
  })

  it('answers a background child plus exit 0 at once and leaves no process behind', async () => {
    const pidFile = join(dir, 'pid')
    // Held open pipes would keep the run going until this timeout, answering `timeout` instead.
    const gate = run(`sleep 600 & echo $! > '${pidFile}'; exit 0`, { timeoutMs: 10_000 })
    expect(await gate.outcome).toEqual({ kind: 'exit', code: 0 })
    await gate.released
    expect(alive(Number(readFileSync(pidFile, 'utf8')))).toBe(false)
  })

  it('times out and kills what the command started', async () => {
    const pidFile = join(dir, 'pid')
    const gate = run(`sleep 600 & echo $! > '${pidFile}'; sleep 600`, { timeoutMs: 300 })
    expect(await gate.outcome).toEqual({ kind: 'timeout' })
    await gate.released
    expect(alive(Number(readFileSync(pidFile, 'utf8')))).toBe(false)
  })

  it('keeps repeated successful commands from holding processes', async () => {
    for (let i = 0; i < 5; i++) {
      const gate = run('exit 0')
      expect(await gate.outcome).toEqual({ kind: 'exit', code: 0 })
      await gate.released
    }
  })
})

describe('runSlackGateCommand on Windows', () => {
  it('refuses before launching anything', async () => {
    const gate = runSlackGateCommand({
      command: 'exit 0',
      stdin: '{}',
      key: null,
      timeoutMs: 1_000,
      signal: new AbortController().signal,
      platform: 'win32'
    })
    expect(await gate.outcome).toMatchObject({ kind: 'error' })
  })
})

describe('untilGroupQuiet', () => {
  it('keeps a slot until the group is verified quiet, then releases it once', async () => {
    const answers = [false, false, true]
    const quiet = vi.fn(async () => answers.shift() ?? true)
    const waits: number[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await untilGroupQuiet(123, quiet, async (ms) => {
      waits.push(ms)
    })
    expect(quiet).toHaveBeenCalledTimes(3)
    expect(waits).toEqual([5_000, 10_000])
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
