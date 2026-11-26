# Inside its own dbus-run-session: a throwaway unlocked gnome-keyring, then the build's `orca serve`.
set -u
printf throwaway-e2e-pw | gnome-keyring-daemon --unlock --components=secrets >/dev/null 2>&1
gnome-keyring-daemon --start --components=secrets >/dev/null 2>&1
ELECTRON_RUN_AS_NODE=1 "$DIST/orca-ide" "$DIST/resources/app.asar.unpacked/out/cli/index.js" serve --bind 127.0.0.1 --port $SERVE_PORT --pairing-address 127.0.0.1 > "$R/logs/serve.log" 2>&1 &
SV=$!
while [ ! -e "$R/stop-server" ]; do sleep 1; done
kill $SV; wait $SV 2>/dev/null
