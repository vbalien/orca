// The sample Slack message the editor's preview builds a request for (English, like the rules OpenAI
// reads); the "Insert example" configs live with the default rules.
import type { SlackGateEvent } from '../../../../../../shared/bots/bot-slack-gate'

/** The message the preview builds a request for: a reply in a thread the bot answered in. */
export const SLACK_GATE_SAMPLE_EVENT: SlackGateEvent = {
  eventId: 'preview',
  case: 'thread_reply',
  teamId: 'T0',
  channelId: 'C0',
  placeKind: 'public_channel',
  from: { userId: 'U0', name: 'Dana', role: 'member' },
  text: 'Yes, please do that.',
  mentioned: false,
  context: [
    { kind: 'earlier', text: 'The deploy failed again.' },
    { kind: 'self', text: 'Should I roll back to the last release?' }
  ]
}
