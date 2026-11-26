# A bot's own Slack app (local Slack connector)

A bot can answer Slack through a Slack app you create yourself. The bot's computer connects to that app
directly with Slack's Socket Mode, so Slack messages never pass through Orca Cloud. The bot's Linear
and GitHub connections keep using Orca Cloud as before.

This is stage 1. It does:

- take mentions (`@bot …`), direct messages, and replies in threads the bot was asked in;
- when its wake gate says so, channel messages no one addressed to it (see "Channel messages" below);
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
- Channel messages need nothing more: `message.channels`/`message.groups` and
  `channels:history`/`groups:history` are in the manifest from the start, so an app made from it doesn't
  need to be reinstalled. The bot must be in the channel (`/invite @bot`).
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
   a thread that couldn't be read, or a bare mention whose earlier request is unknown). An OpenAI
   Decisions check sends that text to OpenAI. For a reply in a thread the bot already answers in, an
   OpenAI check that sends `earlierMessages` reads the messages right before it for itself (up to 3
   pages within 3 seconds; none while Slack asks to wait), marking the bot's own as `this_bot`; the
   chat itself still gets only the new reply.

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

## Channel messages

A bot can also look at messages no one addressed to it in channels it is in: a channel's top-level
message, or a reply in a thread the bot hasn't joined. Its wake gate decides each one, and only what
the gate passes wakes the bot. It is off until you turn it on, and only in the channels you list.

- In **Check before waking**, tick **Channel messages (your own Slack app)** and enter the channel ids
  (Slack → the channel's name → Channel ID at the bottom). The page shows ids, not names: showing names
  needs the `channels:read`/`groups:read` scopes and a reinstall of the app, which this stage avoids.
- **Every message people on Who can ask post in those channels goes to OpenAI** (or your command) to be
  decided, one request per message (about 0.0001–0.0002 USD each with the default rules). Messages from
  people not on Who can ask, from bots and apps, edits, deletes and joins are never sent or decided.
- **A channel message wakes the bot only when the check passes:** not when the gate is off or the channel
  isn't listed, not when the check fails (an error, a timeout, a refusal, a missing key — whatever
  "If the check fails" says; for a mention a missed request is the worse mistake, here an intrusion is),
  and not on an unsure answer (whatever `whenUnsure` says).
- Turning it on with the untouched default rules switches them to **rules for thread replies and channel
  messages** (the `channel` example): the thread question as before, and `asks_the_bot` at 0.9, which
  passes only messages that speak to the bot by name or ask the room for help with what the bot is for.
  Say what that is in `extra.botRole`, every name people use for it in `extra.botNames`, and its
  owner's name in `extra.ownerName` (OpenAI otherwise mixes up similar names).
- The woken bot is told the message wasn't addressed to it and that, if it isn't its to answer, its whole
  final message must be `NO_REPLY`: then nothing is posted. The bot posts nothing before its answer (no
  status, no reaction), so a quiet look leaves no trace.
- A channel message opens a chat of its own kind (its id ends in `:c`). Until the bot posts in that
  thread or someone @mentions it there, the thread's replies stay channel messages (checked the same
  way), and a failed turn or "needs an answer in Orca" isn't posted there. Older Orca builds can't read
  these chats, so going back to one never turns their threads into unchecked replies.
- Rules may say how often a rule may wake the bot (`limit`: `perDay`, `cooldownMinutes`, `chance`), per
  channel and rule; a day starts at local midnight on the bot's computer; counts survive a restart
  (`bot-slack-gate-wakes/`, no message text). A wake is counted when its chat takes the message, and
  `NO_REPLY` still counts. With limits (or a rules script), a failed check never wakes the bot.

### Rules from a script

For per-channel rules, an OpenAI gate can run **Rules from a script**: a command run like a command
gate (on the bot's computer, `/bin/sh -c` in a temporary folder, no key in its environment), once per
message the gate checks. It reads the event as JSON on stdin — a command gate's input (`case`,
`channelId`, `from`, `text`, `context` …) plus `wakes`, this channel's limit counts keyed by
`sha256(question name)` (first 16 hex digits) — and prints one JSON object:

- `{"useSaved": true}`: use the rules saved in the editor;
- `{"wake": true, "reason": "…"}` or `{"wake": false}`: decide now (the reason, one short line, is told
  to the bot);
- `{"ask": { …rules… }}`: rules the editor would accept; Orca asks OpenAI with the saved key and applies
  them as if saved (checks, timeout, limits, logs without text). A rule's `note` becomes the reason.

Anything else, a non-zero exit, more than 64 KiB or a timeout is a failed check, which never wakes the
bot. The script and OpenAI share the gate's time limit; each message costs one process and (for `ask`)
one OpenAI call. A rule's question name is how its limit is counted: keep it the same from message to
message. Logs keep no question names, choices or answers of script-made rules.

The script is a file on the bot's computer, so only that computer's Orca can set or change it (a paired
computer shows it read-only; an agent's CLI can't change the gate). **Keep it outside the bot's folders**:
the bot's agent runs as the same user and could edit it. `fork/gate-rules-script/channel-rules.mjs` is a
starting point (per-channel roles, name matching, a banter limit), and `fork/gate-rules-script/try.ts`
runs a script on a sample event the way Orca does.

A command gate can already tell channels apart: its stdin JSON has `channelId` and `case`, e.g.

```sh
#!/bin/sh
# Wake only for C0123456789; exit 0 wakes, exit 1 doesn't.
jq -e '.channelId == "C0123456789"' >/dev/null
```

### Going back to an older Orca

A gate with limits or a rules script is stored so that builds before this one block every message
they check (they can't honor a limit), and they don't read channel-message chats or channel settings.
If an older Orca rewrites the gate, the page offers **Restore settings an older Orca dropped** as long as
the gate is still what that build left.

## Channel messages through Orca Cloud's app

Orca Cloud's app doesn't send a bot channel messages. An automation on **Slack message** can wake it for
a channel's new top-level messages, and the gate's **Automation events** case checks them (the same
rules, scripts and limits; the bot is told it is a channel message and may stay quiet with `NO_REPLY`).
Like a channel message on your own app, such an event never wakes the bot when the check fails or is
unsure, whatever **If the check fails** says; other automation events still follow it.
What Orca Cloud can't do: replies in threads (each thread has to be named), and keeping one conversation
per thread (every message is a new run). Use your own Slack app for those.
