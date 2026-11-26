# Shared paths and ports for the own-app Slack E2E (sourced). Nothing here touches the owner's profile
# or keyring. E2E_RUN: a scratch run folder; E2E_DIST: an unpacked build (dist/linux-unpacked);
# E2E_REPO: a checkout with node_modules (ws, playwright-core).
E=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
R=${E2E_RUN:?set E2E_RUN to a scratch folder}
DIST=${E2E_DIST:?set E2E_DIST to an unpacked build}
REPO=${E2E_REPO:-$(cd "$E/../.." && pwd)}
SERVE_PORT=6809; API_PORT=6810; WSS_PORT=6811; CTL_PORT=6812; INSPECT_PORT=9341; ANTHROPIC_PORT=6813
SRV_DISPLAY=:95; DESK_DISPLAY=:96
# A path as a literal inside a pgrep/pkill pattern (another run's path never matches).
rx() { printf '%s' "$1" | sed 's/[][\.*^$+?(){}|]/\\&/g'; }
RX=$(rx "$R"); EX=$(rx "$E"); DX=$(rx "$DIST")
# The run folder, checked before anything is started, stopped or removed: an absolute path without
# spaces, and once it exists, one this harness made (its mark inside).
run_dir_ok() {
  case "$R" in /*) ;; *) echo "E2E_RUN must be an absolute path: $R"; return 1 ;; esac
  [[ "$R" =~ [[:space:]] ]] && { echo "E2E_RUN must have no spaces: $R"; return 1; }
  if [ -e "$R" ] && [ ! -f "$R/.orca-e2e-run" ]; then echo "$R is not an E2E run folder (no mark)"; return 1; fi
}
