// One queue for every change of how a bot's Slack connects: Orca Cloud app setup, adoption and
// removal, and the bot's own app's mode, tokens and people. Rare, so one queue for all bots.
let tail: Promise<unknown> = Promise.resolve()

export function withSlackConfigLock<T>(run: () => Promise<T>): Promise<T> {
  const next = tail.then(run, run)
  tail = next.catch(() => undefined)
  return next
}

export const SLACK_USES_LOCAL_APP =
  'This bot uses its own Slack app. Switch it back to Orca Cloud in its Slack settings first.'
