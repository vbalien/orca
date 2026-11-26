#!/usr/bin/env bash
# Inside the namespace: stops the isolated server and opens the server's own profile as a desktop window
# (its owner at that computer), with CDP, on the server's display and keyring. Prints "CDP <port>".
# `server-desktop.sh --close` closes it again (then start-server.sh brings the server back).
set -u; source "$(dirname "$0")/env.sh"
mine() { for p in $(pgrep -u "$(id -u)"); do tr '\0' '\n' < /proc/$p/environ 2>/dev/null | grep -qx "XDG_RUNTIME_DIR=$R/srv/run" && echo $p; done 2>/dev/null; }
touch $R/stop-server
for _ in $(seq 30); do pgrep -f "^$DIST/orca-ide .*serve --bind 127.0.0.1 --port $SERVE_PORT" >/dev/null || break; sleep 1; done
p=$(mine); [ -n "$p" ] && kill $p 2>/dev/null
pkill -f "^$DIST/orca-ide --user-data-dir=$R/srv/data " 2>/dev/null
for _ in $(seq 30); do pgrep -f "^$DIST/orca-ide --user-data-dir=$R/srv/data " >/dev/null || break; sleep 1; done; sleep 2
[ "${1:-}" = --close ] && exit 0
# This run's own Xvfb, by its pid file (another run's is never taken or stopped).
kill -0 "$(cat $R/xvfb-srv.pid 2>/dev/null)" 2>/dev/null || { Xvfb $SRV_DISPLAY -nolisten tcp -screen 0 1280x800x24 > $R/logs/xvfb-srv.log 2>&1 & echo $! > $R/xvfb-srv.pid; }
rm -f $R/srv/data/DevToolsActivePort
env -i HOME=$R/srv/home XDG_RUNTIME_DIR=$R/srv/run XDG_CONFIG_HOME=$R/srv/home/.config XDG_DATA_HOME=$R/srv/home/.local/share \
  XDG_CURRENT_DESKTOP=GNOME XDG_SESSION_TYPE=x11 DESKTOP_SESSION=gnome DISPLAY=$SRV_DISPLAY PATH=/usr/bin:/bin LANG=C.UTF-8 \
  ORCA_BACKGROUND_LAUNCH=1 ORCA_USER_DATA_PATH=$R/srv/data \
  dbus-run-session -- bash -c 'printf throwaway-e2e-pw | gnome-keyring-daemon --unlock --components=secrets >/dev/null 2>&1; gnome-keyring-daemon --start --components=secrets >/dev/null 2>&1; exec "$0" --user-data-dir="$1" --remote-debugging-port=0' $DIST/orca-ide $R/srv/data > $R/logs/srv-desk.log 2>&1 &
for _ in $(seq 120); do [ -f $R/srv/data/DevToolsActivePort ] && break; sleep 1; done
echo "CDP $(head -1 $R/srv/data/DevToolsActivePort)"
