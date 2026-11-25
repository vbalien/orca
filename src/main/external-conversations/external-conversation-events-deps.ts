// What ConversationEvents reads and is told through: the link store, status rows and chat feed,
// delivery records, and which links it is about.
import type { ConversationReplyFill } from './external-conversation-reply-fill'
import type { SlackMirrorTurn } from './slack-mirror'
import type { AgentJournalCursor } from '../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentPaneChange } from '../agent-hooks/observations/agent-transition-detector'
import type { PendingPrompt } from '../../shared/agent-status/contracts/agent-pending-prompt'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type {
  ConnectorActsFor,
  ConnectorTurnOrigin
} from '../../shared/connectors/connector-cloud-contract'
import type { ConnectorWorkLink } from '../../shared/connector-work-link-contract'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { ChatNews } from './external-conversation-chat'
import type { ExternalConversationLinkStore } from './external-conversation-links'
import type { StructuredAgentSessionPromptStanding } from '../native-chat/agent-session-wire/observations/structured-agent-session-prompt-standing'
import type { ConversationWorkersDeps } from './external-conversation-workers'
import type { ConversationTurnActivity } from './external-conversation-turn-activity'

export type ConversationEventsDeps = {
  store: ExternalConversationLinkStore
  readHookRow: (paneKey: string) => AgentStatusIpcPayload | null
  onAgentPaneChange: (listener: (change: AgentPaneChange) => void) => () => void
  pendingPrompt: (link: ExternalConversationLink) => PendingPrompt | null
  /** A shown prompt's standing in the chat's journal; `unknown` when the chat can't tell now. */
  promptStanding: (
    link: ExternalConversationLink,
    promptId: string,
    cursor?: AgentJournalCursor
  ) => StructuredAgentSessionPromptStanding
  promptCursor?: (link: ExternalConversationLink, id: string) => AgentJournalCursor | undefined
  /** Native chats' prompts and turn ends; returns the release. */
  onChatNews: (listener: (news: ChatNews) => void) => () => void
  onWatchDisposed?: () => void
  /** Read once per ended chat turn. */
  chatTurnOrigin: (sessionId: string, turnAt: number | null) => ConnectorTurnOrigin
  /** Whether a delivery was sent to the chat (or its running turn claims some) and it hasn't ended. */
  chatTurnDelivered: (sessionId: string) => boolean
  /** The delivery a chat turn that began at `turnAt` answers; taken once. */
  chatTurnDelivery: (sessionId: string, turnAt: number) => string | undefined
  /** Whether a delivery the chat took waits for a turn to name it. */
  chatTurnWaiting: (sessionId: string) => boolean
  /** Whether reports from workers its conversation's turns started opened the chat's running turn. */
  runningTurnReported: (sessionId: string) => boolean
  /** The pull requests a bot conversation's work opened, read once per ended turn. */
  workLinks: (link: ExternalConversationLink) => Promise<ConnectorWorkLink[]>
  workerActivities: ConversationWorkersDeps['workerActivities']
  /** Whether the cloud routes a bot's prompts by who raised them (prompts.audience). */
  promptsAudience: () => boolean
  /** The ended turn's owner posts to its Slack thread, taken once; null when none posted. */
  mirrorTurn?: (sessionId: string) => SlackMirrorTurn | null
  /** Whom a chat's conversation acts for, as Orca recorded it. */
  actsForOf?: (sessionId: string) => ConnectorActsFor | undefined
  replyFill?: () => ConversationReplyFill | null
  /** The message that opened the chat's running turn; null when none runs. */
  turnOpener: (sessionId: string) => AgentJournalRenderItem | null
  turnPlan?: ConstructorParameters<typeof ConversationTurnActivity>[0]['turnPlan']
  turnStartedAt?: (sessionId: string) => number | null
  resolvedPrompt?: (
    sessionId: string,
    itemId: string
  ) => AgentJournalRenderItem | null | Promise<AgentJournalRenderItem | null>
  setTimer: (run: () => void, delayMs: number) => { cancel: () => void }
  now: () => number
  /** The links these events are about; absent, every link. The rest read as unlinked here. */
  audience?: (link: ExternalConversationLink) => boolean
}
