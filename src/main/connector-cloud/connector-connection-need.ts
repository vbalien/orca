// Whether this host holds the connector connection: only a host the cloud can bring work to does.
import { botHasConnector } from '../../shared/bots/bot-has-connector'
import type { ConnectorTrigger } from '../../shared/connectors/connector-cloud-contract'

/** A bot on Slack, Linear or GitHub, or a webhook rule the hello lists; home-chat-only bots hear nothing. */
export function hostNeedsConnector(
  bots: readonly Parameters<typeof botHasConnector>[0][],
  triggers: readonly Pick<ConnectorTrigger, 'source'>[]
): boolean {
  return bots.some(botHasConnector) || triggers.some((trigger) => trigger.source === 'webhook')
}
