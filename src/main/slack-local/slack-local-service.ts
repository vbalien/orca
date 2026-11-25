// Bots whose Slack runs through their own app on this computer: one Socket Mode connection each,
// their messages into the conversation seam, and their answers back to the thread. Desktop only.
import type { Bot } from '../../shared/bot-types'
import type { LocalSlackPlace } from '../../shared/connectors/local-slack-conversation'
import type { ConversationEvent } from '../external-conversations/external-conversation-events'
import { usesLocalSlack } from '../../shared/bots/bot-slack-connection'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { runtimeConversationHost } from '../external-conversations/external-conversation-runtime-host'
import type { ExternalConversationLinkStore } from '../external-conversations/external-conversation-links'
import type { LocalSlackWakeGate } from './slack-local-wake-gate'
import type { SocketModeSocket } from './slack-socket-mode-client'
import type { SlackLocalSecrets, SlackLocalTokenStore } from './slack-local-token-store'
import { slackBotIdentity, SlackApiError, type SlackFetch } from './slack-web-api'
import { repairLocalIdentity, SlackLocalConfig } from './slack-local-config'
import { slackLocalConnection, type SlackLocalRunning } from './slack-local-connection'
import { SlackLocalWatch } from './slack-local-watch'
import {
  slackLocalStatus,
  slackTriggerAutomations,
  type SlackLocalAutomations,
  type SlackLocalStatus
} from './slack-local-status'

export type SlackLocalServiceDeps = {
  runtime: Pick<
    OrcaRuntimeService,
    | 'bots'
    | 'onBotsWritten'
    | 'notifyBotsChanged'
    | 'getExternalConversationSeam'
    | 'getConnectorCloud'
  > &
    Parameters<typeof runtimeConversationHost>[0]
  store: ExternalConversationLinkStore &
    SlackLocalAutomations & {
      onSettingsChanged?: (listener: (updates: { botsEnabled?: unknown }) => void) => () => void
    }
  tokens: SlackLocalTokenStore
  fetch?: SlackFetch
  socketFactory?: (url: string) => SocketModeSocket
  wakeGate?: LocalSlackWakeGate
}

const MAX_HELD = 50
const AUTH_ERRORS = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'account_inactive'])

export class SlackLocalService {
  private readonly running = new Map<string, SlackLocalRunning>()
  // Why a bot isn't connected, when it isn't for a reason worth saying.
  private readonly problems = new Map<string, string>()
  private readonly replyErrors = new Map<string, string>()
  private readonly watch: SlackLocalWatch
  private readonly fetch: SlackFetch
  private stopped = false
  private releaseBots: (() => void) | null = null
  private releaseSettings: (() => void) | undefined
  private restarting = new Map<string, Promise<void>>()
  // Answers that finished while a bot's connection was being remade.
  private readonly held = new Map<string, { place: LocalSlackPlace; event: ConversationEvent }[]>()
  // Bumped whenever a bot's connection is let go, so a load already under way doesn't connect.
  private readonly generations = new Map<string, number>()
  private known = new Set<string>()

  readonly config: SlackLocalConfig

  constructor(private readonly deps: SlackLocalServiceDeps) {
    this.fetch = deps.fetch ?? globalThis.fetch
    this.watch = new SlackLocalWatch({
      runtime: deps.runtime,
      store: deps.store,
      deliver: (botId, place, event) => this.deliver(botId, place, event),
      seamGone: () => this.reconcile()
    })
    this.config = new SlackLocalConfig({
      runtime: deps.runtime,
      store: deps.store,
      tokens: deps.tokens,
      fetch: this.fetch,
      ...(deps.socketFactory ? { socketFactory: deps.socketFactory } : {}),
      host: {
        release: (botId) => {
          this.close(botId)
          this.problems.delete(botId)
          this.replyErrors.delete(botId)
        },
        reconcile: () => this.reconcile(),
        restart: (botId) => this.restart(botId)
      }
    })
  }

  start(): void {
    this.releaseBots = this.deps.runtime.onBotsWritten(() => this.reconcile())
    this.releaseSettings = this.deps.store.onSettingsChanged?.((updates) => {
      if (updates.botsEnabled !== undefined) {
        this.reconcile()
      }
    })
    this.reconcile()
    void this.forgetOrphanTokens()
  }

  /** Tokens of bots that no longer exist, left by a delete while Orca was closed. */
  private async forgetOrphanTokens(): Promise<void> {
    const bots = new Set(this.deps.runtime.bots.list().map((bot) => bot.id))
    for (const botId of await this.deps.tokens.botIds().catch(() => [])) {
      if (!bots.has(botId)) {
        await this.deps.tokens.remove(botId).catch(() => undefined)
      }
    }
  }

  stop(): void {
    this.stopped = true
    this.releaseBots?.()
    this.releaseSettings?.()
    for (const botId of this.running.keys()) {
      this.close(botId)
    }
    this.watch.ensure(false)
  }

  private bot(botId: string): Bot | null {
    return this.deps.runtime.bots.list().find((bot) => bot.id === botId) ?? null
  }

  /** Bots on their own Slack app that listen now: bots on, and not paused. */
  private wants(bot: Bot | null): bot is Bot {
    return bot !== null && usesLocalSlack(bot) && !bot.paused && this.deps.runtime.bots.enabled()
  }

  /** Clients for exactly the bots that want one; the tokens a running client holds stay its own. */
  reconcile(): void {
    if (this.stopped) {
      return
    }
    const bots = this.deps.runtime.bots.list()
    const wanted = new Set(bots.filter((bot) => this.wants(bot)).map((bot) => bot.id))
    // A deleted bot's tokens go with it.
    const present = new Set(bots.map((bot) => bot.id))
    for (const botId of this.known) {
      if (!present.has(botId)) {
        void this.deps.tokens.remove(botId).catch(() => undefined)
        this.problems.delete(botId)
        this.replyErrors.delete(botId)
      }
    }
    this.known = present
    for (const botId of this.running.keys()) {
      if (!wanted.has(botId)) {
        this.close(botId)
      }
    }
    for (const botId of wanted) {
      if (!this.running.has(botId) && !this.restarting.has(botId) && !this.problems.has(botId)) {
        void this.restart(botId)
      }
    }
    this.ensureWatch(wanted.size > 0)
  }

  /** Loads the bot's saved tokens again and reconnects with them. */
  restart(botId: string): Promise<void> {
    const previous = this.restarting.get(botId) ?? Promise.resolve()
    const next = previous.then(() => this.load(botId))
    const settled = next.finally(() => {
      if (this.restarting.get(botId) === settled) {
        this.restarting.delete(botId)
        this.held.delete(botId)
        // A load let go meanwhile connected nothing: whatever is wanted now starts.
        queueMicrotask(() => this.reconcile())
      }
    })
    this.restarting.set(botId, settled)
    return settled
  }

  private async load(botId: string): Promise<void> {
    this.close(botId)
    this.problems.delete(botId)
    const generation = this.generations.get(botId) ?? 0
    // Nothing let it go while it loaded, and it still wants to listen: else this load says nothing.
    const current = () =>
      !this.stopped &&
      (this.generations.get(botId) ?? 0) === generation &&
      this.wants(this.bot(botId))
    const stop = (problem: string): void => {
      if (current()) {
        this.problems.set(botId, problem)
      }
      this.changed()
    }
    const bot = this.bot(botId)
    if (!current() || !bot) {
      return this.changed()
    }
    let secrets: SlackLocalSecrets | null
    try {
      secrets = await this.deps.tokens.read(botId)
    } catch {
      return stop('tokens_unreadable')
    }
    if (!secrets) {
      return stop('needs_tokens')
    }
    if (!current()) {
      return this.changed()
    }
    if (!(await repairLocalIdentity(this.deps.runtime, bot, secrets))) {
      return stop('token_mismatch')
    }
    // The token still speaks as the app the file says; a refused one waits for new tokens.
    try {
      const identity = await slackBotIdentity(this.fetch, secrets.botToken)
      if (identity.teamId !== secrets.teamId || identity.botUserId !== secrets.botUserId) {
        return stop('token_mismatch')
      }
    } catch (error) {
      if (error instanceof SlackApiError && AUTH_ERRORS.has(error.code)) {
        return stop(error.code)
      }
    }
    if (!current()) {
      return this.changed()
    }
    this.connect(botId, secrets)
  }

  private connect(botId: string, secrets: SlackLocalSecrets): void {
    const running = slackLocalConnection({
      secrets,
      fetch: this.fetch,
      runtime: this.deps.runtime,
      bot: () => this.bot(botId),
      isCurrent: (abort) => this.running.get(botId)?.abort === abort,
      onState: (state) => {
        const current = this.running.get(botId)
        if (current) {
          current.state = state
          this.changed()
        }
      },
      onReplyError: (code) => {
        this.replyErrors.set(botId, code)
        this.changed()
      },
      onReplyDelivered: () => {
        if (this.replyErrors.delete(botId)) {
          this.changed()
        }
      },
      ...(this.deps.wakeGate ? { wakeGate: this.deps.wakeGate } : {}),
      ...(this.deps.socketFactory ? { socketFactory: this.deps.socketFactory } : {})
    })
    this.running.set(botId, running)
    this.replyErrors.delete(botId)
    running.client.start()
    // Answers that finished while it was remade go now, through the same app only.
    const held = this.held.get(botId) ?? []
    this.held.delete(botId)
    held.forEach(({ place, event }) => this.deliver(botId, place, event))
    this.ensureWatch(true)
    this.changed()
  }

  private close(botId: string): void {
    this.generations.set(botId, (this.generations.get(botId) ?? 0) + 1)
    const running = this.running.get(botId)
    if (running) {
      this.running.delete(botId)
      running.abort.abort()
      running.client.stop()
    }
  }

  private ensureWatch(wanted: boolean): void {
    this.watch.ensure(wanted && !this.stopped)
  }

  /** An answer for the bot's thread: to its connection, or held while that is being remade. */
  private deliver(botId: string, place: LocalSlackPlace, event: ConversationEvent): void {
    const running = this.running.get(botId)
    if (running) {
      if (
        place.teamId === running.secrets.teamId &&
        place.botUserId === running.secrets.botUserId
      ) {
        running.replies.observe(event)
      }
      return
    }
    if (this.restarting.has(botId)) {
      const held = this.held.get(botId) ?? []
      if (held.length < MAX_HELD) {
        this.held.set(botId, [...held, { place, event }])
      }
    }
  }

  private changed(): void {
    this.deps.runtime.notifyBotsChanged({ kinds: ['settings'] })
  }

  async status(botId: string): Promise<SlackLocalStatus> {
    const bot = this.bot(botId)
    return await slackLocalStatus({
      bot,
      running: this.running.get(botId)?.state ?? null,
      listening: this.wants(bot),
      problem: this.problems.get(botId) ?? null,
      lastReplyError: this.replyErrors.get(botId) ?? null,
      tokens: this.deps.tokens,
      slackTriggerAutomations: bot ? slackTriggerAutomations(this.deps.store, bot.id) : []
    })
  }
}

let installed: SlackLocalService | null = null

/** This desktop's local Slack service; null on hosts without it (orcad, `orca serve`). */
export function slackLocalService(): SlackLocalService | null {
  return installed
}

export function setSlackLocalService(service: SlackLocalService | null): void {
  installed = service
}
