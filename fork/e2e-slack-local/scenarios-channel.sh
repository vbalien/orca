#!/usr/bin/env bash
# Inside the namespace, after boot.sh: the channel-message scenarios before a rules script is set. Each step prints the Decisions calls,
# Slack posts and agent turns (fake Anthropic requests) since it began, and where a post went.
set -u; source "$(dirname "$0")/lib.sh"
echo "== channel gate (channel default rules), paired person"; gate channel
step "1 allowed channel, top-level [wake]" 12 "$(top '[wake] does anyone know where the release notes live?')" 1/+/1; T1=$(cat $R/last-ts); cp $R/last-ts $R/t1
say "1 reply went to the message's own thread" "$(lastpost | grep -c "thread $T1")" 1; say "1 agent told it was a channel message" "$(told 'was not addressed to you')" True
step "2 allowed channel, top-level [chat]" 8 "$(top '[chat] lunch at noon?')" 1/0/0; T2=$(cat $R/last-ts)
step "3 channel not in the list, [wake]" 8 "$(top '[wake] anyone around?' U0ASKER1 C0OTHER1)" 0/0/0
step "4 someone not allowed to ask (U0STRANGE), [wake]" 8 "$(top '[wake] can someone help?' U0STRANGE)" 0/0/0
step "5 [unsure] (unsure never wakes a channel message)" 8 "$(top '[unsure] hmm')" 1/0/0
step "6 OpenAI 503 (onError wake, but channel messages never wake on a failed check)" 8 "$(top '[5xx] question')" 1/0/0
step "7 reply in a people-only thread (bot not in it), [wake]" 12 "$(reply $T2 '[wake] could the bot check the build?')" 1/+/1
say "7 checked as" "$(lastcase)" channel_message
step "8 top-level [wake] the agent answers NO_REPLY" 12 "$(top '[wake] [quiet] who has the projector?')" 1/+/0; T8=$(cat $R/last-ts)
step "8b reply in that quiet thread, [chat] (still a channel message)" 8 "$(reply $T8 '[chat] found it')" 1/0/0; say "8b checked as" "$(lastcase)" channel_message
step "8f top-level [wake] the agent's request fails (before the bot joined: no failure line)" 40 "$(top '[wake] [fail] who has the printer key?')" 1/+/0; TF=$(cat $R/last-ts)
step "8g reply in that thread, [chat] (still a channel message)" 8 "$(reply $TF '[chat] nevermind')" 1/0/0; say "8g checked as" "$(lastcase)" channel_message
step "9 reply in thread 1 the bot answered, [chat] (now a thread reply)" 8 "$(reply $T1 '[chat] thanks!')" 1/0/0; say "9 checked as" "$(lastcase)" thread_reply
step "10 mention in quiet thread 8" 12 "{\"user\":\"U0ASKER1\",\"text\":\"[chat] are you there?\",\"channel\":\"C0CHAN01\",\"thread_ts\":\"$T8\"}" 0/+/1

echo "== limits: banter at most 1 a day"; gate day
step "11 [banter]" 12 "$(top '[banter] anyone else think fridays should be shorter?')" 1/+/1; say "11 agent told the reason" "$(told 'banter: join briefly')" True
step "12 [banter] again (daily limit used)" 8 "$(top '[banter] coffee or tea?')" 1/0/0
echo "== limits: banter only, 60 min apart"; gate cooldown
step "13 [banter] inside the cooldown (all wake rules closed: no OpenAI call)" 8 "$(top '[banter] what a day')" 0/0/0
echo "== restart the server"; n0=$(count $R/fake/calls.jsonl '"socket":"open"'); touch $R/stop-server; sleep 6; env PATH=$PATH $E/start-server.sh >/dev/null; socket_back $n0; sleep 3
step "14 [banter] after the restart (cooldown kept)" 8 "$(top '[banter] weekend plans?')" 0/0/0
echo "== OpenAI answer held while the channel is removed (a rule allowed once a day)"; gate heldLimit >/dev/null
w0=$(writes); t0=$(turns); event "$(top '[hold] is the bot around?')" > /dev/null; sleep 2
off="{\"botId\":\"$B\",\"gate\":$(python3 -c "import json;g=json.load(open('$R/gates/heldLimit.json'));g.pop('channelMessages');print(json.dumps(g))")}"
$E/call.sh person bots.slackGate.store "$off" | cut -c1-60; say "held answers released" "$(curl -s -X POST $CTL/release)" '{"released":1}'; sleep 10
say "after release: agent turns, slack writes" "$(( $(turns) - t0 ))/$(( $(writes) - w0 ))" 0/0
gate heldLimit >/dev/null
step "18h channel on again, [wake]: the day's one wake is still there" 12 "$(top '[wake] who has the projector key?')" 1/+/1
echo "== restart after a quiet answer, and a joined thread after the channel is removed"; gate channel >/dev/null
step "19 top-level [wake] the agent answers NO_REPLY" 12 "$(top '[wake] [quiet] is the printer fixed?')" 1/+/0; TQ=$(cat $R/last-ts)
n0=$(count $R/fake/calls.jsonl '"socket":"open"'); touch $R/stop-server; sleep 6; env PATH=$PATH $E/start-server.sh >/dev/null; socket_back $n0; sleep 3
step "20 after a restart: reply in that quiet thread, [chat]" 8 "$(reply $TQ '[chat] no idea')" 1/0/0; say "20 checked as" "$(lastcase)" channel_message
step "21 after a restart: mention in that quiet thread" 12 "{\"user\":\"U0ASKER1\",\"text\":\"[chat] still there?\",\"channel\":\"C0CHAN01\",\"thread_ts\":\"$TQ\"}" 0/+/1
say "21 the agent's request holds the quiet turn's message (same chat)" "$(tail -1 $R/fake/anthropic.jsonl | python3 -c "import json,sys;print('is the printer fixed' in json.load(sys.stdin)['all'])")" True
channelOff="{\"botId\":\"$B\",\"gate\":$(python3 -c "import json;g=json.load(open('$R/gates/channel.json'));g.pop('channelMessages');print(json.dumps(g))")}"
$E/call.sh person bots.slackGate.store "$channelOff" | cut -c1-60
step "22 channel removed: reply in thread 1 the bot answered before the restart, [wake]" 12 "$(reply $T1 '[wake] and the old notes?')" 1/+/1; say "22 checked as" "$(lastcase)" thread_reply
echo "== Slack answers the bot's post with 429 (Retry-After 3 s)"
curl -s -X POST $CTL/posts-mode -d '{"mode":"429"}' >/dev/null
step "23 mention at the top while posts are rate limited (refused once, posted after the wait)" 15 "{\"user\":\"U0ASKER1\",\"text\":\"[chat] are posts slow?\",\"channel\":\"C0CHAN01\"}" 0/+/2
say "paired person sets a rules script: refused" "$(gate script | grep -c 'Change a Slack gate command')" 1
