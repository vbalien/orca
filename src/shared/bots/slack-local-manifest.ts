// The Slack app manifest the owner pastes at api.slack.com/apps ("From a manifest") to make a bot's
// own app: an agent view, Socket Mode on, and the scopes and events stage 1 reads.
// Kept in step with docs/slack-local-connector.md.

const yamlString = (value: string): string => JSON.stringify(value)

export function slackLocalManifest(botName: string): string {
  const name = botName.trim().slice(0, 35) || 'Orca bot'
  return `display_information:
  name: ${yamlString(name)}
  description: "An Orca bot that runs on its owner's computer."
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: ${yamlString(name)}
    always_online: false
  agent_view:
    agent_description: ${yamlString(`${name} works in Orca on its owner's computer. Ask it about code and tasks.`)}
    suggested_prompts:
      - title: "What can you do?"
        message: "What can you help me with?"
      - title: "Status"
        message: "What are you working on right now?"
oauth_config:
  scopes:
    bot:
      - assistant:write
      - app_mentions:read
      - chat:write
      - channels:history
      - groups:history
      - im:history
      - im:read
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.im
      - message.channels
      - message.groups
      - app_home_opened
      - app_context_changed
      - agent_session_stopped
      - agent_session_title_changed
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
`
}
