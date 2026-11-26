// Bots whose Slack runs through their own app on this computer: one Socket Mode connection each,
// their messages into the conversation seam, and their answers back to the thread. Electron hosts
// only: the desktop app and `orca serve` on Electron.
import type { Bot } from '../../shared/bot-types'
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
import { canonicalLocalChat, SlackLocalWatch } from './slack-local-watch'
import { SlackLocalParticipations } from './slack-local-participation'
import { findLink } from '../external-conversations/external-conversation-links'
import { SlackLocalAnswers } from './slack-local-answers'
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
  private readonly answers: SlackLocalAnswers
  // Bumped whenever a bot's connection is let go, so a load already under way doesn't connect.
  private readonly generations = new Map<string, number>()
  private known = new Set<string>()
  // Read lazily: deps is set by the time a link is looked up.
  private readonly participations = new SlackLocalParticipations(
    (externalId) => findLink(this.deps.store, { source: 'slack-local', externalId }) !== null
  )

  readonly config: SlackLocalConfig

  constructor(private readonly deps: SlackLocalServiceDeps) {
    this.fetch = deps.fetch ?? globalThis.fetch
    this.answers = new SlackLocalAnswers({
      fetch: this.fetch,
      credentials: (botId) => this.settledCredentials(botId),
      onError: (botId, code) => {
        this.replyErrors.set(botId, code)
        this.changed()
      },
      onDelivered: (botId) => {
        if (this.replyErrors.delete(botId)) {
          this.changed()
        }
      },
      participation: (botId) => this.participations.of(botId),
      canPost: (_botId, externalId) => canonicalLocalChat(deps.store, externalId)
    })
    this.watch = new SlackLocalWatch({
      runtime: deps.runtime,
      store: deps.store,
      deliver: (botId, event) => this.deliver(botId, event),
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
          this.answers.drop(botId)
          this.problems.delete(botId)
          this.replyErrors.delete(botId)
          this.participations.forget(botId)
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
    this.answers.keepOnly(new Set())
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
        this.participations.forget(botId)
      }
    }
    this.known = present
    for (const botId of this.running.keys()) {
      if (!wanted.has(botId)) {
        this.close(botId)
      }
    }
    this.answers.keepOnly(wanted)
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
      participation: this.participations.of(botId),
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
      ...(this.deps.wakeGate ? { wakeGate: this.deps.wakeGate } : {}),
      ...(this.deps.socketFactory ? { socketFactory: this.deps.socketFactory } : {})
    })
    this.running.set(botId, running)
    this.replyErrors.delete(botId)
    running.client.start()
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

  /** A local thread's event for its bot's answers (the watch's way in); they post once its
   *  connection is (re)made. */
  deliver(botId: string, event: ConversationEvent): void {
    if (this.wants(this.bot(botId))) {
      this.answers.observe(botId, event)
    }
  }

  /** The bot's credentials once any reload under way settles; null when it isn't connected. */
  private async settledCredentials(botId: string) {
    for (let pending = this.restarting.get(botId); pending; pending = this.restarting.get(botId)) {
      await pending.catch(() => undefined)
    }
    const running = this.running.get(botId)
    return running
      ? {
          botToken: running.secrets.botToken,
          identity: { teamId: running.secrets.teamId, botUserId: running.secrets.botUserId }
        }
      : null
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

/** This host's local Slack service; null on hosts without it (orcad). */
export function slackLocalService(): SlackLocalService | null {
  return installed
}

export function setSlackLocalService(service: SlackLocalService | null): void {
  installed = service
}
