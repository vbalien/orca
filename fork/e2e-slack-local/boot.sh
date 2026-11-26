#!/usr/bin/env bash
# From a clean run folder: namespace, fakes, isolated server, bot `chanbot` over a person's pairing with the
# own Slack app (fake tokens), owner U0OWNER1 and asker U0ASKER1. Outside the namespace only to start it.
set -u; source "$(dirname "$0")/env.sh"
$E/stop-all.sh >/dev/null 2>&1; [ -f $R/ns-holder ] && kill "$(cat $R/ns-holder)" 2>/dev/null
rm -rf $R; $E/setup.sh
N() { $E/ns.sh "$@"; }
N env PATH=$PATH $E/start-server.sh || exit 1
PAIR=$(grep -h "^Pairing URL: " $R/logs/serve.log | head -1 | sed "s/^Pairing URL: //"); export PAIR CLIENT=$R/cli/data
C() { N $E/call.sh person "$1" "$2" | cut -c1-200; }
B=$(N $E/call.sh person bots.create '{"name":"chanbot","agent":"claude"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["bot"]["id"])'); echo $B > $R/bot.txt
echo "$PAIR" > $R/pair.txt
C bots.slackLocal.useLocal "{\"botId\":\"$B\"}"
C bots.slackLocal.setTokens "{\"botId\":\"$B\",\"botToken\":\"xoxb-1-E2EBOTMARK91\",\"appToken\":\"xapp-1-E2EAPPMARK92\"}"
sleep 3
C bots.slackLocal.setOwner "{\"botId\":\"$B\",\"expectedTeamId\":\"T0TEST01\",\"ownerUserId\":\"U0OWNER1\"}"
C bots.slackLocal.addAskers "{\"botId\":\"$B\",\"expectedTeamId\":\"T0TEST01\",\"askers\":[{\"id\":\"U0ASKER1\"}]}"
C bots.slackGate.setOpenAIKey "{\"botId\":\"$B\",\"key\":\"sk-e2e-E2EGATEKEYMARK93\"}"
