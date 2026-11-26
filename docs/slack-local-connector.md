# A bot's own Slack app (local Slack connector)

A bot can answer Slack through a Slack app you create yourself. The bot's computer connects to that app
directly with Slack's Socket Mode, so Slack messages never pass through Orca Cloud. The bot's Linear
and GitHub connections keep using Orca Cloud as before.

This is stage 1. It does:

- take mentions (`@bot …`), direct messages, and replies in threads the bot was asked in;
- check Who can ask on the bot's computer (you, and the people you add by Slack member ID);
- post the bot's final message in the same thread.

It does not yet do: a working status or streaming answer, a Stop button, answering approval or
question cards from Slack (the bot says it needs an answer in Orca), `orca slack …` actions, Slack
automation triggers, files, or the Slack mirror of messages typed in Orca. Those come in later stages
and are refused clearly until then.

It runs on the computer the bot runs on, in Orca's Electron runtime: the Orca desktop app while it is
open, or `orca serve` started with `ORCA_SERVE_RUNTIME=electron` (the Node runtime, orcad, refuses it
with that hint). For a bot on a server, set everything up from a computer paired with it: the
Slack settings there talk to the server, and the tokens are sealed in the server's OS keyring (on
Linux, a logged-in session's keyring such as gnome-keyring). An agent's `orca` CLI can't change
these settings, and a phone can't either.

Each bot on its own app holds one Socket Mode WebSocket to Slack from that computer (Slack allows up
to 10 per app). While that computer or Orca is off, the app is offline, and mentions sent meanwhile
may never reach Orca (Slack retries an undelivered event only for a short while). Like Orca Cloud's own
connector, it connects to Slack directly: Orca's proxy setting is not applied to it yet.

## 1. Create the Slack app

1. Open https://api.slack.com/apps and choose **Create New App** → **From a manifest**.
2. Pick the workspace, choose YAML, and paste the manifest below. In Orca, **Copy manifest** in the
   bot's Slack settings gives you the same text with the bot's name filled in.
3. Create the app, then **Install to Workspace** and allow it.

```yaml
display_information:
  name: 'My Bot'
  description: "An Orca bot that runs on its owner's computer."
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: 'My Bot'
    always_online: false
  agent_view:
    agent_description: "My Bot works in Orca on its owner's computer. Ask it about code and tasks."
    suggested_prompts:
      - title: 'What can you do?'
        message: 'What can you help me with?'
      - title: 'Status'
        message: 'What are you working on right now?'
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
```

Notes:

- `agent_view` makes the app an agent in Slack (new apps can only use `agent_view`; an older app's
  switch from `assistant_view` to `agent_view` can't be undone).
- `socket_mode_enabled: true`: Slack sends events over a connection the bot's computer opens, so no
  public URL is needed. Socket Mode apps can't be listed in the Slack Marketplace, which a
  personal bot doesn't need.
- Stage 1 reads `app_mention`, `message.im`, `message.channels` and `message.groups`. The other
  agent events are subscribed already for the next stages and are acknowledged and ignored now.
- Slack says some AI features need a paid plan even though they show on every plan. If Slack asks
  for one, a free Developer Program sandbox workspace works for trying it.

## 2. Get the two tokens

- **Bot User OAuth Token** (`xoxb-…`): the app's **OAuth & Permissions** page, after installing.
- **App-Level Token** (`xapp-…`): **Basic Information** → **App-Level Tokens** → **Generate Token and
  Scopes**, add the `connections:write` scope, and generate.

Keep both private. Orca never shows them again once saved.

## 3. Set up the bot in Orca

1. Open the bot's settings → **Connectors** → **Add** → **Slack**, and choose **Use my own Slack
   app**. (A bot that already uses Orca Cloud's Slack app must remove it first.)
2. Open the new **Slack (your own app)** row. Paste both tokens and **Save tokens**. Orca checks
   them with Slack, seals them with the OS keyring (it refuses to save them without one), and
   connects.
3. Enter **Your Slack member ID** (Slack → your profile → ⋯ → Copy member ID). Only you can ask
   until you add other people by their member IDs.
4. Invite the bot to the channels where it should answer (`/invite @bot`).
5. Optional: **Check before waking** (at the end of the same page) works as it does with Orca Cloud's
   app. It runs on the bot's computer after Who can ask, before the bot wakes. A blocked check starts
   nothing and posts nothing; a check that fails or passes its own timeout does what its **On
   error** setting says; one still undecided after 60 seconds, or cut off by the app disconnecting,
   starts nothing. It reads the message, its place, the asker's
   role, the thread context Orca read, and marks for anything left out (earlier messages not shown,
   a thread that couldn't be read, or a bare mention whose earlier request is unknown). A TypeSafe
   Jev check sends that text to TypeSafe.

## 4. Try it

- Mention the bot in a channel: `@bot what can you do?`. It answers in a thread.
- Reply in that thread without mentioning it: the same chat continues.
- Send it a direct message from the app's Messages tab.
- Someone not on Who can ask mentions it: nothing happens.

Things worth checking and reporting back:

- Whether Slack shows the app as an agent (top bar entry, agent view) in Socket Mode.
- Whether Slack asks for a paid plan anywhere.

To go back to Orca Cloud's Slack app: the row's ⋯ menu → **Switch to Orca Cloud's Slack app**. This
forgets the tokens and the people added for the own app.
