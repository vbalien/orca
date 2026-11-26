// A bot's own Slack app set up from a person's paired computer, through the real dispatcher, runtime
// and store: an agent's CLI (local or over the pairing) and a phone are refused, tokens are sealed on
// this host, and no token comes back in an answer, a log line or a client event, failures included.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { format } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import { CLI_AGENT_CALLER_CLIENT_CAPABILITY } from '../../../../shared/remote-runtime/cli-agent-caller-capability'
import type { SecretStore } from '../../../../shared/secure-storage/secret-store'
import {
  closeTestStores,
  createSqliteTestStore
} from '../../../persistence/persistence-test-harness'
import { Store } from '../../../persistence/loading-store/store'
import { newBotRecord } from '../../../bots/bot-new-record'
import { SlackLocalService, setSlackLocalService } from '../../../slack-local/slack-local-service'
import type { SocketModeSocket } from '../../../slack-local/slack-socket-mode-client'
import { SlackLocalTokenStore } from '../../../slack-local/slack-local-token-store'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcCallerScope } from '../callers/rpc-caller-scope'
import type { RpcDispatchStreamingOptions } from '../dispatch/dispatcher-stream-options'
import { RpcDispatcher } from '../dispatcher'
import { BOT_SLACK_LOCAL_METHODS } from './bots-slack-local'

// Alphanumeric marks inside token-shaped strings, so JSON escaping cannot hide them.
const BOT_MARK = 'BOTMARKQ7X41'
const APP_MARK = 'APPMARKQ7X42'
const BOT_TOKEN = `xoxb-1-${BOT_MARK}-aaaa`
const APP_TOKEN = `xapp-1-${APP_MARK}-bbbb`
const leaks = (text: string): boolean => text.includes(BOT_MARK) || text.includes(APP_MARK)

// Not base64 or plain: a store that skipped sealing would write something else.
const keyring: SecretStore = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`SEALED:${Buffer.from(text).toString('hex')}`),
  decryptString: (cipher) =>
    Buffer.from(cipher.toString().slice('SEALED:'.length), 'hex').toString(),
  describeProtectionGap: () => null,
  describeSealing: () => ({ kind: 'os-keychain' })
}

let dir: string
let runtime: OrcaRuntimeService
let service: SlackLocalService
let botId: string
let events: unknown[]
let logged: string[]
// What the fake Slack answers next, by method; the default answers say who the tokens are.
let slackAnswer: Partial<Record<string, () => Promise<Response>>>

const slackFetch: typeof fetch = async (input) => {
  const method = String(input).split('/').pop() ?? ''
  const answer = slackAnswer[method]
  if (answer) {
    delete slackAnswer[method]
    return answer()
  }
  if (method === 'auth.test') {
    return Response.json({ ok: true, team_id: 'T0TEAM01', user_id: 'U0BOT001', bot_id: 'B0BOT001' })
  }
  if (method === 'bots.info') {
    return Response.json({ ok: true, bot: { app_id: 'A0APP001' } })
  }
  if (method === 'users.info') {
    return Response.json({ ok: true, user: { id: 'U0OWNER1', team_id: 'T0TEAM01' } })
  }
  return Response.json({ ok: true, url: 'wss://slack.test/socket' })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-slack-local-dispatch-'))
  const store = createSqliteTestStore(Store, { dataFile: join(dir, 'db', 'data.json') })
  runtime = new OrcaRuntimeService(store)
  const bot: Bot = {
    ...newBotRecord({ name: 'Probe' }, Date.now()),
    // A folder no bots root has, so its (absent) home is only ever read.
    folder: `orca-slack-local-dispatch-${randomUUID()}`,
    folderWorkspaceId: ''
  }
  store.saveBot(bot)
  botId = bot.id
  slackAnswer = {}
  service = new SlackLocalService({
    runtime,
    store,
    tokens: new SlackLocalTokenStore(join(dir, 'slack-local'), () => keyring),
    fetch: slackFetch,
    // Socket Mode says hello as the bot token's app, and stays open.
    socketFactory: (): SocketModeSocket => ({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only 'message' listeners are called, with a Buffer as ws does.
      on: ((event: string, listener: (data: Buffer) => void) => {
        if (event === 'message') {
          const hello = { type: 'hello', connection_info: { app_id: 'A0APP001' } }
          queueMicrotask(() => listener(Buffer.from(JSON.stringify(hello))))
        }
      }) as SocketModeSocket['on'],
      send: () => {},
      ping: () => {},
      terminate: () => {}
    })
  })
  setSlackLocalService(service)
  events = []
  // What paired clients get: `runtime.clientEvents.subscribe` forwards this stream.
  runtime.onClientEvent((event) => events.push(event))
  logged = []
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    // As the console prints them, so an Error's message and stack count too.
    vi.spyOn(console, level).mockImplementation((...args) => logged.push(format(...args)))
  }
})
afterEach(() => {
  service.stop()
  setSlackLocalService(null)
  vi.useRealTimers()
  vi.restoreAllMocks()
  closeTestStores()
  rmSync(dir, { recursive: true, force: true })
})

const PAIRED_PERSON: RpcDispatchStreamingOptions = { pairedDeviceId: 'mac', clientCapabilities: [] }
const PAIRED_AGENT: RpcDispatchStreamingOptions = {
  pairedDeviceId: 'mac',
  clientCapabilities: [CLI_AGENT_CALLER_CLIENT_CAPABILITY]
}
const LOCAL_CLI: RpcDispatchStreamingOptions = { caller: { kind: 'local-cli' } }
const PAIRED_SCOPE: RpcCallerScope = { kind: 'runtime-paired', grants: [] }

function dispatch(
  method: string,
  params: Record<string, unknown>,
  transport: RpcDispatchStreamingOptions,
  callerScope: RpcCallerScope = PAIRED_SCOPE
) {
  return new RpcDispatcher({ runtime, methods: BOT_SLACK_LOCAL_METHODS, callerScope }).dispatch(
    { id: method, authToken: 'tok', method, params: { botId, ...params } },
    transport
  )
}

const saved = () => runtime.bots.list().find((entry) => entry.id === botId)
const tokenFile = () => join(dir, 'slack-local', `${botId}.sealed`)

const CHANGES: [string, Record<string, unknown>][] = [
  ['bots.slackLocal.status', {}],
  ['bots.slackLocal.useLocal', {}],
  ['bots.slackLocal.setTokens', { botToken: BOT_TOKEN, appToken: APP_TOKEN }],
  ['bots.slackLocal.setOwner', { expectedTeamId: 'T0TEAM01', ownerUserId: 'U0OWNER1' }],
  ['bots.slackLocal.addAskers', { expectedTeamId: 'T0TEAM01', askers: [{ id: 'U0ASKER1' }] }],
  ['bots.slackLocal.useOrca', { forgetTokens: true }]
]

it('lets a person on a paired computer do every step, and refuses the CLI and a phone', async () => {
  const before = JSON.stringify(saved())
  const refused: unknown[] = []
  for (const [method, params] of CHANGES) {
    for (const transport of [PAIRED_AGENT, LOCAL_CLI]) {
      const answer = await dispatch(method, params, transport)
      expect(answer.ok).toBe(false)
      refused.push(answer)
    }
    const phone = await dispatch(method, params, PAIRED_PERSON, { kind: 'mobile' })
    expect(phone.ok).toBe(false)
    refused.push(phone)
  }
  expect(JSON.stringify(saved())).toBe(before)
  expect(readdirSync(dir)).not.toContain('slack-local')

  const answers: unknown[] = []
  for (const [method, params] of CHANGES.slice(0, 5)) {
    const answer = await dispatch(method, params, PAIRED_PERSON)
    expect(answer, method).toMatchObject({ ok: true })
    answers.push(answer)
  }
  expect(saved()?.slackConnection).toMatchObject({
    mode: 'local',
    teamId: 'T0TEAM01',
    botUserId: 'U0BOT001',
    appId: 'A0APP001'
  })
  // Sealed by the keyring: exactly its bytes behind the envelope, and they open to the pair.
  const sealed = readFileSync(tokenFile(), 'utf8')
  expect(sealed.startsWith('orca-slack-local-v1:')).toBe(true)
  const inner = Buffer.from(sealed.slice('orca-slack-local-v1:'.length), 'base64').toString()
  expect(inner.startsWith('SEALED:')).toBe(true)
  expect(leaks(sealed)).toBe(false)
  expect(JSON.parse(keyring.decryptString(Buffer.from(inner)))).toMatchObject({
    botToken: BOT_TOKEN,
    appToken: APP_TOKEN
  })

  const back = await dispatch(...CHANGES[5], PAIRED_PERSON)
  expect(back).toMatchObject({ ok: true })
  answers.push(back)
  expect(saved()?.slackConnection?.mode).not.toBe('local')
  expect(readdirSync(join(dir, 'slack-local'))).toEqual([])

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  // Past the debounce of bot change notices, so a queued event would have gone out.
  await vi.advanceTimersByTimeAsync(2_000)
  expect(leaks(JSON.stringify([...refused, ...answers]))).toBe(false)
  expect(logged.some(leaks)).toBe(false)
  expect(leaks(JSON.stringify(events))).toBe(false)
})

it('tells a host without the Electron runtime (orcad) how to run it', async () => {
  setSlackLocalService(null)
  expect(await dispatch('bots.slackLocal.status', {}, PAIRED_PERSON)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining('ORCA_SERVE_RUNTIME=electron') }
  })
})

it('says why Slack refused new tokens without passing on what Slack or the network said', async () => {
  expect(leaks(format(new Error(BOT_TOKEN)))).toBe(true)
  await dispatch('bots.slackLocal.useLocal', {}, PAIRED_PERSON)
  expect(
    await dispatch(
      'bots.slackLocal.setTokens',
      { botToken: BOT_TOKEN, appToken: APP_TOKEN },
      PAIRED_PERSON
    )
  ).toMatchObject({ ok: true })
  const kept = readFileSync(tokenFile())
  const failures = [
    // A Slack error string that echoes a token.
    async () => Response.json({ ok: false, error: BOT_TOKEN }),
    // A network failure whose cause code carries one.
    async () => {
      throw new Error('fetch failed', { cause: { code: APP_TOKEN } })
    }
  ]
  const answers: unknown[] = []
  for (const failure of failures) {
    slackAnswer['auth.test'] = failure
    const answer = await dispatch(
      'bots.slackLocal.setTokens',
      { botToken: `xoxb-2-${BOT_MARK}-cccc`, appToken: `xapp-2-${APP_MARK}-dddd` },
      PAIRED_PERSON
    )
    expect(answer.ok).toBe(false)
    answers.push(answer, await dispatch('bots.slackLocal.status', {}, PAIRED_PERSON))
    // The pair saved before stays as it was.
    expect(readFileSync(tokenFile()).equals(kept)).toBe(true)
  }
  expect(JSON.stringify(answers)).toContain('unknown_error')
  expect(JSON.stringify(answers)).toContain('network')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await vi.advanceTimersByTimeAsync(2_000)
  expect(leaks(JSON.stringify(answers))).toBe(false)
  expect(logged.some(leaks)).toBe(false)
  expect(leaks(JSON.stringify(events))).toBe(false)
})
