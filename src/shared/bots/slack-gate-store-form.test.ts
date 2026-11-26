// What a build from before channel messages, rules scripts and limits makes of a gate this build stores:
// read with that build's own schema, rules checker and verdict (its files kept word for word in
// __fixtures__, imported as they are), the gate survives and every checked message is blocked, valid answers and errors alike; a
// note only drops out; and a chat a channel message opened is not a conversation it can read.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { effectiveSlackGate, type BotSlackGateEdit } from './bot-slack-gate'
import { SLACK_GATE_RULES_EXAMPLES } from './slack-gate-default-rules'
import type { SlackGateRulesConfig } from './slack-gate-rules-config'
import { isBlockAllStandIn, oldSchemaView, toStoredSlackGate } from './slack-gate-store-form'
import {
  localSlackConversation,
  parseLocalSlackConversation
} from '../connectors/local-slack-conversation'

// The release before this change (fork-v1.4.278-1, 0c7981d43ef); its files as that build has them.
const BASE = 'fork-v1.4.278-1'
const FIXTURES = join(__dirname, '__fixtures__', `gate-${BASE}`)
const OLD_FILES = [
  'src/shared/bots/bot-slack-gate.ts',
  'src/shared/bots/slack-gate-rules-config.ts',
  'src/shared/bots/slack-gate-rules-validate.ts',
  'src/shared/bots/slack-gate-rules-validate-rules.ts',
  'src/shared/bots/slack-gate-rules-issues.ts',
  'src/main/bots/slack-gate/slack-gate-rules.ts',
  'src/main/bots/slack-gate/slack-gate-openai.ts',
  'src/shared/bots/slack-gate-openai-request.ts',
  'src/main/lib/unread-response-body.ts',
  'src/shared/connectors/local-slack-conversation.ts'
]

/** What the old schema reads back of an OpenAI gate (only what these tests look at). */
type OldGate = { onError: string; openai: SlackGateRulesConfig }

type OldModules = {
  schema: {
    BotSlackGateSchema: { safeParse: (value: unknown) => { success: boolean; data: OldGate } }
  }
  rules: { decideSlackGateRules: (config: unknown, answers: unknown) => { wake: boolean } }
  conversation: { parseLocalSlackConversation: (id: string) => unknown }
}
let old: OldModules

beforeAll(async () => {
  const root = join(process.cwd(), 'node_modules', '.cache', `old-gate-${BASE}`)
  for (const file of OLD_FILES) {
    const text = readFileSync(join(FIXTURES, `${file}.txt`), 'utf8')
    mkdirSync(join(root, file, '..'), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  old = {
    schema: await import(join(root, 'src/shared/bots/bot-slack-gate.ts')),
    rules: await import(join(root, 'src/main/bots/slack-gate/slack-gate-rules.ts')),
    conversation: await import(join(root, 'src/shared/connectors/local-slack-conversation.ts'))
  }
})

const base = {
  on: true,
  appliesTo: ['thread_reply' as const],
  timeoutSeconds: 5,
  onError: 'wake' as const
}

describe('a stored gate read by the build before it', () => {
  it('keeps a gate with limits or a rules script, and blocks every checked message, errors included', () => {
    const limits: BotSlackGateEdit = {
      ...base,
      kind: 'openai',
      openai: SLACK_GATE_RULES_EXAMPLES.find((example) => example.id === 'banter')!.config
    }
    const script: BotSlackGateEdit = {
      ...base,
      kind: 'openai',
      openai: {
        questions: [{ type: 'predicate', name: 'q', instructions: 'Q?' }],
        rules: [{ question: 'q', wakeIf: { atLeast: 0.5 } }]
      },
      rulesCommand: 'node rules.mjs'
    }
    for (const edit of [limits, script]) {
      const stored = toStoredSlackGate(edit)
      const read = old.schema.BotSlackGateSchema.safeParse(JSON.parse(JSON.stringify(stored)))
      expect(read.success).toBe(true)
      // Its error policy blocks too, and every valid answer of its rules blocks.
      expect(read.data.onError).toBe('block')
      expect(isBlockAllStandIn(read.data.openai)).toBe(true)
      for (const value of [0, 0.5, 1]) {
        const answers = { orca_needs_newer_build: { type: 'predicate', value } }
        expect(old.rules.decideSlackGateRules(read.data.openai, answers).wake).toBe(false)
      }
      // This build runs the real rules and policy.
      expect(effectiveSlackGate(stored)).toEqual(edit)
      expect(oldSchemaView(stored)).toEqual(JSON.parse(JSON.stringify(read.data)))
    }
  })

  it('drops only a note, and reads a gate without newer fields exactly as before', () => {
    const noted: BotSlackGateEdit = {
      ...base,
      kind: 'openai',
      openai: {
        questions: [{ type: 'predicate', name: 'q', instructions: 'Q?' }],
        rules: [{ question: 'q', wakeIf: { atLeast: 0.5 }, note: 'asked' }]
      }
    }
    const stored = toStoredSlackGate(noted)
    const read = old.schema.BotSlackGateSchema.safeParse(JSON.parse(JSON.stringify(stored)))
    expect(read.success).toBe(true)
    expect(read.data.openai.rules).toEqual([{ question: 'q', wakeIf: { atLeast: 0.5 } }])
    expect(read.data.onError).toBe('wake')
    const plain: BotSlackGateEdit = { ...base, kind: 'command', command: 'check' }
    expect(toStoredSlackGate(plain)).toEqual(plain)
    // Channel messages drop out; a gate that checks only them is no gate there (it checked none of
    // the cases that build knows).
    const channels = toStoredSlackGate({ ...plain, channelMessages: { channels: ['C0123'] } })
    expect(old.schema.BotSlackGateSchema.safeParse(channels).data).toEqual(plain)
    const onlyChannels = toStoredSlackGate({
      ...plain,
      appliesTo: [],
      channelMessages: { channels: ['C0123'] }
    })
    expect(old.schema.BotSlackGateSchema.safeParse(onlyChannels).success).toBe(false)
    expect(oldSchemaView(onlyChannels)).toBeNull()
  })

  it('cannot read a chat a channel message opened, so its thread’s replies are none of its own', () => {
    const place = {
      teamId: 'T1',
      channelId: 'C1',
      threadTs: '1800000000.000100',
      botUserId: 'U0BOT'
    }
    const channel = localSlackConversation({ ...place, channel: true }).externalId
    expect(channel.endsWith(':c')).toBe(true)
    expect(parseLocalSlackConversation(channel)).toEqual({ ...place, channel: true })
    expect(old.conversation.parseLocalSlackConversation(channel)).toBeNull()
    expect(
      old.conversation.parseLocalSlackConversation(localSlackConversation(place).externalId)
    ).toEqual(place)
  })
})
