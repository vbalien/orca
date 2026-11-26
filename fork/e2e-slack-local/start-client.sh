#!/usr/bin/env bash
# Inside the namespace: an isolated paired desktop (same build), hidden, with CDP.
set -u; source "$(dirname "$0")/env.sh"
PAIR=$(grep "^Pairing URL: " $R/logs/serve.log | head -1 | sed 's/^Pairing URL: //')
env -i HOME=$R/desk/home XDG_RUNTIME_DIR=$R/desk/run PATH=/usr/bin:/bin LANG=C.UTF-8 ORCA_USER_DATA_PATH=$R/desk/home/.config/orca \
  ELECTRON_RUN_AS_NODE=1 timeout 60 $DIST/orca-ide $DIST/resources/app.asar.unpacked/out/cli/index.js environment add --name test-server --pairing-code "$PAIR" --json | grep -o '"ok": *[a-z]*' | head -1
pgrep -f "^Xvfb $DESK_DISPLAY " >/dev/null || { Xvfb $DESK_DISPLAY -nolisten tcp -screen 0 1280x800x24 > $R/logs/xvfb-desk.log 2>&1 & }
rm -f $R/desk/home/.config/orca/DevToolsActivePort
env -i HOME=$R/desk/home XDG_RUNTIME_DIR=$R/desk/run XDG_CONFIG_HOME=$R/desk/home/.config XDG_DATA_HOME=$R/desk/home/.local/share XDG_CACHE_HOME=$R/desk/home/.cache \
  DISPLAY=$DESK_DISPLAY PATH=/usr/bin:/bin LANG=C.UTF-8 ORCA_BACKGROUND_LAUNCH=1 \
  dbus-run-session -- $DIST/orca-ide --remote-debugging-port=0 > $R/logs/desk.log 2>&1 &
for _ in $(seq 120); do [ -f $R/desk/home/.config/orca/DevToolsActivePort ] && break; sleep 1; done
echo "CDP $(head -1 $R/desk/home/.config/orca/DevToolsActivePort)"
