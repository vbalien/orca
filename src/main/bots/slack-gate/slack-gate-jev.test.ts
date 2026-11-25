import { describe, expect, it, vi } from 'vitest'
import type { SlackGateEvent } from '../../../shared/bots/bot-slack-gate'
import { askSlackGateJev, TYPESAFE_SYSTEM_ONE_URL } from './slack-gate-jev'

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
const jev = { question: 'Is this a request for the bot?', threshold: 0.6, model: '  ' }

const answer = (body: unknown, status = 200) => {
  const response = new Response(JSON.stringify(body), { status })
  const cancel = vi.spyOn(response.body ?? new ReadableStream(), 'cancel')
  return { response, cancel }
}

const ask = (response: Response, key: string | null = 'k1') => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response)
  const outcome = askSlackGateJev({ jev, event, key, signal: new AbortController().signal, fetch })
  return { fetch, outcome }
}

describe('askSlackGateJev', () => {
  it('asks one noul question about the message, with the default model for a blank one', async () => {
    const { fetch, outcome } = ask(
      answer({ answers: { wake: { type: 'noul', noul: 0.7 } } }).response
    )
    expect(await outcome).toEqual({ kind: 'score', noul: 0.7 })
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

  it('treats anything but a finite noul in [0,1] as an error', async () => {
    for (const wake of [
      { type: 'noul', noul: '1' },
      { type: 'noul' },
      { type: 'noul', noul: 1.2 },
      { type: 'noul', noul: Number.NaN },
      { type: 'choice', noul: 0.9 }
    ]) {
      expect(await ask(answer({ answers: { wake } }).response).outcome).toMatchObject({
        kind: 'error'
      })
    }
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
