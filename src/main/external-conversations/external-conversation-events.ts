import { setPromptPublication } from './external-conversation-prompt-publication'
import type { AgentTurnOutcome } from '../../shared/agent-status/lifecycle/agent-turn-outcome'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type {
  ConnectorActsFor,
  ConnectorFailure,
  ConnectorPrompt,
  ConnectorTurnFor,
  ConnectorTurnOrigin
} from '../../shared/connectors/connector-cloud-contract'
import type { ConnectorWorkLink } from '../../shared/connector-work-link-contract'
import type { ConversationEventsDeps } from './external-conversation-events-deps'
import { ChatTurns, conversationWorking } from './external-conversation-chat-turns'
import { allLinks, findLinkForPane, type LinkedConversation } from './external-conversation-links'
import { writeLinkFact } from './external-conversation-link-writes'
import { AnsweredPrompts } from './external-conversation-answered-prompts'
import { ShownPrompts, type SnapshotEntryTrace } from './external-conversation-snapshot-prompts'
import { ConversationTurnActivity, type ActivityEvent } from './external-conversation-turn-activity'
import {
  conversationPane,
  replyTargetOf,
  type ConversationPane,
  type ReplyTarget
} from './external-conversation-types'

export type { ConversationEventsDeps } from './external-conversation-events-deps'

export type ConversationEvent =
  // actsFor: whom the linked chat acts for, once Orca recorded it.
  | (ConversationPane & {
      kind: 'linked'
      agent: ExternalConversationLink['agent']
      actsFor?: ConnectorActsFor
    })
  // The linked chat was deleted, so its thread is free.
  | (ConversationPane & { kind: 'unlinked' })
  // answered: the agent worked past this prompt, so someone answered it in Orca.
  | (ConversationPane & {
      kind: 'prompt'
      prompt: ConnectorPrompt
      answered?: true
      answeredWith?: string
    })
  // deliveryId: the delivery the turn answers, when exactly one started it.
  | (ConversationPane & { kind: 'turn-started'; at: number; deliveryId?: string })
  | (ConversationPane & {
      kind: 'turn-ended'
      /** The ended turn's turn-started `at`; null when its start predates this watch. The cloud ends
       *  its open turn when that is no newer, so a restart's end can name this start as a fence. */
      turnId: number | null
      /** Host verdict; null means none was recorded. */
      stopReason: AgentTurnOutcome | null
      lastAssistantMessage?: string
      at: number
      /** Whether a connector delivery or someone in Orca asked for the turn. */
      origin?: ConnectorTurnOrigin
      /** Why a failed turn failed. */
      failure?: ConnectorFailure
      /** Pull requests the conversation's bot work opened. */
      links?: ConnectorWorkLink[]
      /** An Orca-typed turn whose owner's words posted to the Slack thread: its reply posts too. */
      mirror?: true
      /** Whom a turn no delivery started acts for, so its final post counts as them on Slack. */
      turnFor?: ConnectorTurnFor
      /** The thread's turn state only: its answer goes through the reply outbox. */
      stateOnly?: true
      /** Paused at a usage limit with a known reset: an automatic continue picks it up then. */
      resumes?: true
    })
  // Whether orchestration workers the chat started still run, told on each change.
  | (ConversationPane & { kind: 'workers'; running: boolean })
  // What a heard turn is doing now (the tool it is inside), a few seconds apart at most.
  | ActivityEvent

export type ConversationSnapshot = {
  kind: 'snapshot'
  conversations: (ConversationPane & {
    agent: ExternalConversationLink['agent']
    working: boolean
    prompt: ConnectorPrompt | null
    /** The pane's latest turn, as its turn events name it; null before any. */
    turnId: number | null
    /** When the conversation last showed activity: its link, or its agent's latest status report. */
    activeAt: number
    /** Once the chat's workers were read. */
    workersRunning?: boolean
    /** Why the entry reads as it does, for the snapshot's trace only; never sent. */
    trace?: SnapshotEntryTrace
  })[]
}

export type ConversationWatchListener = (event: ConversationSnapshot | ConversationEvent) => void

/** Linked chats' events: turn starts from their status rows, prompts and ends from their host's feed. */
export class ConversationEvents {
  private readonly listeners = new Set<ConversationWatchListener>()
  private readonly chats: ChatTurns
  private readonly answered = new AnsweredPrompts({
    working: (paneKey) =>
      this.linkedFor(paneKey) !== null && conversationWorking(this.deps.readHookRow(paneKey)),
    emit: (event) => this.emit(event),
    resolvedPrompt: (sessionId, itemId) => this.deps.resolvedPrompt?.(sessionId, itemId) ?? null
  })
  // What each told turn is doing, from its status row's tool.
  private readonly activity: ConversationTurnActivity
  // Outlives a watch, so a reconnect never withdraws a prompt the chat still holds.
  private readonly shown = new ShownPrompts()
  private release: (() => void) | null = null

  constructor(private readonly deps: ConversationEventsDeps) {
    this.activity = new ConversationTurnActivity({
      ...deps,
      emit: (event) => this.emit(event),
      toldTurn: (paneKey) => this.chats.toldTurn(paneKey),
      linkedFor: (paneKey) => this.linkedFor(paneKey)
    })
    this.chats = new ChatTurns({
      ...deps,
      linkedFor: (paneKey) => this.linkedFor(paneKey),
      emit: (event) => this.emit(event),
      keepAdoptedTurn: ({ link, workspace }, adoptedTurn) => {
        try {
          writeLinkFact(deps.store, link, { adoptedTurn }, workspace)
        } catch (error) {
          // Only a restarted watch reads it back; this one keeps the adoption in memory.
          console.warn('[connector] could not keep an adopted turn on its link', error)
        }
      },
      turnEnded: (paneKey) => this.shown.forgetPane(paneKey)
    })
  }

  watch(listener: ConversationWatchListener): () => void {
    if (!this.release) {
      const unsubscribe = this.deps.onAgentPaneChange((change) => {
        // The turn's start first, then what that turn is doing.
        ;[this.chats, this.activity].forEach((watcher) => watcher.observe(change.paneKey))
        this.answered.settle(change.paneKey)
      })
      const releaseChats = this.deps.onChatNews((news) => this.chats.news(news))
      this.release = () => {
        unsubscribe()
        releaseChats()
      }
    }
    this.listeners.add(listener)
    // Subscribe before reading the snapshot to avoid losing intervening changes.
    const snapshot = this.snapshot()
    this.answered.saw(snapshot)
    listener(snapshot)
    this.chats.workers.watched(snapshot.conversations)
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.dispose()
      }
    }
  }

  linked({ workspace, link }: LinkedConversation, actsFor?: ConnectorActsFor): void {
    this.emit({
      kind: 'linked',
      ...conversationPane(link, workspace.worktreeId),
      agent: link.agent,
      ...(actsFor ? { actsFor } : {})
    })
    this.chats.joined(link.paneKey, link.sessionId)
  }

  /** A link dropped because its chat is gone. */
  unlinked({ workspace, link }: LinkedConversation): void {
    this.shown.forgetConversation(link)
    this.emit({ kind: 'unlinked', ...conversationPane(link, workspace.worktreeId) })
  }

  /** A delivery an already linked chat took. */
  delivered(link: ExternalConversationLink): void {
    this.chats.delivered(link.paneKey, link.sessionId)
  }

  /** Before a connector answers a prompt; call the result if the answer didn't land. */
  answering(paneKey: string, promptId: string): () => void {
    const { generation } = this.shown
    const restoreAnswered = this.answered.answering(paneKey, promptId)
    const restoreShown = this.shown.take(paneKey, promptId)
    // An answer that lands after an account reset restores nothing of the old account.
    return () => {
      if (generation === this.shown.generation && restoreShown()) {
        restoreAnswered()
      }
    }
  }

  /** The last watch went: what the chat's turns were is read afresh next time; shown prompts stay. */
  dispose(): void {
    this.release?.()
    this.release = null
    this.listeners.clear()
    this.chats.clear()
    this.activity.clear()
    this.answered.clear()
    this.deps.onWatchDisposed?.()
  }

  /** Signed out or another account: nothing the last one was told carries over. */
  reset(): void {
    this.dispose()
    this.chats.reset()
    this.shown.reset()
  }

  private snapshot(): ConversationSnapshot {
    return {
      kind: 'snapshot',
      conversations: [...allLinks(this.deps.store)].filter(this.hears).map((linked) => {
        const { workspace, link } = linked
        const row = this.deps.readHookRow(link.paneKey)
        // First, as showing a prompt can adopt the turn that raised it.
        const live = this.chats.shownPrompt(linked, false)
        const hears = this.chats.hears(link)
        // A prompt the cloud shows stays shown while the chat's journal still holds it.
        const restated = live
          ? null
          : this.shown.restate(link, (promptId, cursor) =>
              this.deps.promptStanding(link, promptId, cursor)
            )
        const prompt = live ?? restated?.prompt ?? null
        const entry: ConversationSnapshot['conversations'][number] = {
          ...conversationPane(link, workspace.worktreeId),
          agent: link.agent,
          working: hears && conversationWorking(row),
          prompt,
          turnId: hears ? this.chats.adopt(link.paneKey) : null,
          activeAt: Math.max(link.createdAt, row?.receivedAt ?? 0),
          ...this.chats.workers.snapshotOf(link.paneKey),
          trace: {
            sessionId: link.sessionId,
            promptId: live?.promptId ?? restated?.promptId ?? null,
            heard: this.chats.heardBy(link),
            prompt: live ? 'live' : restated?.prompt ? 'restated' : 'none',
            ...(restated ? { standing: restated.standing } : {})
          }
        }
        if (prompt) {
          setPromptPublication(
            entry,
            this.shown.offer(
              link,
              prompt.promptId,
              live ? () => this.deps.promptCursor?.(link, prompt.promptId) : undefined
            )
          )
        }
        return entry
      })
    }
  }

  /** Where this chat's agent replies: its conversation and the turn it is in, as turn events name it. */
  replyTarget(paneKey: string): ReplyTarget | null {
    const linked = this.linkedFor(paneKey)
    const opener = linked && this.deps.turnOpener(linked.link.sessionId)
    return linked && replyTargetOf(linked, this.chats.turnOf(paneKey), opener)
  }

  private linkedFor(paneKey: string): LinkedConversation | null {
    const linked = findLinkForPane(this.deps.store, paneKey)
    return linked && this.hears(linked) ? linked : null
  }

  private readonly hears = ({ link }: LinkedConversation) => this.deps.audience?.(link) ?? true

  /** A turn end told from outside the chats' feed (one the Slack mirror held); false with no watcher. */
  tell(event: Extract<ConversationEvent, { kind: 'turn-ended' }>): boolean {
    if (this.listeners.size === 0) {
      return false
    }
    this.emit(event)
    return true
  }

  private emit(event: ConversationEvent): void {
    this.answered.saw(event)
    if (event.kind === 'prompt') {
      if (event.answered) {
        this.shown.forgetPrompt(event.paneKey, event.prompt.promptId)
      } else {
        const linked = this.linkedFor(event.paneKey)
        if (linked) {
          const promptId = event.prompt.promptId
          setPromptPublication(
            event,
            this.shown.offer(linked.link, promptId, () =>
              this.deps.promptCursor?.(linked.link, promptId)
            )
          )
        }
      }
    }
    for (const listener of this.listeners) {
      // Isolate listener failures so other watchers still receive the event.
      try {
        listener(event)
      } catch (error) {
        console.error('[connector] watch listener threw', error)
      }
    }
  }
}
