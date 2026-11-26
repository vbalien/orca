// A Slack gate key set from a person's paired computer, through the real dispatcher and runtime: an
// agent's CLI over the same pairing is refused, the key is sealed on this host, and it never comes
// back in an answer, a log line or a client event.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import { CLI_AGENT_CALLER_CLIENT_CAPABILITY } from '../../../../shared/remote-runtime/cli-agent-caller-capability'
import { setSecretStore } from '../../../../shared/secure-storage/secret-store'
import { readSlackGateKey, useSlackGateKeyRoot } from '../../../bots/slack-gate/slack-gate-key'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import type { RpcDispatchStreamingOptions } from '../dispatch/dispatcher-stream-options'
import { BOT_SLACK_GATE_METHODS } from './bots-slack-gate'

// Alphanumeric, so JSON escaping cannot hide it in a serialized answer, log line or event.
const MARK = 'ZQ7MARKER91'
const KEY = `sk-gate-${MARK}`
const leaks = (value: unknown): boolean => JSON.stringify(value).includes(MARK)

// Not base64: a store that skipped sealing would write something else.
const seal = (text: string) => Buffer.from(`SEALED:${Buffer.from(text).toString('hex')}`)

let dir: string
let runtime: OrcaRuntimeService
let events: unknown[]
let logged: unknown[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-slack-gate-dispatch-'))
  useSlackGateKeyRoot(dir)
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: seal,
    decryptString: (cipher) =>
      Buffer.from(cipher.toString().slice('SEALED:'.length), 'hex').toString(),
    describeProtectionGap: () => null,
    describeSealing: () => ({ kind: 'os-keychain' })
  })
  runtime = new OrcaRuntimeService()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the key methods read only the bot's id.
  vi.spyOn(runtime.bots, 'list').mockReturnValue([{ id: 'b1' } as unknown as Bot])
  events = []
  // What paired clients get: `runtime.clientEvents.subscribe` forwards this stream.
  runtime.onClientEvent((event) => events.push(event))
  // Bot change notices are debounced on a timer; the test runs it out instead of waiting.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  logged = []
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args) => logged.push(args))
  }
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  useSlackGateKeyRoot(null)
  rmSync(dir, { recursive: true, force: true })
})

const PERSON: RpcDispatchStreamingOptions = { pairedDeviceId: 'mac', clientCapabilities: [] }
const AGENT: RpcDispatchStreamingOptions = {
  pairedDeviceId: 'mac',
  clientCapabilities: [CLI_AGENT_CALLER_CLIENT_CAPABILITY]
}

function dispatch(method: string, params: unknown, transport: RpcDispatchStreamingOptions) {
  const dispatcher = new RpcDispatcher({
    runtime,
    methods: BOT_SLACK_GATE_METHODS,
    callerScope: { kind: 'runtime-paired', grants: [] }
  })
  return dispatcher.dispatch({ id: method, authToken: 'tok', method, params }, transport)
}

it('saves a key from a person’s paired computer, refuses the CLI there, and never echoes the key', async () => {
  expect(leaks({ nested: [KEY] })).toBe(true)
  const answers = [
    await dispatch('bots.slackGate.setKey', { botId: 'b1', key: KEY }, AGENT),
    await dispatch('bots.slackGate.setKey', { botId: 'b1', key: `${KEY}\nX-Other: y` }, PERSON)
  ]
  expect(answers.map((answer) => answer.ok)).toEqual([false, false])
  expect(await readSlackGateKey('b1')).toBeNull()

  const saved = await dispatch('bots.slackGate.setKey', { botId: 'b1', key: KEY }, PERSON)
  expect(saved).toMatchObject({ ok: true, result: { apiKeySet: true, sealing: 'os-keychain' } })
  const [file] = readdirSync(dir)
  const stored = JSON.parse(readFileSync(join(dir, file), 'utf8'))
  expect(Buffer.from(stored.sealed, 'base64')).toEqual(
    seal(JSON.stringify({ botId: 'b1', key: KEY }))
  )
  expect(await readSlackGateKey('b1')).toBe(KEY)

  answers.push(
    saved,
    await dispatch('bots.slackGate.clearKey', { botId: 'b1' }, AGENT),
    await dispatch('bots.slackGate.status', { botId: 'b1' }, PERSON)
  )
  expect(await readSlackGateKey('b1')).toBe(KEY)
  const cleared = await dispatch('bots.slackGate.clearKey', { botId: 'b1' }, PERSON)
  expect(cleared).toMatchObject({ ok: true, result: { apiKeySet: false } })
  expect(readdirSync(dir)).toEqual([])
  answers.push(cleared)

  // Past the debounce of bot change notices, so a queued event would have gone out.
  await vi.runAllTimersAsync()
  expect(answers.some(leaks)).toBe(false)
  expect(logged.some(leaks)).toBe(false)
  expect(events.some(leaks)).toBe(false)
})
