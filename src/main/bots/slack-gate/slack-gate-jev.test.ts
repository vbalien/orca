import { describe, expect, it, vi } from 'vitest'
import type { SlackGateEvent } from '../../../shared/bots/bot-slack-gate'
import type {
  SlackGateJevConfig,
  StoredSlackGateJev
} from '../../../shared/bots/slack-gate-jev-config'
import { askSlackGateJev, readSlackGateJevAnswers, TYPESAFE_SYSTEM_ONE_URL } from './slack-gate-jev'

const event: SlackGateEvent = {
  eventId: 'd1',
  case: 'thread_reply',
  teamId: 'T1',
  channelId: 'C1',
  placeKind: 'public_channel',
  from: { userId: 'U1', role: 'member' },
  text: 'can you look at the deploy?',
  later: [{ case: 'thread_reply', text: 'it failed again' }]
}
const legacy = { question: 'Is this a request for the bot?', threshold: 0.6, model: '  ' }

const answer = (body: unknown, status = 200) => {
  const response = new Response(JSON.stringify(body), { status })
  const cancel = vi.spyOn(response.body ?? new ReadableStream(), 'cancel')
  return { response, cancel }
}

const ask = (response: Response, key: string | null = 'k1', jev: StoredSlackGateJev = legacy) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response)
  const outcome = askSlackGateJev({
    jev,
    bot: { name: 'Elyang' },
    event,
    key,
    signal: new AbortController().signal,
    fetch
  })
  return { fetch, outcome }
}

const config: SlackGateJevConfig = {
  questions: {
    asks: { type: 'noul', instructions: 'Asks?' },
    topic: { type: 'choice', criteria: { deploy: 'Deploys', other: 'Else' } },
    urgency: { type: 'score', criteria: ['Later', 'Soon', 'Now'] }
  },
  rules: [
    { question: 'asks', wakeIf: { atLeast: 0.5 } },
    { question: 'topic', wakeIf: { oneOf: ['deploy'] } },
    { question: 'urgency', wakeIf: { atLeast: 1 } }
  ]
}
const good = {
  asks: { type: 'noul', noul: 0.8 },
  topic: {
    type: 'choice',
    choice: 'deploy',
    confidence: 0.9,
    probabilities: { deploy: 0.9, other: 0.1 }
  },
  urgency: {
    type: 'score',
    score: 1.4,
    confidence: 0.7,
    legend: { '0': 'Later', '1': 'Soon', '2': 'Now' },
    probabilities: { '0': 0.1, '1': 0.4, '2': 0.5 }
  }
}

describe('askSlackGateJev', () => {
  it('asks a legacy gate exactly as before: one noul question, the default model for a blank one', async () => {
    const { fetch, outcome } = ask(
      answer({ answers: { wake: { type: 'noul', noul: 0.7 } } }).response
    )
    expect(await outcome).toEqual({
      kind: 'answers',
      answers: { wake: { type: 'noul', value: 0.7 } }
    })
    const [url, init] = fetch.mock.calls[0] ?? []
    expect(url).toBe(TYPESAFE_SYSTEM_ONE_URL)
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer k1' })
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'jev-latest',
      state: {
        case: 'thread_reply',
        place: 'public_channel',
        fromRole: 'member',
        message: 'can you look at the deploy?',
        laterMessages: ['it failed again']
      },
      questions: { wake: { type: 'noul', instructions: 'Is this a request for the bot?' } }
    })
  })

  it('reads every configured answer of its own type with the fields TypeSafe requires', async () => {
    const { fetch, outcome } = ask(answer({ answers: good }).response, 'k1', config)
    expect(await outcome).toEqual({
      kind: 'answers',
      answers: {
        asks: { type: 'noul', value: 0.8 },
        topic: { type: 'choice', value: 'deploy' },
        urgency: { type: 'score', value: 1.4 }
      }
    })
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).questions).toEqual(config.questions)
  })

  it('treats a missing answer or any malformed field as an error', () => {
    const bad: Record<string, unknown>[] = [
      { asks: { type: 'noul', noul: '1' } },
      { asks: { type: 'noul', noul: 1.2 } },
      { asks: { type: 'choice', noul: 0.9 } },
      { asks: undefined },
      { topic: { ...good.topic, choice: 'nope' } },
      { topic: { ...good.topic, confidence: undefined } },
      { topic: { ...good.topic, confidence: 2 } },
      { topic: { ...good.topic, probabilities: { deploy: -1 } } },
      { topic: { ...good.topic, probabilities: [0.9] } },
      { urgency: { ...good.urgency, score: 2.5 } },
      { urgency: { ...good.urgency, legend: undefined } },
      { urgency: { ...good.urgency, legend: { '0': null } } },
      { urgency: { ...good.urgency, legend: { '0': 42 } } },
      { urgency: { ...good.urgency, probabilities: { '0': Number.NaN } } }
    ]
    for (const change of bad) {
      expect(
        readSlackGateJevAnswers(config.questions, { answers: { ...good, ...change } })
      ).toMatchObject({
        kind: 'error'
      })
    }
    expect(readSlackGateJevAnswers(config.questions, { answers: good })).toMatchObject({
      kind: 'answers'
    })
    expect(readSlackGateJevAnswers(config.questions, {})).toMatchObject({ kind: 'error' })
  })

  it('disposes the body of a refused request and needs a key', async () => {
    const refused = answer({ detail: 'nope' }, 401)
    expect(await ask(refused.response).outcome).toMatchObject({ kind: 'error' })
    expect(refused.cancel).toHaveBeenCalled()
    const { fetch, outcome } = ask(answer({}).response, null)
    expect(await outcome).toMatchObject({ kind: 'error' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
