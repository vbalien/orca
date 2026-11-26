# Sourced by the scenario scripts (inside the namespace): counters over the fakes' logs and event helpers.
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
CTL=http://127.0.0.1:$CTL_PORT; B=$(cat $R/bot.txt); export PAIR=$(cat $R/pair.txt) CLIENT=$R/cli/data
count() { [ -f "$1" ] && grep -c "$2" "$1" || true; }
posts() { count $R/fake/calls.jsonl '"api":"chat.postMessage"'; }
asks() { [ -f $R/fake/decisions.jsonl ] && wc -l < $R/fake/decisions.jsonl || echo 0; }
turns() { [ -f $R/fake/anthropic.jsonl ] && wc -l < $R/fake/anthropic.jsonl || echo 0; }
lastpost() { grep '"api":"chat.postMessage"' $R/fake/calls.jsonl | tail -1 | python3 -c 'import json,sys;p=json.loads(sys.stdin.read() or "{}").get("params",{});print("thread", p.get("thread_ts","-"))'; }
event() { curl -s -X POST $CTL/event -d "$1" | python3 -c 'import json,sys;print(json.load(sys.stdin)["ts"])'; }
# Every Slack write the bot made (posts, edits, reactions, status...): any Web API call but the reads.
writes() { grep '"api":' $R/fake/calls.jsonl | grep -cvE '"api":"(auth\.test|bots\.info|apps\.connections\.open|users\.info|conversations\.[a-z]+)"' || true; }
# step <name> <wait s> <event json> <expected "decisions/agent/writes">: sends it, waits, prints the
# counts and records a failure when they differ. agent is 0 (no agent turn) or + (one or more).
# The event's ts goes to $R/last-ts.
step() {
  local w0=$(writes) a0=$(asks) t0=$(turns)
  event "$3" > $R/last-ts; sleep "$2"
  local dw=$(( $(writes) - w0 )) da=$(( $(asks) - a0 )) dt=$(( $(turns) - t0 ))
  echo "$1 (ts $(cat $R/last-ts)): decisions +$da, agent turns +$dt, slack writes +$dw$( [ $dw -gt 0 ] && echo " → $(lastpost)")"
  check "$1" "$da/$( [ $dt -gt 0 ] && echo + || echo 0)/$dw" "$4"
}
# check <name> <actual> <expected>: a failure goes to $R/failures (run-all fails on any).
check() { [ "$2" = "$3" ] || { echo "   FAIL $1: got $2, expected $3"; echo "$1: got $2, expected $3" >> $R/failures; }; }
gate() { # gate <name>: saves gates/<name>.json as the paired person
  $E/call.sh person bots.slackGate.store "{\"botId\":\"$B\",\"gate\":$(cat $R/gates/$1.json)}" | cut -c1-100
}
top() { echo "{\"user\":\"${2:-U0ASKER1}\",\"text\":\"$1\",\"mention\":false,\"channel\":\"${3:-C0CHAN01}\"}"; }
reply() { echo "{\"user\":\"${3:-U0ASKER1}\",\"text\":\"$2\",\"mention\":false,\"channel\":\"C0CHAN01\",\"thread_ts\":\"$1\"}"; }
lastcase() { tail -1 $R/fake/decisions.jsonl | python3 -c 'import json,sys;print(json.load(sys.stdin)["input"][1]["content"][0]["data"].get("case"))'; }
told() { tail -1 $R/fake/anthropic.jsonl | python3 -c "import json,sys;t=json.load(sys.stdin)['last'];print('$1' in t)"; }

# Waits until the server's Slack socket is back (after a restart).
socket_back() { local n0=$1; for _ in $(seq 90); do [ "$(count $R/fake/calls.jsonl '"socket":"open"')" -gt "$n0" ] && return 0; sleep 1; done; echo "   (Slack socket not back)"; }
# say <label> <actual> <expected>: prints the line and checks it.
say() { echo "   $1: $2"; check "$1" "$2" "$3"; }
