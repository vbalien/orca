// A small private JSON file per bot (mode 600, named by a hash of the bot id), written whole through one
// queue per file so a slow earlier write never lands after a later one, and closed for good when the bot
// goes. Reads tell a missing file from one that can't be read.
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getCanonicalUserDataPath } from '../../persistence/loading-store/user-data-path'

let rootOverride: string | null = null

/** Tests point every bot state file at a temporary folder. */
export function useBotStateRoot(root: string | null): void {
  rootOverride = root
}

export type BotStateRead =
  | { kind: 'missing' }
  | { kind: 'ok'; value: unknown }
  | { kind: 'unreadable' }

export class BotStateFile {
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(
    private readonly folder: string,
    private readonly botId: string
  ) {}

  get path(): string {
    const name = createHash('sha256').update(this.botId).digest('hex').slice(0, 32)
    return join(rootOverride ?? getCanonicalUserDataPath(), this.folder, `${name}.json`)
  }

  async read(): Promise<BotStateRead> {
    let path: string
    try {
      path = this.path
    } catch {
      // No data folder here at all: nothing was ever written.
      return { kind: 'missing' }
    }
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      return error instanceof Error && 'code' in error && error.code === 'ENOENT'
        ? { kind: 'missing' }
        : { kind: 'unreadable' }
    }
    try {
      return { kind: 'ok', value: JSON.parse(text) }
    } catch {
      return { kind: 'unreadable' }
    }
  }

  /** Keeps a copy of an unreadable file next to it before it is replaced; false when it could not. */
  async preserveUnreadable(): Promise<boolean> {
    try {
      await copyFile(this.path, `${this.path}.corrupt-${Date.now()}`)
      return true
    } catch {
      return false
    }
  }

  /** Writes `value()` whole, in order with every other write of this file; false when it failed or
   *  the file was closed. The value is taken when the write runs, so it is always the latest state. */
  write(value: () => unknown): Promise<boolean> {
    const run = this.tail.then(async () => {
      if (this.closed) {
        return false
      }
      let path: string
      try {
        path = this.path
      } catch {
        return false
      }
      const temp = `${path}.${randomUUID()}.tmp`
      try {
        await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
        await writeFile(temp, JSON.stringify(value()), { mode: 0o600 })
        await rename(temp, path)
        return true
      } catch {
        await rm(temp, { force: true }).catch(() => undefined)
        return false
      }
    })
    this.tail = run.catch(() => false)
    return run
  }

  /** Removes the file in order with its writes; later writes still go. */
  clear(): Promise<void> {
    const run = this.tail.then(async () => {
      try {
        await rm(this.path, { force: true })
      } catch {
        // No data folder (a test, or a host without one) or nothing to remove.
      }
    })
    this.tail = run.catch(() => undefined)
    return run
  }

  /** No more writes, and nothing removed: the file stays as it is. */
  close(): void {
    this.closed = true
  }

  /** No more writes; waits for the one under way, then removes the file. */
  async remove(): Promise<void> {
    this.closed = true
    await this.tail.catch(() => undefined)
    try {
      await rm(this.path, { force: true })
    } catch {
      // No data folder (a test, or a host without one) or nothing to remove.
    }
  }
}
