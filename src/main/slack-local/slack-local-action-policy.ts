// What a bot's connector actions may still send to Orca Cloud once its Slack runs through its own
// app on this computer. Fails closed: only what names Linear or GitHub for certain goes.
import type { ConnectorActionArgs } from '../../shared/connector-action-contract'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import {
  findLinkForSession,
  type ExternalConversationLinkStore
} from '../external-conversations/external-conversation-links'
import {
  isLinearOrGitHubRef,
  isLocalSlackConversation
} from '../../shared/connectors/local-slack-conversation'

export const LOCAL_SLACK_ACTION_REFUSAL =
  "This bot talks to Slack through its own app on this computer, and `orca slack` actions aren't available for it yet; nothing was sent. Your final message is posted to the Slack thread that woke you."

const SECONDARY_REFS = ['workspace', 'parent', 'before'] as const
const SLACK_ONLY_ARGS = ['join', 'items', 'cancel', 'choices', 'postAt'] as const

export type LocalSlackActionInput = {
  /** The bot answers Slack through its own app. */
  botUsesLocalSlack: boolean
  /** The conversation the calling chat is linked to, from its link; null when none. */
  linked: { source: string } | null
  /** That conversation as Orca Cloud names it; null for one it can't name. */
  cloudTarget: { source: string } | null
  verb: string
  ref: string | undefined
  args: ConnectorActionArgs
}

/** Null when the action may go to Orca Cloud as before. */
export function localSlackActionRefusal(input: LocalSlackActionInput): string | null {
  // Nothing a local thread's turn writes reaches the cloud through an action.
  if (isLocalSlackConversation(input.linked)) {
    return LOCAL_SLACK_ACTION_REFUSAL
  }
  if (!input.botUsesLocalSlack) {
    return null
  }
  const { verb, ref, args, cloudTarget } = input
  if (ref === undefined) {
    if (verb === 'reply') {
      return cloudTarget?.source === 'linear' || cloudTarget?.source === 'github'
        ? null
        : LOCAL_SLACK_ACTION_REFUSAL
    }
    const onlyOf = Object.keys(args).every((key) => key === 'of')
    return (verb === 'capabilities' || verb === 'places') && onlyOf
      ? null
      : LOCAL_SLACK_ACTION_REFUSAL
  }
  const secondaryOk = SECONDARY_REFS.every((key) => {
    const value = args[key]
    return value === undefined || isLinearOrGitHubRef(value)
  })
  const slackOnly = SLACK_ONLY_ARGS.some((key) => args[key] !== undefined)
  return isLinearOrGitHubRef(ref) && secondaryOk && !slackOnly ? null : LOCAL_SLACK_ACTION_REFUSAL
}

/** The conversation a chat is linked to on this host, read from its link (not a live watch). */
export function linkedConversationOf(
  store: ExternalConversationLinkStore | null,
  sessionId: string
): ExternalConversationLink | null {
  return store ? (findLinkForSession(store, sessionId)?.link ?? null) : null
}
