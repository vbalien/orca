#!/usr/bin/env bash
# Runs a command inside the E2E's loopback-only network namespace (no route out at all), as the usual uid
# again (a nested user namespace), since Electron refuses to run as root.
source "$(dirname "$0")/env.sh"
U=$(id -u); G=$(id -g)
exec nsenter -t "$(cat $R/ns-holder)" -U -n --preserve-credentials unshare --user --map-user=$U --map-group=$G "$@"
