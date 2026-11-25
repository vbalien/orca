// The Slack wake gate in a conversation's lane, through the real seam, receipts and links: only the
// bot's agent host is missing, so anything that got past the gate would be refused bot_not_found.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type {
  ConnectorConversation,
  ConnectorDelivery
} from '../../shared/connectors/connector-cloud-contract'
import type { BotSlackGate } from '../../shared/bots/bot-slack-gate'
import { DeliveryReceipts } from '../external-conversations/external-conversation-delivery-receipts'
import type { ExternalConversationHost } from '../external-conversations/external-conversation-host'
import { findLink, writeLink } from '../external-conversations/external-conversation-links'
import { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import {
  SlackGateDecider,
  type decideSlackWake,
  type SlackWakeDecision
} from '../bots/slack-gate/slack-gate'
import { askSlackGateJev } from '../bots/slack-gate/slack-gate-jev'
import { ConnectorDeliveryAcks } from './connector-delivery-acks'
import { dispatchDelivery, type DispatchMachine } from './connector-deliveries'
import { createConnectorWakeGate, type WakeGateBot } from './connector-wake-gate'
import { slackGateCaseOf } from './connector-wake-gate-event'
import { fakeMachine } from './fake-connector-seam.test-fixture'

type Start = Extract<ConnectorDelivery, { kind: 'start' }>
type Send = Extract<ConnectorDelivery, { kind: 'send' }>

const NOW = 1_800_000_000_000
const DEADLINE = NOW + 60_000
const THREAD = 'T1:C1:1800000000.000100'
const LINKED: ConnectorConversation = { source: 'slack', externalId: `${THREAD}:U0BOT` }
const FRESH: ConnectorConversation = {
  source: 'slack',
  externalId: 'T1:C1:1800000000.000500:U0BOT'
}
const DM: ConnectorConversation = { source: 'slack', externalId: 'T1:D9' }

const gate = (fields: Partial<Extract<BotSlackGate, { kind: 'command' }>> = {}): BotSlackGate => ({
  on: true,
  kind: 'command',
  command: 'check',
  appliesTo: ['mention', 'dm', 'thread_reply'],
  timeoutSeconds: 5,
  onError: 'wake',
  ...fields
})
const bot = (fields: Partial<WakeGateBot> = {}): WakeGateBot => ({
  id: 'bot1',
  name: 'Reviewer',
  paused: false,
  slackGate: gate(),
  ...fields
})

let n = 0
const asker = (
  ts: string,
  place: 'public_channel' | 'direct_message' = 'public_channel'
): NonNullable<Send['asker']> => ({
  userId: 'U1',
  role: 'member',
  place: { kind: place, id: place === 'direct_message' ? 'D9' : 'C1' },
  text: 'please look',
  context: [],
  messageRef: `slack:T1:C1:${ts}:${ts}`
})
const start = (conversation: ConnectorConversation, extra: Partial<Start> = {}): Start => ({
  kind: 'start',
  deliveryId: `s${++n}`,
  expiresAt: 1_900_000_000_000,
  conversation,
  agent: 'claude',
  placeId: Buffer.from(JSON.stringify(['bot', 'bot1'])).toString('base64url'),
  prompt: 'please look',
  asker: asker('1800000000.000500'),
  ...extra
})
const send = (conversation: ConnectorConversation, extra: Partial<Send> = {}): Send => ({
  kind: 'send',
  deliveryId: `d${++n}`,
  expiresAt: 1_900_000_000_000,
  conversation,
  text: 'more',
  asker: asker('1800000000.000600'),
  ...extra
})

let orchestration: OrchestrationDb
beforeEach(() => {
  // Only the clock is fixed; the lane's timers and promises run for real.
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-wake-gate-'))
  orchestration = new OrchestrationDb(join(testState.dir, 'orchestration.db'))
})
afterEach(async () => {
  vi.useRealTimers()
  orchestration.close()
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

/** A bot home holding LINKED, to bot1 or (null) to no bot. */
async function home(
  linkBot: { kind: 'bot'; botId: string } | null = { kind: 'bot', botId: 'bot1' }
) {
  const store = createStore()
  const group = store.createProjectGroup({
    name: 'Bots',
    parentPath: testState.dir,
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'manual'
  })
  const folder = store.createFolderWorkspace({
    projectGroupId: group.id,
    folderPath: testState.dir
  })
  writeLink(
    store,
    { worktreeId: folderWorkspaceKey(folder.id), sshHostId: null },
    {
      ...LINKED,
      sessionId: 'session-bot1',
      agent: 'claude',
      paneKey: 'pane-1',
      ...(linkBot ? { bot: linkBot } : {}),
      createdAt: 1
    }
  )
  await store.flushPendingOrThrowAsync()
  return store
}

const HOST: ExternalConversationHost = {
  bots: {
    refusal: () => 'bot_not_found',
    open: async () => {
      throw new Error('no chat in this test')
    },
    workLinks: async () => []
  }
}

function connector(
  store: ReturnType<typeof createStore>,
  bots: WakeGateBot[],
  decide: typeof decideSlackWake
) {
  const receipts = new DeliveryReceipts(() => orchestration)
  const seam = new ExternalConversationSeam({
    store,
    receipts,
    onWorkspaceRemoved: () => () => {},
    readHookRow: () => null,
    onAgentPaneChange: () => () => {}
  })
  const wakeGate = createConnectorWakeGate({
    bots: () => bots,
    botsEnabled: () => true,
    linkedBot: (key) => findLink(store, key)?.link.bot?.botId ?? null,
    mentionsKnown: () => true,
    heldStart: (key) => receipts.heldStart(key),
    decide
  })
  const machine: DispatchMachine = {
    runTrigger: async () => false,
    wakeGate: wakeGate.wakeGate
  }
  const deliver = (raw: unknown) => dispatchDelivery(seam, HOST, machine, raw, () => 60_000)?.done
  return { seam, receipts, deliver, wakeGate }
}

const verdict = (wake: boolean): SlackWakeDecision => ({
  verdict: wake ? 'wake' : 'block',
  reason: wake ? 'passed' : 'blocked',
  durationMs: 1
})
const deciding = (wake: boolean) => vi.fn<typeof decideSlackWake>(async () => verdict(wake))

describe('classification', () => {
  it('marks only a thread-root start as a sure mention, and in-thread starts as unknown', () => {
    expect(slackGateCaseOf(start(FRESH), true)).toEqual({ case: 'mention' })
    expect(slackGateCaseOf(start(FRESH, { asker: asker('1800000000.000700') }), true)).toEqual({
      case: 'thread_reply',
      mentionUnknown: true
    })
    expect(slackGateCaseOf(start(DM, { asker: asker('1.2', 'direct_message') }), true)).toEqual({
      case: 'dm'
    })
    expect(slackGateCaseOf(send(LINKED, { mentioned: true }), true)).toEqual({ case: 'mention' })
    expect(slackGateCaseOf(send(LINKED), false)).toEqual({
      case: 'thread_reply',
      mentionUnknown: true
    })
  })
})

describe('the wake gate in the conversation lane', () => {
  it('holds a blocked start before any chat, replays it without deciding again, and recovers its thread', async () => {
    const store = await home()
    const decide = deciding(false)
    const { deliver, receipts } = connector(store, [bot()], decide)
    const blocked = start(FRESH)
    expect(await deliver(blocked)).toEqual({ outcome: 'accepted', held: true })
    expect(findLink(store, FRESH)).toBeNull()
    expect(await deliver(blocked)).toEqual({ outcome: 'accepted', held: true })
    expect(decide).toHaveBeenCalledTimes(1)
    expect(receipts.heldStart(FRESH)).toBe(true)
    expect(receipts.heldStart({ source: 'slack', externalId: `${FRESH.externalId}X` })).toBe(false)
    // A reply to the held thread asks the cloud for a new start, which the gate decides again.
    expect(await deliver(send(FRESH))).toEqual({ outcome: 'refused', reason: 'chat_gone' })
    // Any other unlinked conversation keeps today's answer.
    const other: ConnectorConversation = {
      source: 'slack',
      externalId: 'T1:C1:1800000000.000900:U0BOT'
    }
    expect(await deliver(send(other))).toEqual({
      outcome: 'refused',
      reason: 'external_conversation_not_found'
    })
  })

  it('decides a send queued behind a start only after the start was decided', async () => {
    const store = await home()
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    const decide = vi.fn<typeof decideSlackWake>(async () => {
      await held
      return verdict(false)
    })
    const { deliver } = connector(store, [bot()], decide)
    const first = deliver(start(FRESH))
    const second = deliver(send(FRESH))
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(1))
    release()
    expect(await first).toEqual({ outcome: 'accepted', held: true })
    // Had it run first it would have found no held start and answered not_found.
    expect(await second).toEqual({ outcome: 'refused', reason: 'chat_gone' })
  })

  it('blocks a linked reply for its gated bot, and leaves a link without a bot alone', async () => {
    const decide = deciding(false)
    const gated = connector(await home(), [bot()], decide)
    expect(await gated.deliver(send(LINKED))).toEqual({ outcome: 'accepted', held: true })
    expect(decide.mock.calls[0]?.[1]).toMatchObject({ case: 'thread_reply', text: 'please look' })

    await closeTestStores()
    const untouched = deciding(false)
    const plain = connector(await home(null), [bot()], untouched)
    const admit = plain.wakeGate.wakeGate(send(LINKED), [], DEADLINE)
    expect(await admit?.(new AbortController().signal, {})).toBeNull()
    expect(untouched).not.toHaveBeenCalled()
  })

  it('never gates Linear, a resume, an ungated or a paused bot', async () => {
    const store = await home()
    const decide = deciding(false)
    const { wakeGate } = connector(store, [bot({ slackGate: gate({ on: false }) })], decide)
    expect(
      wakeGate.wakeGate(send({ source: 'linear', externalId: 'x' }), [], DEADLINE)
    ).toBeUndefined()
    expect(wakeGate.wakeGate(send(LINKED, { resume: { turnId: 1 } }), [], DEADLINE)).toBeUndefined()
    expect(wakeGate.wakeGate(send(LINKED), [], DEADLINE)).toBeUndefined()

    const paused = connector(store, [bot({ paused: true })], decide)
    const admit = paused.wakeGate.wakeGate(send(LINKED), [], DEADLINE)
    expect(await admit?.(new AbortController().signal, { botId: 'bot1' })).toBeNull()
    expect(decide).not.toHaveBeenCalled()
  })

  it('refuses a Stop and answers expired instead of applying a late verdict', async () => {
    const store = await home()
    const stop = new AbortController()
    const decide = vi.fn<typeof decideSlackWake>(async () => {
      stop.abort('conversation_cancelled')
      return verdict(true)
    })
    const { wakeGate } = connector(store, [bot()], decide)
    const admit = wakeGate.wakeGate(send(LINKED), [], DEADLINE)
    expect(await admit?.(stop.signal, { botId: 'bot1' })).toEqual({
      outcome: 'refused',
      reason: 'conversation_cancelled'
    })
    const late = wakeGate.wakeGate(send(LINKED), [], NOW - 1)
    expect(await late?.(new AbortController().signal, { botId: 'bot1' })).toEqual({
      outcome: 'refused',
      reason: 'delivery_expired'
    })
  })

  it('splits a batch where a gate would judge the messages apart, and only there', async () => {
    const store = await home()
    const gated = connector(store, [bot()], deciding(true)).wakeGate
    expect(gated.wakeGateApart(send(LINKED), send(LINKED, { mentioned: true }))).toBe(true)
    expect(gated.wakeGateApart(send(LINKED), send(LINKED))).toBe(false)
    const plain = connector(store, [bot({ slackGate: undefined })], deciding(true)).wakeGate
    expect(plain.wakeGateApart(send(LINKED), send(LINKED, { mentioned: true }))).toBe(false)
  })
})

describe('the held start receipt across restarts and pruning', () => {
  it('still answers chat_gone after a restart, and not_found once the ledger dropped the receipt', async () => {
    const store = await home()
    const blocked = connector(store, [bot()], deciding(false))
    expect(await blocked.deliver(start(FRESH))).toEqual({ outcome: 'accepted', held: true })
    orchestration.close()
    orchestration = new OrchestrationDb(join(testState.dir, 'orchestration.db'))
    const restarted = connector(store, [bot()], deciding(false))
    expect(await restarted.deliver(send(FRESH))).toEqual({
      outcome: 'refused',
      reason: 'chat_gone'
    })

    // Older than the ledger keeps: the next receipt's admission prunes it.
    orchestration.db
      .prepare(`UPDATE mutation_receipts SET updated_at = datetime('now', '-31 days')`)
      .run()
    await restarted.deliver(start({ source: 'slack', externalId: 'T1:C1:1800000000.000800:U0BOT' }))
    expect(restarted.receipts.heldStart(FRESH)).toBe(false)
    expect(await restarted.deliver(send(FRESH))).toEqual({
      outcome: 'refused',
      reason: 'external_conversation_not_found'
    })
  })

  it('loses the receipt to capacity pruning before 30 days when the ledger is full', async () => {
    const store = await home()
    const { deliver, receipts } = connector(store, [bot()], deciding(false))
    expect(await deliver(start(FRESH))).toEqual({ outcome: 'accepted', held: true })
    orchestration.db
      .prepare(`UPDATE mutation_receipts SET updated_at = datetime('now', '-1 day')`)
      .run()
    orchestration.db
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
         INSERT INTO mutation_receipts
           (caller_fingerprint, request_id, method, payload_hash, state, receipt)
         SELECT 'filler', 'r' || i, 'filler', 'h', 'completed', '{}' FROM n`
      )
      .run()
    await deliver(start({ source: 'slack', externalId: 'T1:C1:1800000000.000800:U0BOT' }))
    expect(receipts.heldStart(FRESH)).toBe(false)
    expect(await deliver(send(FRESH))).toEqual({
      outcome: 'refused',
      reason: 'external_conversation_not_found'
    })
  })
})

describe('acks of a held delivery', () => {
  it('confirms it by done alone, without held on the wire', async () => {
    const store = await home()
    const { seam, wakeGate } = connector(store, [bot()], deciding(false))
    const sent: unknown[] = []
    const acks = new ConnectorDeliveryAcks({
      seam,
      host: HOST,
      machine: { ...fakeMachine(() => null), wakeGate: wakeGate.wakeGate },
      send: async (batch) => {
        sent.push(...batch)
        return null
      },
      helloRev: () => 1,
      random: () => 0,
      signal: new AbortController().signal,
      outbox: () => 'account-1'
    })
    acks.deliverAll([start(FRESH)], () => 60_000)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent).toEqual([
      { deliveryId: expect.any(String), step: 'done', result: { outcome: 'accepted' } }
    ])
  })

  it('answers a delivery whose deadline passed before its gate ran expired, done only', async () => {
    const store = await home()
    const decide = deciding(true)
    const { seam, wakeGate } = connector(store, [bot()], decide)
    const sent: unknown[] = []
    const acks = new ConnectorDeliveryAcks({
      seam,
      host: HOST,
      machine: { ...fakeMachine(() => null), wakeGate: wakeGate.wakeGate },
      send: async (batch) => {
        sent.push(...batch)
        return null
      },
      helloRev: () => 1,
      random: () => 0,
      signal: new AbortController().signal,
      outbox: () => 'account-1'
    })
    // Just enough time left to be taken, none left for its gate.
    acks.deliverAll([start(FRESH)], () => 10_000)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent).toEqual([
      { deliveryId: expect.any(String), step: 'done', result: { outcome: 'expired' } }
    ])
    expect(decide).not.toHaveBeenCalled()
    expect(findLink(store, FRESH)).toBeNull()
  })

  it('holds a blocked batch, and replays it after a restart without deciding again', async () => {
    const store = await home()
    const acked = async (decide: typeof decideSlackWake, raws: unknown[]) => {
      const { seam, wakeGate } = connector(store, [bot()], decide)
      const sent: unknown[] = []
      const acks = new ConnectorDeliveryAcks({
        seam,
        host: HOST,
        machine: { ...fakeMachine(() => null), wakeGate: wakeGate.wakeGate },
        send: async (batch) => {
          sent.push(...batch)
          return null
        },
        helloRev: () => 1,
        random: () => 0,
        signal: new AbortController().signal,
        outbox: () => 'account-1'
      })
      acks.deliverAll(raws, () => 60_000)
      await vi.waitFor(() => expect(sent).toHaveLength(raws.length))
      return sent
    }
    const head = start(FRESH)
    // The same person's reply right behind it: one turn, one verdict.
    const follower = send(FRESH, { asker: { ...asker('1800000000.000600'), userId: 'U1' } })
    const doneOnly = [
      { deliveryId: head.deliveryId, step: 'done', result: { outcome: 'accepted' } },
      { deliveryId: follower.deliveryId, step: 'done', result: { outcome: 'accepted' } }
    ]
    const decide = deciding(false)
    // Done only, in any order: never a `received` for a request nothing took.
    expect(await acked(decide, [head, follower])).toEqual(expect.arrayContaining(doneOnly))
    expect(decide).toHaveBeenCalledTimes(1)

    orchestration.close()
    orchestration = new OrchestrationDb(join(testState.dir, 'orchestration.db'))
    const again = deciding(true)
    expect(await acked(again, [head, follower])).toEqual(expect.arrayContaining(doneOnly))
    expect(again).not.toHaveBeenCalled()
    expect(findLink(store, FRESH)).toBeNull()
  })
})

describe('a Jev gate with rules on the cloud path', () => {
  it('asks TypeSafe with the configured questions and state, and holds what the rules block', async () => {
    const bodies: { state: Record<string, unknown>; questions: unknown }[] = []
    let chat = 0.95
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({
        answers: { asks: { type: 'noul', noul: 0.9 }, chat: { type: 'noul', noul: chat } }
      })
    })
    const decider = new SlackGateDecider({
      readKey: async () => 'k1',
      now: Date.now,
      askJev: (input) => askSlackGateJev({ ...input, fetch }),
      runCommand: () => {
        throw new Error('unused')
      }
    })
    const rules: BotSlackGate = {
      ...gate(),
      kind: 'jev',
      appliesTo: ['mention', 'thread_reply'],
      jev: {
        questions: { asks: { type: 'noul', instructions: 'Asks?' }, chat: { type: 'noul' } },
        send: { message: true, earlierMessages: true, botName: true },
        rules: [
          { question: 'asks', wakeIf: { atLeast: 0.7 } },
          { question: 'chat', blockIf: { atLeast: 0.8 } }
        ]
      }
    }
    const store = await home()
    const { deliver } = connector(store, [bot({ slackGate: rules })], (b, e, o) =>
      decider.decide(b, e, o)
    )
    const unreadable = { ...asker('1800000000.000500'), context: [{ kind: 'unreadable' as const }] }
    expect(await deliver(start(FRESH, { asker: unreadable }))).toEqual({
      outcome: 'accepted',
      held: true
    })
    expect(bodies[0]).toEqual({
      model: 'jev-latest',
      state: {
        message: 'please look',
        earlierMessages: ['(this thread could not be read)'],
        botName: 'Reviewer'
      },
      questions: rules.kind === 'jev' ? rules.jev.questions : null
    })
    chat = 0.1
    const fresh = { source: 'slack' as const, externalId: 'T1:C1:1800000000.000700:U0BOT' }
    // Woken, it goes on to the chat start (which this test's host has no chat for): never held.
    const woken = await deliver(start(fresh, { asker: asker('1800000000.000700') }))
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(woken).not.toEqual({ outcome: 'accepted', held: true })
  })
})
