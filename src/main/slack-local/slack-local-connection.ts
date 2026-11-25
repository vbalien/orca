// One bot's live link to its own Slack app: Socket Mode in, the conversation seam, answers out.
import { hostname } from 'node:os'
import type { Bot } from '../../shared/bot-types'
import { runtimeConversationHost } from '../external-conversations/external-conversation-runtime-host'
import { ALWAYS_WAKE, SlackLocalInbound, type LocalSlackWakeGate } from './slack-local-inbound'
import { slackLocalReads } from './slack-local-reads'
import { SlackLocalReplies } from './slack-local-replies'
import type { SlackLocalSecrets } from './slack-local-token-store'
import {
  SlackSocketModeClient,
  type SocketModeSocket,
  type SocketModeState
} from './slack-socket-mode-client'
import type { SlackFetch } from './slack-web-api'

export type SlackLocalRunning = {
  secrets: SlackLocalSecrets
  abort: AbortController
  client: SlackSocketModeClient
  inbound: SlackLocalInbound
  replies: SlackLocalReplies
  state: SocketModeState
}

export function slackLocalConnection(input: {
  secrets: SlackLocalSecrets
  fetch: SlackFetch
  runtime: Parameters<typeof runtimeConversationHost>[0]
  bot: () => Bot | null
  /** Whether this connection is still the bot's; a replaced one posts nothing more. */
  isCurrent: (abort: AbortController) => boolean
  onState: (state: SocketModeState) => void
  onReplyError: (code: string) => void
  onReplyDelivered: () => void
  wakeGate?: LocalSlackWakeGate
  socketFactory?: (url: string) => SocketModeSocket
}): SlackLocalRunning {
  const { secrets, runtime } = input
  const abort = new AbortController()
  const identity = { teamId: secrets.teamId, botUserId: secrets.botUserId, appId: secrets.appId }
  const inbound = new SlackLocalInbound({
    identity,
    bot: input.bot,
    seam: () => runtime.getExternalConversationSeam(),
    host: () => runtimeConversationHost(runtime),
    reads: slackLocalReads(input.fetch, secrets.botToken, abort.signal),
    wakeGate: input.wakeGate ?? ALWAYS_WAKE,
    signal: abort.signal
  })
  const replies = new SlackLocalReplies({
    fetch: input.fetch,
    current: () => (input.isCurrent(abort) ? { botToken: secrets.botToken, identity } : null),
    hostName: () => hostname(),
    signal: abort.signal,
    onError: input.onReplyError,
    onDelivered: input.onReplyDelivered
  })
  const client = new SlackSocketModeClient({
    appToken: secrets.appToken,
    appId: secrets.appId,
    fetch: input.fetch,
    onEvent: (payload) => inbound.receive(payload),
    onState: (state) => {
      if (input.isCurrent(abort)) {
        input.onState(state)
      }
    },
    ...(input.socketFactory ? { socketFactory: input.socketFactory } : {})
  })
  return { secrets, abort, client, inbound, replies, state: { state: 'connecting' } }
}
