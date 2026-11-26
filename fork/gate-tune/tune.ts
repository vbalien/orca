// Fork-only: tune an OpenAI Decisions wake gate on labelled messages. Builds each request with the gate's
// own request builder, asks the Decisions API (or a loopback fake), and reports how the gate's own rules
// would decide at each threshold, and the tokens spent.
//   node --import tsx fork/gate-tune/tune.ts --cases <file.jsonl> --max-input-tokens <n>
//     [--config <rules.json>] [--live | --endpoint http://127.0.0.1:<port>] [--out <file.json>]
//     [--key-file <path>] [--ledger <spend.jsonl>] [--total-usd-cap <usd>]
// Without --live or --endpoint it only counts requests and their reservations (no network).
// --max-input-tokens is an estimated budget, not a guarantee: each HTTP attempt reserves its body's bytes
// + 256 (assuming a byte-level BPE tokenizer, which the API docs don't state) and settles on the reported
// usage. A live run reserves its budget in the ledger first and won't start past --total-usd-cap. POSIX only.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { slackGateOpenAIRequest } from '../../src/shared/bots/slack-gate-openai-request'
import {
  OPENAI_DECISIONS_URL,
  readSlackGateAnswers
} from '../../src/main/bots/slack-gate/slack-gate-openai'
import { eventOf, fail, readCases, readConfig, TuneStop } from './tune-cases'
import {
  openResultFile,
  ledgerUsd,
  lockLedger,
  reservedUsd,
  usdOf,
  writeLedger,
  type Spend
} from './tune-ledger'
import { readKey, revision, sha256 } from './tune-env'
import { answerValues, report, type TuneResult } from './tune-report'

const REQUEST_TIMEOUT_MS = 30_000

const { values } = parseArgs({
  options: {
    cases: { type: 'string' },
    config: { type: 'string' },
    live: { type: 'boolean', default: false },
    endpoint: { type: 'string' },
    'key-file': { type: 'string', default: join(homedir(), '.config', 'orca-fork', 'openai-key') },
    'max-input-tokens': { type: 'string' },
    ledger: {
      type: 'string',
      default: join(homedir(), '.config', 'orca-fork', 'calibration', 'spend.jsonl')
    },
    'total-usd-cap': { type: 'string', default: '20' },
    out: { type: 'string' }
  }
})

const interrupted = new AbortController()
process.once('SIGINT', () => interrupted.abort())

/** An HTTP attempt's reservation: its body's bytes plus room for message framing. */
const reserve = (body: string) => new TextEncoder().encode(body).length + 256

/** Waits, or stops waiting at Ctrl-C; leaves no listener behind either way. */
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    if (interrupted.signal.aborted) {
      resolve()
      return
    }
    const done = () => {
      clearTimeout(timer)
      interrupted.signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    interrupted.signal.addEventListener('abort', done, { once: true })
  })

type Attempt =
  | { kind: 'ok'; json: unknown; tokens: number; cached: number; writes: number; ms: number }
  | { kind: 'retry'; seconds: number }
  | { kind: 'stop'; why: string }

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const field = (value: unknown, name: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined

/** One POST, its body read within the time limit, never following a redirect. */
async function attempt(url: string, key: string, body: string): Promise<Attempt> {
  const started = performance.now()
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), interrupted.signal])
    })
    if (!response.ok) {
      // Never read: an error body can quote part of the key.
      await response.body?.cancel().catch(() => undefined)
      const wait = Number(response.headers.get('retry-after'))
      return response.status === 429
        ? { kind: 'retry', seconds: Number.isFinite(wait) && wait > 0 ? Math.min(60, wait) : 5 }
        : { kind: 'stop', why: `HTTP ${response.status}` }
    }
    const json: unknown = await response.json()
    const usage = field(json, 'usage')
    const tokens = field(usage, 'input_tokens')
    // Every count OpenAI documents must be there: an unknown cache write would be billed unseen.
    const details = field(usage, 'input_tokens_details')
    const cached = field(details, 'cached_tokens')
    const writes = field(details, 'cache_write_tokens')
    if (!count(tokens) || !count(cached) || !count(writes) || cached + writes > tokens) {
      return { kind: 'stop', why: 'no usable usage' }
    }
    return { kind: 'ok', json, tokens, cached, writes, ms: Math.round(performance.now() - started) }
  } catch (error) {
    // Never the error's text: a request error can carry the request's headers.
    return { kind: 'stop', why: error instanceof Error ? error.name : 'failed' }
  }
}

function endpointOf(): string | null {
  if (values.live && values.endpoint) {
    fail('use --live or --endpoint, not both')
  }
  if (values.endpoint) {
    const url = new URL(values.endpoint)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      fail('--endpoint must be a loopback http address (a fake server)')
    }
    return new URL('/v1/decisions', url).toString()
  }
  return values.live ? OPENAI_DECISIONS_URL : null
}

async function main(): Promise<void> {
  if (!values.cases) {
    fail('--cases <file.jsonl> is required')
  }
  const budget = Number(values['max-input-tokens'])
  if (!Number.isSafeInteger(budget) || budget <= 0) {
    fail('--max-input-tokens <positive integer> is required')
  }
  const endpoint = endpointOf()
  const config = readConfig(values.config)
  // Read once: the cases sent and the hash reported are of the same text, and the revision of this moment.
  const casesText = readFileSync(values.cases, 'utf8')
  const cases = readCases(casesText)

  const startedAt = new Date().toISOString()
  const codeRevision = revision()
  const bodies = cases.map((entry) => {
    const request = slackGateOpenAIRequest(
      config,
      { name: entry.botName ?? 'Orca Bot' },
      eventOf(entry)
    )
    return request ? JSON.stringify(request) : null
  })
  if (!endpoint) {
    const reserved = bodies.reduce((sum, body) => sum + (body ? reserve(body) : 0), 0)
    console.log(
      `dry run: ${cases.length} requests, reservations ${reserved} input tokens (budget ${budget}); add --live or --endpoint to send`
    )
    return
  }
  // Opened before any request, so a result file that can't be written costs nothing.
  const out =
    values.out === undefined
      ? undefined
      : openResultFile(
          values.out,
          [
            values.cases,
            values.config,
            values['key-file'],
            values.ledger,
            `${values.ledger}.lock`
          ].filter((path): path is string => typeof path === 'string')
        )
  const live = endpoint === OPENAI_DECISIONS_URL
  const key = live ? readKey(values['key-file']!) : 'fake-key'
  const cap = Number(values['total-usd-cap'])
  if (live && (!Number.isFinite(cap) || cap <= 0)) {
    fail('--total-usd-cap must be a positive number of US dollars')
  }
  const locked = live ? lockLedger(values.ledger!) : null
  const ledger = locked?.ledger ?? values.ledger!
  const unlock = locked?.unlock ?? (() => {})
  const run = randomUUID()
  try {
    if (live) {
      const spent = ledgerUsd(ledger)
      if (spent + reservedUsd(budget) > cap) {
        fail(
          `the ledger (${spent.toFixed(4)} USD) plus this budget would pass --total-usd-cap ${cap}`
        )
      }
      // Reserved before any request, so a run that dies keeps its budget counted.
      writeLedger(ledger, {
        run,
        kind: 'reserve',
        usd: reservedUsd(budget),
        at: new Date().toISOString()
      })
    }
    const outcome = await send(endpoint, key, cases, bodies, budget, config)
    let unsettled = false
    if (live) {
      try {
        writeLedger(ledger, {
          run,
          kind: 'settle',
          usd: usdOf(outcome.spend),
          at: new Date().toISOString()
        })
      } catch {
        // The reservation above stays counted; the paid answers are still reported.
        unsettled = true
      }
    }
    report(config, cases, outcome.results, outcome.spend, outcome.stopped, out, {
      run,
      at: startedAt,
      endpoint: live ? 'openai' : 'loopback fake',
      revision: codeRevision,
      configSha256: sha256(JSON.stringify(config)),
      casesSha256: sha256(casesText)
    })
    if (unsettled) {
      fail(`could not settle this run in ${ledger}: its whole reservation stays counted`)
    }
    if (outcome.stopped || outcome.results.some((result) => result.failure)) {
      // Reported and settled, but not every case was answered.
      process.exitCode = 3
    }
  } finally {
    unlock()
  }
}

async function send(
  endpoint: string,
  key: string,
  cases: ReturnType<typeof readCases>,
  bodies: (string | null)[],
  budget: number,
  config: ReturnType<typeof readConfig>
): Promise<{ results: TuneResult[]; spend: Spend; stopped: string | null }> {
  const spend: Spend = { tokens: 0, cached: 0, writes: 0, held: 0 }
  let stopped: string | null = null
  const results: TuneResult[] = []
  for (const [index, entry] of cases.entries()) {
    if (interrupted.signal.aborted) {
      stopped = 'interrupted'
      break
    }
    const body = bodies[index]
    if (!body) {
      results.push({ id: entry.id, expect: entry.expect, failure: 'too large to send' })
      continue
    }
    let outcome: Attempt | null = null
    for (let tries = 0; tries < 2; tries++) {
      if (interrupted.signal.aborted) {
        stopped = 'interrupted'
        break
      }
      const hold = reserve(body)
      if (spend.tokens + hold > budget) {
        stopped = `the budget would pass before ${entry.id}`
        break
      }
      spend.tokens += hold
      spend.held += hold
      outcome = await attempt(endpoint, key, body)
      if (outcome.kind === 'ok') {
        spend.tokens += outcome.tokens - hold
        spend.held -= hold
        spend.cached += outcome.cached
        spend.writes += outcome.writes
        break
      }
      if (outcome.kind === 'stop' || tries === 1) {
        break
      }
      // Wait only for a retry that can still go: not cancelled, and its reservation fits the budget.
      if (interrupted.signal.aborted || spend.tokens + reserve(body) > budget) {
        break
      }
      await sleep(outcome.seconds * 1000)
    }
    if (outcome?.kind !== 'ok') {
      stopped ??=
        outcome?.kind === 'stop'
          ? `${entry.id}: ${outcome.why}, its reservation stays counted`
          : `${entry.id}: rate limited, and no retry (twice, cancelled, or past the budget)`
      if (outcome) {
        results.push({ id: entry.id, expect: entry.expect, failure: stopped })
      }
      break
    }
    const read = readSlackGateAnswers(config.questions, outcome.json)
    results.push({
      id: entry.id,
      expect: entry.expect,
      inputTokens: outcome.tokens,
      latencyMs: outcome.ms,
      ...(read.kind === 'error'
        ? { failure: read.error }
        : { answers: answerValues(config, read.answers), read: read.answers })
    })
  }
  return { results, spend, stopped }
}

void main().catch((error: unknown) => {
  // Our own messages only; anything else by its name, never its text.
  console.error(
    `tune: ${error instanceof TuneStop ? error.message : error instanceof Error ? error.name : 'failed'}`
  )
  process.exitCode = 2
})
