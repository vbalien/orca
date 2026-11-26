#!/usr/bin/env bash
# One-time: run folder, throwaway CA + 127.0.0.1 cert, and a loopback-only network namespace holder.
set -eu; source "$(dirname "$0")/env.sh"
run_dir_ok
mkdir -p $R && touch $R/.orca-e2e-run
mkdir -p $R/tls $R/logs $R/fake $R/srv/home $R/srv/run $R/srv/data $R/desk/home $R/desk/run $R/cli/home $R/cli/data
chmod 700 $R/srv/run $R/desk/run
# The bot's agent: the claude CLI on PATH (E2E_CLAUDE), talking only to the fake Anthropic API.
mkdir -p $R/bin; ln -sf "$(readlink -f "${E2E_CLAUDE:-$(command -v claude)}")" $R/bin/claude
cd $R/tls
[ -f ca.crt ] || { openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 2 -subj /CN=slack-e2e-ca 2>/dev/null
  printf 'subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\n' > ext.cnf
  openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj /CN=127.0.0.1 2>/dev/null
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 2 -extfile ext.cnf 2>/dev/null; }
if [ ! -f $R/ns-holder ] || ! kill -0 "$(cat $R/ns-holder)" 2>/dev/null; then
  unshare -rn bash -c 'ip link set lo up; exec sleep infinity' & echo $! > $R/ns-holder; sleep 0.5
fi
echo "ns holder $(cat $R/ns-holder)"
