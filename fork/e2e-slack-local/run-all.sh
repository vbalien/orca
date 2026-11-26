#!/usr/bin/env bash
# The channel-message E2E from a clean run folder (fake Slack, fake OpenAI Decisions, fake Anthropic; no
# network). Keep E2E_RUN short (e.g. /tmp/$USER-gcm-e2e): the throwaway keyring's socket lives under it
# and Unix socket paths stop at 108 bytes. E2E_DIST: an unpacked build (pnpm build:unpack).
# Outside the namespace only to start it; needs node 24, unshare, Xvfb, dbus-run-session, gnome-keyring.
set -u; source "$(dirname "$0")/env.sh"
[ ${#R} -le 40 ] || { echo "E2E_RUN is too long for the keyring socket: $R"; exit 1; }
N() { $E/ns.sh "$@"; }
$E/boot.sh || exit 1
mkdir -p $E/shots
(cd $REPO && node --import tsx $E/gates.mts $REPO $R/gates "/usr/bin/node $R/channel-rules.mjs" >/dev/null) || exit 1
# A scenario that stops early (a shell error, a failed namespace entry) fails the run too.
scenario() { N env PATH=$PATH ${E2E_OLD_DIST:+E2E_OLD_DIST=$E2E_OLD_DIST} "$E/$1" || echo "$1 exited with $?" >> $R/failures; }
trap '$E/stop-all.sh >/dev/null 2>&1; kill "$(cat $R/ns-holder 2>/dev/null)" 2>/dev/null' EXIT
scenario scenarios-channel.sh
scenario scenarios-script.sh
[ -n "${E2E_OLD_DIST:-}" ] && scenario scenarios-old.sh
echo "== leaks"
source $E/lib.sh 2>/dev/null
say "marks (gate key, Slack tokens) in files" "$(grep -rl 'E2EGATEKEYMARK93\|E2EBOTMARK91\|E2EAPPMARK92' $R/srv $R/cli $R/logs 2>/dev/null | wc -l)" 0
say "message text in the server log" "$(grep -c 'release notes live\|shared notes for the offsite\|lunch at noon' $R/logs/serve*.log | awk -F: '{s+=$2} END {print s}')" 0
say "message text in the wake-count / participation files" "$(grep -rl 'release notes\|offsite\|lunch' $R/srv/data/bot-slack-gate-wakes $R/srv/data/slack-local-participation 2>/dev/null | wc -l)" 0
echo "== [slack-gate] log lines"
python3 - "$R" <<'PY'
import re, sys, glob
for f in sorted(glob.glob(sys.argv[1] + '/logs/serve*.log')):
  for m in re.finditer(r"\[slack-gate\] \{(.*?)\n\}", open(f).read(), re.S):
    b = ' '.join(x.strip() for x in m.group(1).splitlines()); b = re.sub(r"botId: '[^']*',|eventId: '[^']*',", "", b); print('  ', b[:230])
PY
if [ -s $R/failures ]; then echo "== FAILED ($(wc -l < $R/failures))"; cat $R/failures; exit 1; fi
echo "== all checks passed"
