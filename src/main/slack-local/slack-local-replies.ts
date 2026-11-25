// A bot's final answer, posted by its own Slack app into the thread that asked. A part is sent again
// only when Slack surely didn't take it, so an answer never shows twice.
import { setTimeout as wait } from 'node:timers/promises'
import { redactLocalPaths } from '../../shared/connectors/slack-local-paths'
import { parseLocalSlackConversation } from '../../shared/connectors/local-slack-conversation'
import type { ConversationEvent } from '../external-conversations/external-conversation-events'
import { outcomeSentence } from '../connector-cloud/connector-reply-outcome-sentence'
import { BoundedKeys } from './slack-local-bounded-keys'
import { callSlack, SlackApiError, type SlackFetch } from './slack-web-api'
import type { LocalSlackIdentity } from './slack-local-events'

// Slack's limit for markdown_text in one message.
const PART_CHARS = 12_000
const MAX_TRIES = 3
const MAX_COOLDOWN_MS = 5 * 60_000
const MAX_PENDING = 50
const PROMPT_NOTICE =
  'I need an answer in Orca before I can go on. Open this chat in Orca on the computer I run on.'

type TurnEnded = Extract<ConversationEvent, { kind: 'turn-ended' }>
type Prompt = Extract<ConversationEvent, { kind: 'prompt' }>

export type SlackLocalRepliesDeps = {
  fetch: SlackFetch
  /** The credentials loaded for the bot now; null once stopped. Read before every post. */
  current: () => { botToken: string; identity: LocalSlackIdentity } | null
  hostName: () => string
  signal: AbortSignal
  onError: (code: string) => void
  /** A whole answer was posted: a warning about an earlier one is out of date. */
  onDelivered?: () => void
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

const sleepFor = (ms: number, signal: AbortSignal): Promise<void> => wait(ms, undefined, { signal })

export function splitAnswer(text: string): string[] {
  const parts: string[] = []
  let rest = text
  while (rest.length > PART_CHARS) {
    const cut = rest.lastIndexOf('\n', PART_CHARS)
    const at = cut > PART_CHARS / 2 ? cut : PART_CHARS
    parts.push(rest.slice(0, at))
    rest = rest.slice(at).replace(/^\n/, '')
  }
  return rest.length > 0 ? [...parts, rest] : parts
}

export class SlackLocalReplies {
  private readonly done = new BoundedKeys(2_000)
  private readonly notices = new BoundedKeys(2_000)
  private pending = 0
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly deps: SlackLocalRepliesDeps) {}

  /** A local conversation's event of this bot's; the caller checked the link's bot. */
  observe(event: ConversationEvent): void {
    if (event.kind === 'turn-ended') {
      void this.turnEnded(event)
    } else if (event.kind === 'prompt' && !event.answered) {
      void this.prompt(event)
    }
  }

  private async turnEnded(event: TurnEnded): Promise<void> {
    if (event.origin !== 'delivery') {
      return
    }
    const words = event.lastAssistantMessage?.trim()
    const failed = event.failure !== undefined || event.stopReason === 'failure'
    const text = words
      ? redactLocalPaths(words)
      : failed
        ? outcomeSentence('failed', this.deps.hostName())
        : null
    const key = `${event.conversation.externalId}:${event.turnId ?? event.at}`
    if (!text || !this.done.add(key)) {
      return
    }
    await this.post(event.conversation.externalId, splitAnswer(text))
  }

  private async prompt(event: Prompt): Promise<void> {
    if (!this.notices.add(`${event.conversation.externalId}:${event.prompt.promptId}`)) {
      return
    }
    await this.post(event.conversation.externalId, [PROMPT_NOTICE])
  }

  private async post(externalId: string, parts: string[]): Promise<void> {
    const place = parseLocalSlackConversation(externalId)
    if (!place || this.pending >= MAX_PENDING) {
      this.deps.onError(place ? 'reply_dropped' : 'reply_unplaceable')
      return
    }
    this.pending += 1
    // One answer at a time: each keeps its parts together, and a rate limit's wait holds the rest.
    const run = this.tail.then(async () => {
      try {
        for (const part of parts) {
          if (!(await this.postPart(place, part))) {
            return
          }
        }
        this.deps.onDelivered?.()
      } finally {
        this.pending -= 1
      }
    })
    this.tail = run.catch(() => undefined)
    await run
  }

  /** False once the answer can go no further (an error was reported). */
  private async postPart(
    place: NonNullable<ReturnType<typeof parseLocalSlackConversation>>,
    text: string
  ): Promise<boolean> {
    // markdown_text where Slack takes it; plain text once if it refuses the field.
    let field: 'markdown_text' | 'text' = 'markdown_text'
    for (let attempt = 1; ; attempt++) {
      const current = this.deps.current()
      // Only the app that was asked answers: new credentials for another app post nothing old.
      if (
        !current ||
        current.identity.teamId !== place.teamId ||
        current.identity.botUserId !== place.botUserId
      ) {
        this.deps.onError('identity_changed')
        return false
      }
      try {
        await callSlack(
          this.deps.fetch,
          'chat.postMessage',
          current.botToken,
          { channel: place.channelId, thread_ts: place.threadTs, [field]: text },
          this.deps.signal
        )
        return true
      } catch (error) {
        const failure =
          error instanceof SlackApiError ? error : new SlackApiError('network', 'uncertain')
        if (field === 'markdown_text' && failure.code === 'invalid_arguments') {
          field = 'text'
          continue
        }
        const retry =
          attempt < MAX_TRIES &&
          (failure.delivery === 'not_sent' ||
            (failure.code === 'ratelimited' && (failure.retryAfterMs ?? 0) <= MAX_COOLDOWN_MS))
        if (!retry) {
          this.deps.onError(failure.delivery === 'uncertain' ? 'reply_uncertain' : failure.code)
          return false
        }
        const wait = failure.retryAfterMs ?? 2_000 * attempt
        try {
          await (this.deps.sleep ?? sleepFor)(wait, this.deps.signal)
        } catch {
          return false
        }
      }
    }
  }
}
