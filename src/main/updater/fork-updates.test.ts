import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    app: Object.assign(new EventEmitter(), { isPackaged: true, getVersion: () => '1.4.275' }),
    autoUpdater: new EventEmitter(),
    powerMonitor: new EventEmitter()
  }
})
const loadElectronAutoUpdater = vi.fn(() => new EventEmitter())
vi.mock('./electron-updater-loader', () => ({ loadElectronAutoUpdater }))

// electron.vite.config.ts defines ORCA_FORK_BUILD for fork builds; tests stand in through the global.
const LAST_CHECK_AT = 1_764_000_000_000
afterEach(() => {
  vi.unstubAllGlobals()
  loadElectronAutoUpdater.mockClear()
  vi.resetModules()
})

it('a packaged fork build says self-update is off from launch and never loads the updater', async () => {
  vi.stubGlobal('ORCA_FORK_BUILD', true)
  const { UpdaterSetup } = await import('./lifecycle/updater-setup')
  const updater = new UpdaterSetup()
  updater.setupAutoUpdater(null, { getLastUpdateCheckAt: () => LAST_CHECK_AT })
  expect(updater.getUpdateStatus()).toEqual({ state: 'not-available', forkUpdatesOff: true })

  updater.checkForUpdatesFromMenu()
  expect(updater.getUpdateStatus()).toEqual({
    state: 'not-available',
    userInitiated: true,
    forkUpdatesOff: true
  })
  expect(updater.getRemoteServerUpdateSupport()).toMatchObject({
    automatic: false,
    reason: 'updater-unavailable'
  })
  expect(loadElectronAutoUpdater).not.toHaveBeenCalled()
})

it('an upstream packaged build keeps updating', async () => {
  const { forkBuild, updaterActive, forkUpdatesOffField } = await import('./fork-updates')
  expect(forkBuild()).toBe(false)
  expect(updaterActive()).toBe(true)
  expect(forkUpdatesOffField()).toEqual({})
})
