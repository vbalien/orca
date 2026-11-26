#!/usr/bin/env bash
# call.sh <person|agent> <method> <json>: one paired call to the isolated server (inside the namespace).
source "$(dirname "$0")/env.sh"
PAIR=${PAIR:-test-server}
CLIENT=${CLIENT:-$R/desk/home/.config/orca}
cd $R && ELECTRON_RUN_AS_NODE=1 HOME=$R/cli/home ORCA_USER_DATA_PATH=$R/cli/data DIST=$DIST timeout 90 $DIST/orca-ide $E/paired.mjs "$CLIENT" "$PAIR" "$1" "$2" "$3"
