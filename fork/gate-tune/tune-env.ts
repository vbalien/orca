// The tuning tool's surroundings: the API key read from a private file, and what identifies a run's code
// and inputs (a commit and content hashes).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { fail } from './tune-cases'

/** The key, only from a file nobody else can read; never printed. */
export function readKey(path: string): string {
  if (process.platform === 'win32') {
    fail('this tool reads its key file only on POSIX systems, where it can check it is private')
  }
  if ((statSync(path).mode & 0o077) !== 0) {
    fail(`${path} must be readable by you alone (chmod 600)`)
  }
  const key = readFileSync(path, 'utf8').trim()
  if (!/^[\x21-\x7e]{1,512}$/.test(key)) {
    fail(`${path} does not hold one line of printable characters`)
  }
  return key
}

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** The checkout's commit (and whether it has edits), to tell results of different code apart. */
export function revision(): string {
  try {
    // This tool's own checkout, wherever it is run from.
    const cwd = import.meta.dirname
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', cwd }).trim()
    return dirty ? `${head}+edits` : head
  } catch {
    return 'unknown'
  }
}
