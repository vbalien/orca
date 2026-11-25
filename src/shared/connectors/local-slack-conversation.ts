// A Slack thread a bot's own Slack app answers from this computer, never through Orca Cloud. Its
// source is desktop-only: the cloud contract can't name it, and older Orcas skip its links.
export const LOCAL_SLACK_SOURCE = 'slack-local'

export type LocalSlackPlace = {
  teamId: string
  channelId: string
  /** The thread's root message; a DM's top-level message starts its own thread. */
  threadTs: string
  botUserId: string
}

const SLACK_ID = /^[A-Z0-9]{2,32}$/
const SLACK_TS = /^\d{1,12}\.\d{1,8}$/

export function isLocalSlackConversation(key: { source: string } | null | undefined): boolean {
  return key?.source === LOCAL_SLACK_SOURCE
}

/** `T:C:ts:UBOT`, the shape Slack thread ids take elsewhere in Orca. */
export function localSlackConversation(place: LocalSlackPlace): {
  source: typeof LOCAL_SLACK_SOURCE
  externalId: string
} {
  const { teamId, channelId, threadTs, botUserId } = place
  return {
    source: LOCAL_SLACK_SOURCE,
    externalId: `${teamId}:${channelId}:${threadTs}:${botUserId}`
  }
}

export function parseLocalSlackConversation(externalId: string): LocalSlackPlace | null {
  const [teamId, channelId, threadTs, botUserId, ...rest] = externalId.split(':')
  if (
    rest.length > 0 ||
    !teamId ||
    !channelId ||
    !threadTs ||
    !botUserId ||
    !SLACK_ID.test(teamId) ||
    !SLACK_ID.test(channelId) ||
    !SLACK_TS.test(threadTs) ||
    !SLACK_ID.test(botUserId)
  ) {
    return null
  }
  return { teamId, channelId, threadTs, botUserId }
}

/** A ref that names a Linear or GitHub place for certain; a bare name or id could be Slack's. */
export function isLinearOrGitHubRef(ref: string): boolean {
  return /^(?:linear|github):|^[\w.-]+\/[\w.-]+#\d+$|^[A-Z][A-Z0-9]*-\d+$|^https:\/\/(?:github\.com|linear\.app)\//.test(
    ref.trim()
  )
}
