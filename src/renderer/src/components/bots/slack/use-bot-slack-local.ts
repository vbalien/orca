// A bot's own Slack app on its desktop host: its status as the host says it, and the owner's changes.
// Tokens go to the host and are never read back.
import { useCallback, useEffect, useRef, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { botHostTarget } from '@/lib/bot-hosts'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import type { Bot } from '../../../../../shared/bot-types'
import type { SlackLocalStatus } from '../../../../../shared/bots/slack-local-status-contract'

export type BotSlackLocalStatus = SlackLocalStatus

const POLL_WHILE_CONNECTING_MS = 3_000
const POLL_WHILE_SHOWN_MS = 15_000

async function changeOnHost(
  target: ReturnType<typeof botHostTarget>,
  method: string,
  params: Record<string, unknown>
): Promise<{ ok: true; status: BotSlackLocalStatus } | { ok: false; error: string }> {
  try {
    return { ok: true, status: await callRuntimeRpc<BotSlackLocalStatus>(target, method, params) }
  } catch (failure) {
    return { ok: false, error: failure instanceof Error ? failure.message : String(failure) }
  }
}

export function useBotSlackLocal(bot: Bot) {
  const [status, setStatus] = useState<BotSlackLocalStatus | null>(null)
  // A failed change stays until the next change; a failed read only until a read succeeds.
  const [error, setError] = useState<string | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const target = botHostTarget(bot.hostId)
  const live = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const next = await callRuntimeRpc<BotSlackLocalStatus>(
        target,
        'bots.slackLocal.status',
        { botId: bot.id },
        { background: true }
      )
      if (live.current) {
        setStatus(next)
        setReadError(null)
      }
    } catch (failure) {
      if (live.current) {
        setReadError(failure instanceof Error ? failure.message : String(failure))
      }
    }
  }, [target, bot.id])

  useEffect(() => {
    live.current = true
    void refresh()
    return () => {
      live.current = false
    }
    // The bot record changes when its connection or people do.
  }, [refresh, bot])

  // The host tells no event when an answer fails or a socket drops: read it while shown, faster while
  // a connection is being made; a first read that failed is tried again at the slower pace.
  const connection = status?.mode === 'local' ? status.connection.state : null
  const pollMs =
    connection === 'connecting'
      ? POLL_WHILE_CONNECTING_MS
      : (connection !== null && connection !== 'paused') || (status === null && readError)
        ? POLL_WHILE_SHOWN_MS
        : null
  useEffect(() => {
    if (pollMs === null) {
      return
    }
    return installWindowVisibilityInterval({ run: () => void refresh(), intervalMs: pollMs })
  }, [pollMs, refresh])

  /** Runs one change on the host; true when it took. */
  const run = useCallback(
    async (method: string, params: Record<string, unknown>): Promise<boolean> => {
      setBusy(true)
      setError(null)
      const answer = await changeOnHost(target, method, { botId: bot.id, ...params })
      if (!live.current) {
        return answer.ok
      }
      setBusy(false)
      if (answer.ok) {
        setStatus(answer.status)
      } else {
        setError(answer.error)
        void refresh()
      }
      return answer.ok
    },
    [target, bot.id, refresh]
  )

  return {
    status,
    error: error ?? readError,
    busy,
    refresh,
    switchToLocal: () => run('bots.slackLocal.useLocal', {}),
    switchToOrca: (forgetTokens: boolean) => run('bots.slackLocal.useOrca', { forgetTokens }),
    setTokens: (tokens: { botToken?: string; appToken?: string }) =>
      run('bots.slackLocal.setTokens', tokens),
    setOwner: (teamId: string, ownerUserId: string | null) =>
      run('bots.slackLocal.setOwner', { expectedTeamId: teamId, ownerUserId }),
    addAskers: (teamId: string, ids: string[]) =>
      run('bots.slackLocal.addAskers', {
        expectedTeamId: teamId,
        askers: ids.map((id) => ({ id }))
      })
  }
}
