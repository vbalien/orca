#!/usr/bin/env bash
# Inside the namespace, after the other scenarios: the same profile under an older build (E2E_OLD_DIST,
# one without channel messages) and back. The older build reads the stored gate's stand-in rules.
set -u; source "$(dirname "$0")/lib.sh"; T1=$(cat $R/t1)
OLD=${E2E_OLD_DIST:?set E2E_OLD_DIST to an older unpacked build}
restart_with() { local n0; n0=$(count $R/fake/calls.jsonl '"socket":"open"'); touch $R/stop-server; sleep 6; E2E_DIST=$1 env PATH=$PATH $E/start-server.sh >/dev/null; socket_back $n0; sleep 3; }
echo "== new build: limits gate, a quiet channel-message chat"; gate day >/dev/null
step "30 top-level [wake] [quiet] (opens a channel-message chat)" 12 "$(top '[wake] [quiet] anyone seen my charger?')" 1/+/0; TO=$(cat $R/last-ts)
step "30b mention at the top (opens an ordinary chat)" 15 "{\"user\":\"U0ASKER1\",\"text\":\"[chat] can you watch the deploy?\",\"channel\":\"C0CHAN01\"}" 0/+/1; TM=$(cat $R/last-ts)
echo "== older build on the same profile"; restart_with "$OLD"
step "31 old: top-level [wake] (old builds take no channel messages)" 8 "$(top '[wake] where is the wiki?')" 0/0/0
step "32 old: reply in the quiet channel-message thread, [wake] (old builds don't know its chat)" 8 "$(reply $TO '[wake] found it?')" 0/0/0
step "33 old: reply in the mention's thread, [wake] (stand-in rules block)" 8 "$(reply $TM '[wake] one more')" 1/0/0
step "34 old: reply in the mention's thread, [5xx] (stand-in error policy blocks)" 8 "$(reply $TM '[5xx] and another')" 1/0/0
step "35 old: mention in the quiet thread (a new ordinary chat)" 40 "{\"user\":\"U0ASKER1\",\"text\":\"[chat] [speak] hello?\",\"channel\":\"C0CHAN01\",\"thread_ts\":\"$TO\"}" 0/+/1
say "stored gate under the old build (newer, channelMessages)" "$($E/call.sh person bots.list '{}' | python3 -c 'import json,sys;g=json.load(sys.stdin)["result"]["bots"][0]["slackGate"];print("newer" in g, "channelMessages" in g)')" "False False"
echo "== back to the new build"; restart_with "$DIST"
say "restorable" "$($E/call.sh person bots.slackGate.status "{\"botId\":\"$B\"}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"].get("restorable"))')" True
echo "   stored gate: $($E/call.sh person bots.list '{}' | python3 -c 'import json,sys;g=json.load(sys.stdin)["result"]["bots"][0]["slackGate"];print("newer" in g, g.get("channelMessages"))')"
step "36 new: reply in the formerly quiet thread, [chat] (its ordinary chat now)" 8 "$(reply $TO '[chat] thanks')" 1/0/0; say "36 checked as" "$(lastcase)" thread_reply
step "37 new: top-level [wake] (the old build's save dropped the channel list)" 8 "$(top '[wake] who owns the build server?')" 0/0/0
say "restore" "$($E/call.sh person bots.slackGate.restore "{\"botId\":\"$B\"}" | cut -c1-11)" '{"ok":true,'
step "38 new, restored: top-level [wake]" 12 "$(top '[wake] who owns the build server now?')" 1/+/1
