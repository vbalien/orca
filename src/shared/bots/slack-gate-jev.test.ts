// The Jev gate's JSON: what the editor and the host accept, where problems are, what older builds read,
// and the exact request each config sends.
import { describe, expect, it } from 'vitest'
import {
  BotSlackGateSchema,
  LegacyBotSlackGateJevSchema,
  type SlackGateEvent
} from './bot-slack-gate'
import { BotSchema } from '../bot-types'
import {
  narrowsLegacyDisclosure,
  slackGateJevConfigOf,
  slackGateJevLegacyMirror,
  storedSlackGateJev,
  type SlackGateJevConfig
} from './slack-gate-jev-config'
import { validateSlackGateJev, validateStoredSlackGateJev } from './slack-gate-jev-validate'
import { SLACK_GATE_CONTEXT_MARKER_TEXT, slackGateJevRequest } from './slack-gate-jev-request'
import { parseSlackGateJevText } from './slack-gate-jev-text'

const base: SlackGateJevConfig = {
  questions: { asks: { type: 'noul', instructions: 'Asks the bot?' } },
  rules: [{ question: 'asks', wakeIf: { atLeast: 0.7 } }]
}
const codes = (value: unknown) => {
  const result = validateSlackGateJev(value)
  return result.ok ? [] : result.issues.map((issue) => `${issue.path.join('.')}:${issue.code}`)
}

describe('validateSlackGateJev', () => {
  it('accepts the documented example with every question type', () => {
    expect(
      codes({
        model: ' jev-latest ',
        questions: {
          asks_bot: { type: 'noul', instructions: 'Q?', criteria: { true: 'yes', false: 'no' } },
          small_talk: { type: 'noul' },
          topic: { type: 'choice', criteria: { deploy: 'D', review: 'R', other: 'O' } },
          urgency: {
            type: 'score',
            instructions: 'How urgent?',
            criteria: ['Later', 'Week', 'Today']
          }
        },
        send: { message: true, earlierMessages: 10, botName: true },
        extra: { botRole: 'Reviews code', nested: { list: [1, 'two'] } },
        rules: [
          { question: 'asks_bot', wakeIf: { atLeast: 0.7 }, unsureFrom: 0.4 },
          { question: 'small_talk', blockIf: { atLeast: 0.8 } },
          { question: 'topic', wakeIf: { oneOf: ['deploy', 'review'] } },
          { question: 'urgency', wakeIf: { atMost: 1 }, unsureFrom: 1.5 }
        ],
        combine: 'any',
        whenUnsure: 'wake'
      })
    ).toEqual([])
    const result = validateSlackGateJev({ ...base, model: '  ' })
    expect(result.ok && result.config).toEqual(base)
  })

  it('refuses what TypeSafe or the rules cannot use, by field', () => {
    expect(codes({ ...base, assets: {} })).toEqual(['assets:assets_unsupported'])
    expect(codes({ ...base, questions: { asks: { type: 'box' } } })).toContain(
      'questions.asks.type:box_unsupported'
    )
    expect(
      codes({ ...base, questions: { asks: { type: 'noul', instructions: { a: 1 } } } })
    ).toEqual(['questions.asks.instructions:not_string'])
    expect(codes({ ...base, questions: { asks: { type: 'noul', hint: 'x' } } })).toEqual([
      'questions.asks.hint:unknown_key'
    ])
    expect(
      codes({
        ...base,
        questions: { '1bad': { type: 'noul' } },
        rules: [{ question: '1bad', wakeIf: { atLeast: 1 } }]
      })
    ).toEqual(['questions.1bad:bad_name'])
    expect(codes({ ...base, question: 'mirror only' })).toEqual(['question:unknown_key'])
    expect(codes({ ...base, rules: [{ question: 'nope', wakeIf: { atLeast: 0.5 } }] })).toEqual([
      'rules.0.question:unknown_question',
      'questions.asks:unused_question'
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
    expect(codes({ ...base, rules: [{ question: 'asks', wakeIf: { atLeast: 1.5 } }] })).toEqual([
      'rules.0.wakeIf.atLeast:out_of_range'
    ])
    expect(
      codes({ ...base, rules: [{ question: 'asks', wakeIf: { atLeast: 0.5 }, unsureFrom: 0.6 }] })
    ).toEqual(['rules.0.unsureFrom:unsure_side'])
    const choice = { questions: { t: { type: 'choice', criteria: { a: 'A' } } } }
    expect(
      codes({ ...choice, rules: [{ question: 't', wakeIf: { oneOf: ['a', 'b', 'a'] } }] })
    ).toEqual(['rules.0.wakeIf.oneOf.1:unknown_choice', 'rules.0.wakeIf.oneOf.2:duplicate_choice'])
    expect(codes({ ...choice, rules: [{ question: 't', wakeIf: { atLeast: 0 } }] })).toEqual([
      'rules.0.wakeIf.atLeast:condition_for_choice'
    ])
    expect(
      codes({ ...base, send: { message: 'yes', earlierMessages: 51, channel: true } })
    ).toEqual([
      'send.channel:unknown_key',
      'send.message:not_boolean_or_number',
      'send.earlierMessages:out_of_range'
    ])
    expect(codes({ ...base, extra: { message: 'x' } })).toEqual(['extra.message:extra_collision'])
    expect(codes({ ...base, extra: { nested: { assets: {} }, list: [{ assets: 1 }] } })).toEqual([
      'extra.list.0.assets:assets_unsupported',
      'extra.nested.assets:assets_unsupported'
    ])
    // A pasted wall of junk is reported briefly, not entry by entry.
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

describe('parseSlackGateJevText', () => {
  it('places problems on their line, also among repeated keys and list items', () => {
    const text = JSON.stringify(
      {
        questions: { a: { type: 'noul' }, b: { type: 'noul' } },
        rules: [
          { question: 'a', wakeIf: { atLeast: 0.5 } },
          { question: 'b', wakeIf: { atLeast: 2 } }
        ]
      },
      null,
      2
    )
    const result = parseSlackGateJevText(text)
    const issue = result.ok ? null : result.issues[0]
    expect(issue).toMatchObject({ path: ['rules', 1, 'wakeIf', 'atLeast'], code: 'out_of_range' })
    expect(text.split('\n')[(issue?.line ?? 0) - 1]).toContain('"atLeast": 2')
    // A missing field points at the object that lacks it.
    const missing =
      '{\n  "questions": { "a": { "type": "choice" } },\n  "rules": [ { "question": "a", "wakeIf": { "oneOf": ["x"] } } ]\n}'
    const located = parseSlackGateJevText(missing)
    expect(located.ok ? null : located.issues[0]).toMatchObject({ code: 'required', line: 2 })
  })

  it('refuses comments, trailing commas, duplicate keys and pathological input before parsing', () => {
    const ok = JSON.stringify(base)
    expect(parseSlackGateJevText(ok).ok).toBe(true)
    for (const [text, code] of [
      ['{ // hi\n}', 'syntax'],
      [`${ok.slice(0, -1)},}`, 'syntax'],
      ['{ "rules": [], "rules": [] }', 'duplicate_key'],
      [`{ "extra": { "n": ${'['.repeat(20)}${']'.repeat(20)} } }`, 'too_deep'],
      [`{ "extra": { "s": "${'x'.repeat(70 * 1024)}" } }`, 'text_too_large'],
      [
        `{ "questions": { "a": { "type": "noul" } }, "extra": { "n": 1e400 }, "rules": [ { "question": "a", "wakeIf": { "atLeast": 1 } } ] }`,
        'not_finite'
      ]
    ] as const) {
      const result = parseSlackGateJevText(text)
      expect(result.ok ? null : result.issues[0]?.code).toBe(code)
    }
    const duplicate = parseSlackGateJevText('{\n  "rules": [],\n  "rules": []\n}')
    expect(duplicate.ok ? null : duplicate.issues[0]).toMatchObject({
      line: 3,
      params: { key: 'rules' }
    })
  })
})

describe('stored gates, legacy and the mirror older builds read', () => {
  const legacyShape = (jev: unknown) => LegacyBotSlackGateJevSchema.safeParse(jev).success

  it('reads a legacy gate as one noul question at its threshold, and keeps legacy input exclusive', () => {
    expect(slackGateJevConfigOf({ question: 'Q?', threshold: 0.6, model: ' m ' })).toEqual({
      config: {
        model: 'm',
        questions: { wake: { type: 'noul', instructions: 'Q?' } },
        rules: [{ question: 'wake', wakeIf: { atLeast: 0.6 } }]
      },
      legacy: true
    })
    expect(validateStoredSlackGateJev({ question: 'Q?', threshold: 0.6 })).toEqual([])
    expect(
      validateStoredSlackGateJev({ question: 'Q?', threshold: 0.5, send: { message: false } }).map(
        (issue) => issue.code
      )
    ).toEqual(['legacy_mixed'])
  })

  it('always writes a mirror today’s builds parse', () => {
    const fallback = { question: 'Should this bot wake for this message?', threshold: 0.5 }
    const noul = (instructions?: string): SlackGateJevConfig => ({
      questions: { a: { type: 'noul', ...(instructions === undefined ? {} : { instructions }) } },
      rules: [{ question: 'a', wakeIf: { atLeast: 0.7 } }]
    })
    expect(slackGateJevLegacyMirror(noul('Asks?'))).toEqual({ question: 'Asks?', threshold: 0.7 })
    expect(slackGateJevLegacyMirror(noul('x'.repeat(2000))).question).toHaveLength(2000)
    for (const config of [
      noul(),
      noul(''),
      noul('   '),
      noul('x'.repeat(2001)),
      {
        questions: { t: { type: 'choice' as const, criteria: { a: 'A' } } },
        rules: [{ question: 't', wakeIf: { oneOf: ['a'] } }]
      },
      { ...noul('Asks?'), rules: [{ question: 'a', blockIf: { atLeast: 0.5 } }] }
    ]) {
      expect(slackGateJevLegacyMirror(config)).toEqual(fallback)
    }
    // A config at the size limit stays whole with its mirror, for today's schema and the old one.
    const big = { ...noul('Asks?'), extra: { pad: 'x'.repeat(16 * 1024 - 140) } }
    expect(validateSlackGateJev(big).ok).toBe(true)
    const stored = storedSlackGateJev(big)
    expect(legacyShape(stored)).toBe(true)
    const gate = {
      on: true,
      kind: 'jev',
      appliesTo: ['mention'],
      timeoutSeconds: 5,
      onError: 'wake',
      jev: stored
    }
    expect(BotSlackGateSchema.safeParse(gate).success).toBe(true)
    // The bot record's own field (it drops an invalid gate silently, so this must hold).
    expect(BotSchema.shape.slackGate.parse(gate)).toEqual(gate)
  })

  it('warns exactly when older builds would send more than the config allows', () => {
    expect(narrowsLegacyDisclosure(base)).toBe(false)
    const all = {
      message: true,
      laterMessages: true,
      earlierMessages: true,
      earlierOwn: true
    } as const
    expect(narrowsLegacyDisclosure({ ...base, send: all })).toBe(false)
    expect(narrowsLegacyDisclosure({ ...base, send: { ...all, earlierOwn: false } })).toBe(true)
    expect(
      narrowsLegacyDisclosure({
        ...base,
        send: { message: true, laterMessages: true, earlierMessages: true }
      })
    ).toBe(true)
    expect(narrowsLegacyDisclosure({ ...base, send: { ...all, earlierMessages: 10 } })).toBe(true)
    expect(narrowsLegacyDisclosure({ ...base, send: { ...all, earlierMessages: 0 } })).toBe(true)
  })
})

describe('slackGateJevRequest', () => {
  const event: SlackGateEvent = {
    eventId: 'e',
    case: 'mention',
    teamId: 'T',
    channelId: 'C',
    placeKind: 'channel',
    from: { userId: 'U', name: 'Dana', role: 'owner' },
    text: 'deploy?',
    mentioned: true,
    context: [
      { kind: 'more', text: '' },
      ...['one', 'two', 'three'].map((text) => ({ kind: 'earlier', text }))
    ],
    contextIncomplete: 'more'
  }
  const { more, unreadable } = SLACK_GATE_CONTEXT_MARKER_TEXT

  it('sends what `send` picks, with extra values, and keeps the completeness markers', () => {
    const request = slackGateJevRequest(
      {
        ...base,
        model: 'm2',
        send: { message: true, earlierMessages: 2, fromName: true, mentioned: true, botName: true },
        extra: { botRole: 'Deploys' }
      },
      { name: 'Elyang' },
      event
    )
    expect(request).toEqual({
      model: 'm2',
      state: {
        message: 'deploy?',
        earlierMessages: [more, 'two', 'three'],
        fromName: 'Dana',
        mentioned: true,
        botName: 'Elyang',
        botRole: 'Deploys'
      },
      questions: base.questions
    })
    // The cloud path: no marker entries, only the flag.
    const cloud = {
      ...event,
      context: [{ kind: 'earlier', text: 'one' }],
      contextIncomplete: 'unreadable' as const
    }
    expect(slackGateJevRequest(base, {}, cloud).state.earlierMessages).toEqual([unreadable, 'one'])
    expect(
      slackGateJevRequest(base, {}, { ...cloud, contextIncomplete: undefined }).state
        .earlierMessages
    ).toEqual(['one'])
  })

  it('builds a legacy gate’s request exactly as before, ignoring the completeness flag', () => {
    expect(slackGateJevRequest({ question: 'Q?', threshold: 0.5 }, { name: 'B' }, event)).toEqual({
      model: 'jev-latest',
      state: {
        case: 'mention',
        place: 'channel',
        fromRole: 'owner',
        message: 'deploy?',
        earlierMessages: ['', 'one', 'two', 'three']
      },
      questions: { wake: { type: 'noul', instructions: 'Q?' } }
    })
  })
})
