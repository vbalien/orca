// The few Slack Web API calls a bot's own app makes from this computer. Tokens and bodies never go
// into errors or logs; a failure says only Slack's error code and whether the call may have landed.
const SLACK_API = 'https://slack.com/api/'
const REQUEST_DEADLINE_MS = 15_000
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])

/** sent: Slack refused it, or it never left; uncertain: it may have landed. */
export class SlackApiError extends Error {
  constructor(
    readonly code: string,
    readonly delivery: 'refused' | 'not_sent' | 'uncertain',
    readonly retryAfterMs?: number
  ) {
    super(`Slack: ${code}`)
    this.name = 'SlackApiError'
  }
}

export type SlackFetch = typeof globalThis.fetch

export function isSlackRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** A Slack JSON object's fields; anything else reads as none. */
export const slackFields = (value: unknown): Record<string, unknown> =>
  isSlackRecord(value) ? value : {}

// Outside strings become error codes only in these shapes, so nothing else (a token echoed back, say)
// rides along into answers, statuses or logs.
const SLACK_ERROR_CODE = /^[a-z0-9_]{1,64}$/
const NETWORK_ERROR_CODE = /^(E[A-Z0-9_]{2,40}|UND_ERR_[A-Z0-9_]{1,40})$/

function causeCode(error: unknown): string | undefined {
  const code = error instanceof Error ? slackFields(error.cause).code : undefined
  if (typeof code !== 'string') {
    return undefined
  }
  return NETWORK_ERROR_CODE.test(code) ? code : 'network'
}

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get('retry-after'))
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
}

export async function callSlack(
  fetchImpl: SlackFetch,
  method: string,
  token: string,
  params: Record<string, string | number | boolean | undefined>,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams()
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) {
      body.set(name, String(value))
    }
  }
  const deadline = AbortSignal.timeout(REQUEST_DEADLINE_MS)
  let response: Response
  try {
    response = await fetchImpl(`${SLACK_API}${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/x-www-form-urlencoded; charset=utf-8'
      },
      body,
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline
    })
  } catch (error) {
    if (signal?.aborted) {
      throw new SlackApiError('aborted', 'uncertain')
    }
    const code = causeCode(error)
    throw new SlackApiError(
      code ?? 'network',
      code && NOT_SENT_CODES.has(code) ? 'not_sent' : 'uncertain'
    )
  }
  if (response.status === 429 || !response.ok) {
    // Its body is never read: let the connection go.
    await response.body?.cancel().catch(() => undefined)
    throw response.status === 429
      ? new SlackApiError('ratelimited', 'refused', retryAfterMs(response) ?? 1000)
      : new SlackApiError(`http_${response.status}`, 'uncertain')
  }
  let json: unknown
  try {
    json = await response.json()
  } catch {
    throw new SlackApiError('invalid_response', 'uncertain')
  }
  const answer = slackFields(json)
  if (answer.ok !== true) {
    const code =
      typeof answer.error === 'string' && SLACK_ERROR_CODE.test(answer.error)
        ? answer.error
        : 'unknown_error'
    throw new SlackApiError(code, 'refused', code === 'ratelimited' ? 1000 : undefined)
  }
  return answer
}

export type SlackIdentity = { teamId: string; teamName?: string; botUserId: string; appId?: string }

/** Who a bot token speaks as. */
export async function slackBotIdentity(
  fetchImpl: SlackFetch,
  botToken: string,
  signal?: AbortSignal
): Promise<SlackIdentity> {
  const answer = await callSlack(fetchImpl, 'auth.test', botToken, {}, signal)
  const { team_id: teamId, team, user_id: botUserId, bot_id: botId } = answer
  if (typeof teamId !== 'string' || typeof botUserId !== 'string') {
    throw new SlackApiError('invalid_response', 'refused')
  }
  // auth.test names the app only sometimes; the bot's own record always does.
  let appId = answer.app_id
  if (typeof appId !== 'string' && typeof botId === 'string') {
    const info = await callSlack(fetchImpl, 'bots.info', botToken, { bot: botId }, signal)
    appId = slackFields(info.bot).app_id
  }
  return {
    teamId,
    botUserId,
    ...(typeof team === 'string' ? { teamName: team } : {}),
    ...(typeof appId === 'string' ? { appId } : {})
  }
}

/** A Socket Mode URL for the app-level token; asked again for every connection. */
export async function openSocketModeUrl(
  fetchImpl: SlackFetch,
  appToken: string,
  signal?: AbortSignal
): Promise<string> {
  const { url } = await callSlack(fetchImpl, 'apps.connections.open', appToken, {}, signal)
  if (typeof url !== 'string' || !url.startsWith('wss://')) {
    throw new SlackApiError('invalid_response', 'refused')
  }
  return url
}
