#!/bin/bash
# ORCA_APP_EXECUTABLE for the isolated server: the build's Electron, paused at start for inject.mjs.
exec "$DIST/orca-ide" --inspect-brk=127.0.0.1:9341 "$@"
