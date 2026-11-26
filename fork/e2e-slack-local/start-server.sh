#!/usr/bin/env bash
# Inside the namespace: fake Slack/OpenAI and fake Anthropic, Xvfb, the isolated server (redirect injected
# before app code; the bot's claude agent pointed at the fake Anthropic API).
set -u; source "$(dirname "$0")/env.sh"
rm -f $R/stop-server
curl -s -m 2 http://127.0.0.1:$CTL_PORT/ >/dev/null || { node $E/fake-slack.mjs $R/fake $API_PORT $WSS_PORT $CTL_PORT "$REPO" > $R/logs/fake.log 2>&1 & echo $! > $R/fake.pid; sleep 1; }
curl -s -m 2 http://127.0.0.1:$ANTHROPIC_PORT/health >/dev/null || { node $E/fake-anthropic.mjs $R/fake $ANTHROPIC_PORT > $R/logs/anthropic.log 2>&1 & echo $! > $R/anthropic.pid; sleep 0.5; }
# This run's own Xvfb, by its pid file (another run's is never taken or stopped).
kill -0 "$(cat $R/xvfb-srv.pid 2>/dev/null)" 2>/dev/null || { Xvfb $SRV_DISPLAY -nolisten tcp -screen 0 1280x800x24 > $R/logs/xvfb-srv.log 2>&1 & echo $! > $R/xvfb-srv.pid; }
[ -f $R/logs/serve.log ] && mv $R/logs/serve.log $R/logs/serve-$(date +%s).log
env -i HOME=$R/srv/home XDG_RUNTIME_DIR=$R/srv/run XDG_CONFIG_HOME=$R/srv/home/.config XDG_DATA_HOME=$R/srv/home/.local/share \
  XDG_CURRENT_DESKTOP=GNOME XDG_SESSION_TYPE=x11 DESKTOP_SESSION=gnome DISPLAY=$SRV_DISPLAY PATH=$R/bin:/usr/bin:/bin LANG=C.UTF-8 \
  ORCA_BACKGROUND_LAUNCH=1 ORCA_USER_DATA_PATH=$R/srv/data ORCA_SERVE_RUNTIME=electron ORCA_APP_EXECUTABLE=$E/app-wrapper.sh \
  ANTHROPIC_BASE_URL=http://127.0.0.1:$ANTHROPIC_PORT ANTHROPIC_API_KEY=sk-ant-e2e-fake DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  R=$R DIST=$DIST SERVE_PORT=$SERVE_PORT dbus-run-session -- bash $E/server-inner.sh > $R/logs/dbus-srv.log 2>&1 &
rm -f $R/hook-ready
node $E/inject.mjs $INSPECT_PORT http://127.0.0.1:$API_PORT $R/tls/ca.crt $R/hook-ready > $R/logs/inject.log 2>&1 &
for _ in $(seq 60); do [ -f $R/hook-ready ] && break; sleep 0.5; done
[ -f $R/hook-ready ] || { echo "INJECT FAILED"; cat $R/logs/inject.log; exit 1; }
head -1 $R/logs/inject.log
for _ in $(seq 120); do grep -q "^Pairing URL" $R/logs/serve.log 2>/dev/null && break; sleep 1; done
grep -c "^Pairing URL" $R/logs/serve.log
