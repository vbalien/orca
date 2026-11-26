#!/usr/bin/env bash
# Inside the namespace, after scenarios-channel.sh: the gate's rules script (fork/gate-rules-script's
# reference script with the bot's name and channel filled in), set on the server's own computer.
set -u; source "$(dirname "$0")/lib.sh"; T1=$(cat $R/t1); S=$E/shots
sed -e "s/\['mybot'\]/['chanbot']/" -e "s/C0000000001:/C0CHAN01:/" $REPO/fork/gate-rules-script/channel-rules.mjs > $R/channel-rules.mjs
echo "== rules script set in Orca on the server's computer: $($E/set-script.sh "/usr/bin/node $R/channel-rules.mjs" $S/20-script-set.png)"
echo "   stored: $($E/call.sh person bots.list '{}' | python3 -c 'import json,sys;g=json.load(sys.stdin)["result"]["bots"][0]["slackGate"];print("rulesCommand" in g, g.get("channelMessages"), "onError", g["onError"], "newer.onError", (g.get("newer") or {}).get("onError"))')"
echo "   paired person changes the script: $($E/call.sh person bots.slackGate.store "{\"botId\":\"$B\",\"gate\":$(cat $R/gates/channel.json)}" | cut -c1-110)"
step "15 script: called by name (wakes without OpenAI)" 12 "$(top 'chanbot, can you look at this?')"; echo "   agent told the reason: $(told 'called by name')"
step "16 script: asks OpenAI its role question [wake]" 12 "$(top '[wake] where are the shared notes for the offsite?')"
step "17 script: [chat]" 8 "$(top '[chat] see you all tomorrow')"
step "17b script: channel not in its table (C0OTHER1 is not in the gate's list either)" 8 "$(top 'chanbot hi' U0ASKER1 C0OTHER1)"
echo "   last script run (status): $($E/call.sh person bots.slackGate.status "{\"botId\":\"$B\"}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"].get("scriptRun"))')"
echo "== the script fails (exit 1): $($E/set-script.sh /usr/bin/false $S/21-script-false.png)"
step "18 script fails, top-level [wake]" 8 "$(top '[wake] anyone?')"
step "18b script fails, reply in thread 1 the bot is in, [wake]" 8 "$(reply $T1 '[wake] one more question')"
step "18c script fails, mention (not checked: mentions are off in the gate)" 12 "{\"user\":\"U0ASKER1\",\"text\":\"[chat] ping\",\"channel\":\"C0CHAN01\"}"
echo "== the script cleared again in Orca on the server's computer: $($E/set-script.sh '' $S/22-script-cleared.png)"
