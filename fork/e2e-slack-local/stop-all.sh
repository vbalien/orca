#!/usr/bin/env bash
# Stops what this E2E started: server, client, fake, Xvfb (by this run's folders and displays only).
source "$(dirname "$0")/env.sh"
[ -f "$R/.orca-e2e-run" ] || { echo "$R is not an E2E run folder (no mark)"; exit 1; }
mine() { for p in $(pgrep -u "$(id -u)"); do tr '\0' '\n' < /proc/$p/environ 2>/dev/null | grep -Fqx "XDG_RUNTIME_DIR=$1" && echo $p; done 2>/dev/null; }
touch $R/stop-server
for _ in $(seq 30); do pgrep -f "^$DX/orca-ide .*serve --bind 127\.0\.0\.1 --port $SERVE_PORT" >/dev/null || break; sleep 1; done
for side in desk srv; do p=$(mine $R/$side/run); [ -n "$p" ] && kill $p 2>/dev/null; done
sleep 2
[ -f $R/fake.pid ] && kill "$(cat $R/fake.pid)" 2>/dev/null
# Only this run's: its inject has this run's folder in its arguments, its Xvfb a pid file here.
# An inject is this run's when its arguments are exactly this script and this run's ready file.
for p in $(pgrep -f "inject\.mjs"); do
  args=(); while IFS= read -r -d '' a; do args+=("$a"); done < /proc/$p/cmdline 2>/dev/null
  [ "${args[1]:-}" = "$E/inject.mjs" ] && [ "${args[${#args[@]}-1]:-}" = "$R/hook-ready" ] && kill $p
done
for side in srv desk; do [ -f $R/xvfb-$side.pid ] && kill "$(cat $R/xvfb-$side.pid)" 2>/dev/null; rm -f $R/xvfb-$side.pid; done
for side in desk srv; do mountpoint -q $R/$side/run/gvfs && fusermount -u $R/$side/run/gvfs; done
sleep 1
pgrep -af "$DX/orca-ide|$EX/fake-slack\.mjs|$EX/fake-anthropic\.mjs|$EX/inject\.mjs" | cut -c1-120
[ -f $R/anthropic.pid ] && kill "$(cat $R/anthropic.pid)" 2>/dev/null; true
