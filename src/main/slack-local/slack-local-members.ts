// People who may ask a bot through its own Slack app are added only by the owner's desktop, for the
// workspace that app is in (bots.slackLocal.addAskers); everything else may only remove them.
import type { Bot, BotMember } from '../../shared/bot-types'
import { LOCAL_SLACK_SOURCE } from '../../shared/connectors/local-slack-conversation'

export const LOCAL_SLACK_ASKERS_REFUSAL =
  "People who may ask through the bot's own Slack app are added in its Slack settings in Orca."

const key = (member: Pick<BotMember, 'id' | 'workspaceId'>): string =>
  `${member.workspaceId ?? ''}:${member.id}`

const localKeys = (members: readonly BotMember[]): Set<string> =>
  new Set(members.filter((member) => member.source === LOCAL_SLACK_SOURCE).map(key))

/** Throws when a generic bot update would add a local Slack asker the bot doesn't already have. */
export function refuseLocalSlackMemberAdds(
  current: Pick<Bot, 'members'>,
  updates: { members?: readonly BotMember[]; addMembers?: readonly BotMember[] }
): void {
  const had = localKeys(current.members)
  const incoming = [...(updates.members ?? []), ...(updates.addMembers ?? [])]
  if (incoming.some((member) => member.source === LOCAL_SLACK_SOURCE && !had.has(key(member)))) {
    throw new Error(LOCAL_SLACK_ASKERS_REFUSAL)
  }
}
