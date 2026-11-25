// A Slack automation event blocked by its bot's wake gate: one run born skipped, holding no words.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { AutomationRunEvent } from '../../shared/automation-event-triggers'
import type { PersistedState } from '../../shared/orca-profiles/persisted-state-types'
import { createAutomationRun } from '../persistence/scheduling-automations/automation-run-operations'
import {
  runForEvent,
  type AutomationTriggerRunContext,
  type EventStartGate
} from './automation-trigger-runs'

const NOW = 1_800_000_000_000
beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
})
afterEach(() => {
  vi.useRealTimers()
})

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: admission reads only these automation fields.
const automation = {
  id: 'a1',
  name: 'Triage',
  enabled: true,
  createdAt: 0,
  missedRunGraceMinutes: 60,
  workspaceId: 'w1',
  bot: { botId: 'bot1' },
  on: [{ id: 'r1', source: 'slack', event: 'message' }]
} as unknown as Automation

const event: AutomationRunEvent = {
  triggerId: 'r1',
  source: 'slack',
  event: 'message',
  key: 'slack:T1:C1:1.1',
  occurredAt: NOW,
  text: 'private words',
  actorId: 'U1'
}

function context(refusalDelay?: () => void) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: run creation reads only automationRuns.
  const state = { automationRuns: [] } as unknown as PersistedState
  const flush = vi.fn()
  const operations = {
    state,
    flush,
    recordManualRun: () => {},
    getWorkspaceDisplayName: () => null
  }
  const runs = (): AutomationRun[] => state.automationRuns ?? []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: event admission calls only these members.
  const ctx = {
    store: {
      listAutomations: () => [automation],
      listAutomationRuns: () => runs(),
      getLatestAutomationOccurrence: () => null
    },
    runs: {
      createRun: async (
        ...args: Parameters<typeof createAutomationRun> extends [unknown, ...infer R] ? R : never
      ) => createAutomationRun(operations, ...args),
      updateRun: vi.fn(),
      repeatSkip: vi.fn(async () => null),
      foldEvent: vi.fn(async () => null),
      advanceNextRun: vi.fn()
    },
    wakeGateDelayMs: 0,
    inLane: (_id: string, operation: () => Promise<unknown>) => operation(),
    describeRefusal: async () => {
      refusalDelay?.()
      return null
    },
    resolveTarget: () => ({ ok: true }),
    dispatch: vi.fn(),
    launch: vi.fn(),
    once: null
  } as unknown as AutomationTriggerRunContext
  return { ctx, runs, flush }
}

describe('a wake-gated automation event', () => {
  it('is recorded once as skipped_precheck without its text, in one flush, and deduped on resend', async () => {
    const { ctx, runs, flush } = context()
    const gate: EventStartGate = {
      created: () => {},
      reserve: vi.fn(async () => ({
        skipped: { error: 'Slack wake gate blocked this event.', precheckResult: null }
      }))
    }
    const run = await runForEvent(ctx, 'a1', event, gate)
    expect(run).toMatchObject({
      status: 'skipped_precheck',
      error: 'Slack wake gate blocked this event.'
    })
    expect(runs()).toHaveLength(1)
    expect(runs()[0].event?.text).toBeUndefined()
    expect(runs()[0].event?.key).toBe(event.key)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(ctx.dispatch).not.toHaveBeenCalled()
    await runForEvent(ctx, 'a1', event, gate)
    expect(runs()).toHaveLength(1)
    expect(gate.reserve).toHaveBeenCalledTimes(1)
  })

  it('writes nothing when its delivery expired in the lane or during the target check', async () => {
    for (const expireAt of ['entry', 'refusal'] as const) {
      let expired = expireAt === 'entry'
      const { ctx, runs } = context(() => (expired = true))
      const gate: EventStartGate = {
        created: () => {},
        expired: () => expired,
        reserve: vi.fn(async () => ({ refused: true as const }))
      }
      expect(await runForEvent(ctx, 'a1', event, gate)).toBeNull()
      expect(runs()).toHaveLength(0)
      expect(gate.reserve).not.toHaveBeenCalled()
    }
  })
})
