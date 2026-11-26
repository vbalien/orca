// The OpenAI gate's JSON: what the editor and the host accept, where problems are, the exact request each
// config sends and how it is cut to OpenAI's input limits, and how a saved TypeSafe Jev gate now reads.
import { describe, expect, it } from 'vitest'
import {
  BotSlackGateSchema,
  SLACK_GATE_CONTEXT_MARKER_TEXT,
  type SlackGateEvent
} from './bot-slack-gate'
import { makeTestBot } from '../../main/bots/bot.test-fixture'
import { BotSchema, normalizePersistedBots } from '../bot-types'
import type { SlackGateRulesConfig } from './slack-gate-rules-config'
import { validateSlackGateRules } from './slack-gate-rules-validate'
import {
  fitSlackGateInput,
  SLACK_GATE_INPUT_MAX_BYTES,
  SLACK_GATE_INPUT_MAX_VALUES,
  slackGateOpenAIRequest
} from './slack-gate-openai-request'
import { formatSlackGateRulesText, parseSlackGateRulesText } from './slack-gate-rules-text'

const base: SlackGateRulesConfig = {
  questions: [{ type: 'predicate', name: 'asks', instructions: 'Asks the bot?' }],
  rules: [{ question: 'asks', wakeIf: { atLeast: 0.7 } }]
}
const codes = (value: unknown) => {
  const result = validateSlackGateRules(value)
  return result.ok ? [] : result.issues.map((issue) => `${issue.path.join('.')}:${issue.code}`)
}

describe('validateSlackGateRules', () => {
  it('accepts every question type in OpenAI’s own shape', () => {
    expect(
      codes({
        model: ' gpt-6-luna ',
        questions: [
          { type: 'predicate', name: 'asks_bot', instructions: 'Q?' },
          {
            type: 'choice',
            name: 'topic',
            instructions: 'Topic?',
            choices: [{ value: 'deploy', description: 'D' }, { value: true }, { value: 'true' }]
          },
          {
            type: 'score',
            name: 'urgency',
            instructions: 'How urgent?',
            levels: [{ label: 'Later' }, { label: 'Week', description: 'W' }, { label: 'Today' }]
          }
        ],
        send: { message: true, earlierMessages: 10, earlierSpeakers: true, botName: true },
        extra: { botRole: 'Reviews code', nested: { list: [1, 'two'] } },
        rules: [
          { question: 'asks_bot', wakeIf: { atLeast: 0.7 }, unsureFrom: 0.4 },
          { question: 'topic', wakeIf: { oneOf: ['deploy', true] } },
          { question: 'urgency', wakeIf: { atMost: 1 }, unsureFrom: 1.5 }
        ],
        combine: 'any',
        whenUnsure: 'wake'
      })
    ).toEqual([])
    const result = validateSlackGateRules({ ...base, model: '  ' })
    expect(result.ok && result.config).toEqual(base)
  })

  it('refuses what OpenAI or the rules cannot use, by field', () => {
    const predicate = (fields: Record<string, unknown>) => ({
      ...base,
      questions: [{ type: 'predicate', name: 'asks', instructions: 'Q?', ...fields }]
    })
    expect(codes(predicate({ name: undefined }))).toContain('questions.0.name:required')
    expect(codes(predicate({ name: '1bad' }))).toContain('questions.0.name:bad_name')
    expect(codes(predicate({ instructions: [{ type: 'input_text', text: 'x' }] }))).toEqual([
      'questions.0.instructions:not_string'
    ])
    expect(codes(predicate({ instructions: '  ' }))).toEqual(['questions.0.instructions:blank'])
    expect(codes(predicate({ hint: 'x' }))).toEqual(['questions.0.hint:unknown_key'])
    expect(codes(predicate({ type: 'noul' }))).toEqual(['questions.0.type:question_type'])
    expect(codes({ ...base, questions: { asks: base.questions[0] } })).toContain(
      'questions:not_array'
    )
    expect(codes({ ...base, questions: [base.questions[0], base.questions[0]] })).toEqual([
      'questions.1.name:duplicate_question'
    ])
    expect(codes({ ...base, prompt_cache_key: 'x' })).toEqual(['prompt_cache_key:unknown_key'])
    const choice = (choices: unknown, oneOf: unknown[] = ['a']) => ({
      questions: [{ type: 'choice', name: 't', instructions: 'T?', choices }],
      rules: [{ question: 't', wakeIf: { oneOf } }]
    })
    expect(codes(choice([{ value: 'a' }]))).toEqual(['questions.0.choices:count'])
    expect(codes(choice([{ value: 'a' }, { value: 'a' }]))).toEqual([
      'questions.0.choices.1.value:duplicate_choice'
    ])
    expect(codes(choice([{ value: 'a' }, { value: 1 }]))).toEqual([
      'questions.0.choices.1.value:not_choice_value'
    ])
    expect(codes(choice([{ value: 'a' }, { value: 'b' }], ['a', 'c', 'a', 1]))).toEqual([
      'rules.0.wakeIf.oneOf.1:unknown_choice',
      'rules.0.wakeIf.oneOf.2:duplicate_choice',
      'rules.0.wakeIf.oneOf.3:not_choice_value'
    ])
    expect(codes(choice([{ value: 'a' }, { value: true }], ['true']))).toEqual([
      'rules.0.wakeIf.oneOf.0:unknown_choice'
    ])
    const score = { type: 'score', name: 'u', instructions: 'U?', levels: [{ label: 'x' }] }
    expect(
      codes({ questions: [score], rules: [{ question: 'u', wakeIf: { atLeast: 0 } }] })
    ).toEqual(['questions.0.levels:count'])
    expect(
      codes({
        questions: [{ ...score, levels: [{ label: 'a' }, { label: 'b' }] }],
        rules: [{ question: 'u', wakeIf: { atLeast: 1.5 } }]
      })
    ).toEqual(['rules.0.wakeIf.atLeast:out_of_range'])
    expect(codes({ ...base, rules: [{ question: 'nope', wakeIf: { atLeast: 0.5 } }] })).toEqual([
      'rules.0.question:unknown_question',
      'questions.0:unused_question'
    ])
    expect(
      codes({
        ...base,
        rules: [{ question: 'asks', wakeIf: { atLeast: 0.5 }, blockIf: { atMost: 0.1 } }]
      })
    ).toEqual(['rules.0:one_effect'])
    expect(codes({ ...base, rules: [{ question: 'asks', wakeIf: { oneOf: ['a'] } }] })).toEqual([
      'rules.0.wakeIf.oneOf:condition_kind'
    ])
    expect(
      codes({ ...base, rules: [{ question: 'asks', wakeIf: { atLeast: 0.5 }, unsureFrom: 0.6 }] })
    ).toEqual(['rules.0.unsureFrom:unsure_side'])
    expect(
      codes({ ...base, send: { message: 'yes', earlierMessages: 51, channel: true } })
    ).toEqual([
      'send.channel:unknown_key',
      'send.message:not_boolean_or_number',
      'send.earlierMessages:out_of_range'
    ])
    expect(codes({ ...base, extra: { message: 'x' } })).toEqual(['extra.message:extra_collision'])
    // Past the kept problems, a broken question never counts as valid.
    const crowded = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`junk${i}`, 1]))
    const broken = {
      ...crowded,
      questions: [...base.questions, { type: 'choice', name: 't', instructions: 'T' }],
      rules: [...base.rules, { question: 't', wakeIf: { oneOf: ['x'] } }]
    }
    expect(parseSlackGateRulesText(JSON.stringify(broken)).ok).toBe(false)
    expect(
      codes({ ...base, rules: Array.from({ length: 5000 }, () => null) }).length
    ).toBeLessThanOrEqual(50)
    expect(codes({ ...base, combine: 'most' })).toEqual(['combine:enum'])
  })

  it('refuses infinite numbers, deep nesting and oversized configs', () => {
    expect(codes({ ...base, extra: { n: Number.POSITIVE_INFINITY } })).toEqual([
      'extra.n:not_finite'
    ])
    let deep: unknown = 1
    for (let level = 0; level < 9; level++) {
      deep = [deep]
    }
    expect(codes({ ...base, extra: { deep } })).toContain('extra.deep.0.0.0.0.0.0.0:too_deep')
    expect(codes({ ...base, extra: { big: 'x'.repeat(16 * 1024) } })).toEqual([':too_large'])
  })
})

describe('parseSlackGateRulesText', () => {
  it('places problems on their line, also in list items', () => {
    const text = JSON.stringify(
      {
        questions: [
          { type: 'predicate', name: 'a', instructions: 'A?' },
          { type: 'predicate', name: 'b', instructions: 'B?' }
        ],
        rules: [
          { question: 'a', wakeIf: { atLeast: 0.5 } },
          { question: 'b', wakeIf: { atLeast: 2 } }
        ]
      },
      null,
      2
    )
    const result = parseSlackGateRulesText(text)
    const issue = result.ok ? null : result.issues[0]
    expect(issue).toMatchObject({ path: ['rules', 1, 'wakeIf', 'atLeast'], code: 'out_of_range' })
    expect(text.split('\n')[(issue?.line ?? 0) - 1]).toContain('"atLeast": 2')
    const missing =
      '{\n  "questions": [\n    { "type": "choice", "name": "a", "instructions": "A" }\n  ],\n  "rules": [ { "question": "a", "wakeIf": { "oneOf": ["x"] } } ]\n}'
    const located = parseSlackGateRulesText(missing)
    expect(located.ok ? null : located.issues[0]).toMatchObject({ code: 'required', line: 3 })
  })

  it('opens every accepted config again as text it accepts', () => {
    const wide = { ...base, extra: { levels: { values: Array.from({ length: 6000 }, () => 0) } } }
    expect(validateSlackGateRules(wide).ok).toBe(true)
    expect(parseSlackGateRulesText(formatSlackGateRulesText(wide)).ok).toBe(true)
    expect(formatSlackGateRulesText(base)).toBe(JSON.stringify(base, null, 2))
  })

  it('refuses comments, trailing commas, duplicate keys and pathological input before parsing', () => {
    const ok = JSON.stringify(base)
    expect(parseSlackGateRulesText(ok).ok).toBe(true)
    for (const [text, code] of [
      ['{ // hi\n}', 'syntax'],
      [`${ok.slice(0, -1)},}`, 'syntax'],
      ['{ "rules": [], "rules": [] }', 'duplicate_key'],
      [`{ "extra": { "n": ${'['.repeat(20)}${']'.repeat(20)} } }`, 'too_deep'],
      [`{ "extra": { "s": "${'x'.repeat(70 * 1024)}" } }`, 'text_too_large'],
      [`${ok.slice(0, -1)}, "extra": { "n": 1e400 } }`, 'not_finite']
    ] as const) {
      const result = parseSlackGateRulesText(text)
      expect(result.ok ? null : result.issues[0]?.code).toBe(code)
    }
  })
})

describe('slackGateOpenAIRequest', () => {
  const event: SlackGateEvent = {
    eventId: 'e',
    case: 'thread_reply',
    teamId: 'T',
    channelId: 'C',
    placeKind: 'channel',
    from: { userId: 'U', name: 'Dana', role: 'owner' },
    text: 'deploy?',
    mentioned: true,
    context: [
      { kind: 'more', text: '' },
      ...['one', 'two', 'three'].map((text) => ({ kind: 'earlier', userId: 'U9', text }))
    ],
    contextIncomplete: 'more'
  }
  const { more, unreadable } = SLACK_GATE_CONTEXT_MARKER_TEXT
  const data = (request: ReturnType<typeof slackGateOpenAIRequest>) =>
    request?.input[1].content[0].data

  it('sends what `send` picks, with extra values, and keeps the completeness markers', () => {
    const request = slackGateOpenAIRequest(
      {
        ...base,
        model: 'm2',
        send: { message: true, earlierMessages: 2, fromName: true, mentioned: true, botName: true },
        extra: { botRole: 'Deploys' }
      },
      { name: 'Elyang' },
      event
    )
    expect(request?.model).toBe('m2')
    expect(request?.questions).toBe(base.questions)
    expect(Object.keys(request ?? {})).toEqual(['model', 'input', 'questions'])
    expect(data(request)).toEqual({
      message: 'deploy?',
      earlierMessages: [more, 'two', 'three'],
      fromName: 'Dana',
      mentioned: true,
      botName: 'Elyang',
      botRole: 'Deploys'
    })
    const cloud = {
      ...event,
      context: [{ kind: 'earlier', text: 'one' }],
      contextIncomplete: 'unreadable' as const
    }
    expect(data(slackGateOpenAIRequest(base, {}, cloud))?.earlierMessages).toEqual([
      unreadable,
      'one'
    ])
    expect(
      data(slackGateOpenAIRequest(base, {}, { ...cloud, contextIncomplete: undefined }))
        ?.earlierMessages
    ).toEqual(['one'])
    // Without `send`, the default set: no names, no bot name, no ids.
    expect(Object.keys(data(slackGateOpenAIRequest(base, { name: 'B' }, event)) ?? {})).toEqual([
      'message',
      'earlierMessages',
      'case',
      'place',
      'fromRole'
    ])
  })

  it('cuts the oldest messages to fit OpenAI’s limits, counting the markers it adds', () => {
    const limited = { ...base, send: { message: true, earlierMessages: true, laterMessages: true } }
    // One value over the limit; the two markers it then adds cost two more, so three messages go.
    const empties = Array.from({ length: SLACK_GATE_INPUT_MAX_VALUES - 2 }, () => ({
      kind: 'earlier',
      text: ''
    }))
    const many = { ...event, contextIncomplete: undefined, context: empties }
    const fitted = data(slackGateOpenAIRequest(limited, {}, many))
    expect(fitted?.truncated).toBe(true)
    expect(fitted?.earlierMessages).toHaveLength(SLACK_GATE_INPUT_MAX_VALUES - 4)
    expect(Array.isArray(fitted?.earlierMessages) && fitted.earlierMessages[0]).toBe(more)
    // Bytes: the oldest go first, then the oldest later messages, keeping the newest.
    const big = 'x'.repeat(100 * 1024)
    const heavy = {
      ...event,
      contextIncomplete: undefined,
      context: ['a', 'b', 'c'].map((tag) => ({ kind: 'earlier', text: `${tag}${big}` })),
      later: [{ case: 'thread_reply' as const, text: `later${big}` }]
    }
    const cut = data(slackGateOpenAIRequest(limited, {}, heavy))
    expect(cut?.earlierMessages).toEqual([more, `c${big}`])
    expect(cut?.laterMessages).toEqual([`later${big}`])
    expect(new TextEncoder().encode(JSON.stringify(cut)).length).toBeLessThanOrEqual(
      SLACK_GATE_INPUT_MAX_BYTES
    )
    // What can't be cut is refused rather than sent over the limit.
    const huge = { ...event, text: 'x'.repeat(SLACK_GATE_INPUT_MAX_BYTES), context: [] }
    expect(slackGateOpenAIRequest(limited, {}, huge)).toBeNull()
    expect(fitSlackGateInput({ message: 'ok' }, [], false)).toEqual({ message: 'ok' })
  })
})

describe('a saved TypeSafe Jev gate', () => {
  const stored = {
    id: 'b1',
    slackGate: {
      on: true,
      kind: 'jev',
      appliesTo: ['mention'],
      timeoutSeconds: 5,
      onError: 'wake',
      jev: { question: 'Q?', threshold: 0.5 }
    }
  }

  it('reads as no gate, keeps the bot, and is never taken for another kind', () => {
    expect(BotSlackGateSchema.safeParse(stored.slackGate).success).toBe(false)
    expect(BotSchema.shape.slackGate.parse(stored.slackGate)).toBeUndefined()
    expect(
      BotSlackGateSchema.safeParse({
        ...stored.slackGate,
        kind: 'openai',
        openai: stored.slackGate.jev
      }).success
    ).toBe(false)
  })

  it('notes the retired gate on a loaded bot', () => {
    const saved = JSON.parse(JSON.stringify(makeTestBot({ id: 'b1' })))
    const [bot] = normalizePersistedBots([{ ...saved, slackGate: stored.slackGate }])
    expect(bot?.slackGate).toBeUndefined()
    expect(bot?.slackGateRetired).toBe('jev')
    const [plain] = normalizePersistedBots([saved])
    expect(plain?.slackGateRetired).toBeUndefined()
  })
})
