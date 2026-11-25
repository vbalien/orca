import { app } from 'electron'

/** A build of the vbalien/orca fork (electron.vite.config.ts defines it). Undefined in tests and upstream builds. */
export function forkBuild(): boolean {
  return typeof ORCA_FORK_BUILD !== 'undefined' && ORCA_FORK_BUILD === true
}

/** Whether Orca may check for and install its own updates. A fork build never does: an upstream release
 *  would replace the fork's patches. It takes the unpackaged path ("no update"), marked so the UI says why. */
export function updaterActive(): boolean {
  return app.isPackaged && !forkBuild()
}

/** The marker a fork build adds to its "no update" status. */
export function forkUpdatesOffField(): { forkUpdatesOff?: true } {
  return forkBuild() ? { forkUpdatesOff: true } : {}
}
