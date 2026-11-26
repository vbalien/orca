// Slack's error codes and network failure codes pass through; any other outside string (a token
// echoed back, say) becomes a fixed code, so it never reaches an answer, a status or a log.
import { expect, it } from 'vitest'
import { callSlack, SlackApiError } from './slack-web-api'

const TOKEN = 'xoxb-1-SECRETMARK-aaaa'

async function codeOf(fetchImpl: typeof fetch): Promise<string> {
  const failure: unknown = await callSlack(fetchImpl, 'auth.test', TOKEN, {}).catch(
    (error) => error
  )
  if (!(failure instanceof SlackApiError)) {
    throw new Error('expected a SlackApiError')
  }
  return failure.code
}

const answering = (error: string) => async () => Response.json({ ok: false, error })
const failingWith = (code: string) => async () => {
  throw new Error('fetch failed', { cause: { code } })
}

it('keeps real codes and replaces anything else', async () => {
  expect(await codeOf(answering('invalid_auth'))).toBe('invalid_auth')
  expect(await codeOf(answering('ratelimited'))).toBe('ratelimited')
  expect(await codeOf(answering(TOKEN))).toBe('unknown_error')
  expect(await codeOf(answering('Invalid auth: token xyz'))).toBe('unknown_error')
  expect(await codeOf(failingWith('ECONNREFUSED'))).toBe('ECONNREFUSED')
  expect(await codeOf(failingWith('UND_ERR_CONNECT_TIMEOUT'))).toBe('UND_ERR_CONNECT_TIMEOUT')
  expect(await codeOf(failingWith(TOKEN))).toBe('network')
})
