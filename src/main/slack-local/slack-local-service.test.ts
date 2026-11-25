// A bot's own Slack app's settings change as one: tokens and the workspace they speak for together,
// one app per bot, and nobody keeps access across a workspace change or a stale request.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import { applyBotUpdates, type BotHostUpdates } from '../../shared/rpc-contract/bots-params'
import type { SecretStore } from '../../shared/secure-storage/secret-store'
import { refuseLocalSlackMemberAdds } from './slack-local-members'
import { SlackLocalService, type SlackLocalServiceDeps } from './slack-local-service'
import { SlackLocalTokenStore } from './slack-local-token-store'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const keyring: SecretStore = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(Buffer.from(text, 'utf8').map((byte) => byte ^ 0x5a)),
  decryptString: (cipher) => Buffer.from(cipher.map((byte) => byte ^ 0x5a)).toString('utf8'),
  describeProtectionGap: () => null,
  describeSealing: () => ({ kind: 'os-keychain' })
}

const TOKENS: Record<string, { team: string; user: string; app: string }> = {
  'xoxb-team-one-aaaaaaaaaa': { team: 'T1', user: 'U0BOT1', app: 'A1' },
  'xoxb-team-two-bbbbbbbbbb': { team: 'T2', user: 'U0BOT2', app: 'A2' },
  // The first app's bot token, reissued.
  'xoxb-team-one-rotated-dd': { team: 'T1', user: 'U0BOT1', app: 'A1' }
}
const APP_TOKEN = 'xapp-1-app-token-cccccccc'

function bot(id: string, extra: Partial<Bot> = {}): Bot {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test bot record with the fields the service reads.
  return { id, name: id, agent: 'claude', members: [], slack: null, ...extra } as unknown as Bot
}

type Post = { token: string; text: string }

/** `helloApp`: the app Socket Mode's hello names; by default the bot token's own app, '' none. */
function harness(
  bots: Bot[],
  failNextUpdate = false,
  helloApp?: string,
  postAnswers: Response[] = []
) {
  const dir = mkdtempSync(join(tmpdir(), 'slack-local-service-'))
  dirs.push(dir)
  let failing = failNextUpdate
  const records = new Map(bots.map((entry) => [entry.id, entry]))
  let lastApp: string | undefined
  const posts: Post[] = []
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const token = String(new Headers(init?.headers).get('authorization')).replace('Bearer ', '')
    // As Slack answers a bot token: auth.test names the bot, bots.info its app.
    if (String(url).endsWith('chat.postMessage')) {
      const text = new URLSearchParams(String(init?.body)).get('markdown_text') ?? ''
      posts.push({ token, text })
      return postAnswers.shift() ?? Response.json({ ok: true })
    }
    if (String(url).endsWith('auth.test')) {
      const who = TOKENS[token]
      lastApp = who?.app
      return Response.json(
        who
          ? { ok: true, team_id: who.team, team: 'Team', user_id: who.user, bot_id: `B${who.app}` }
          : { ok: false, error: 'invalid_auth' }
      )
    }
    if (String(url).endsWith('bots.info')) {
      return Response.json({ ok: true, bot: { app_id: TOKENS[token]?.app } })
    }
    return Response.json({ ok: true, url: 'wss://slack.test/1' })
  }
  const runtime = {
    bots: {
      list: () => [...records.values()],
      enabled: () => true,
      update: async (botId: string, edit: (current: Bot) => BotHostUpdates) => {
        const current = records.get(botId)
        if (!current) {
          throw new Error('no such bot')
        }
        const updates = edit(current)
        if (failing) {
          failing = false
          throw new Error('disk full')
        }
        records.set(botId, applyBotUpdates(current, updates))
        return records.get(botId)!
      }
    },
    onBotsWritten: () => () => {},
    notifyBotsChanged: () => {},
    getExternalConversationSeam: () => null,
    getConnectorCloud: () => null
  }
  const tokens = new SlackLocalTokenStore(dir, () => keyring)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the members the service uses.
  const deps = {
    runtime,
    store: { listAutomations: () => [] },
    tokens,
    fetch,
    // Socket Mode says hello at once, as the app the test names (none: Slack doesn't say).
    socketFactory: () => ({
      on: (event: string, listener: (data: unknown) => void) => {
        if (event === 'message') {
          const hello = {
            type: 'hello',
            ...((helloApp ?? lastApp) ? { connection_info: { app_id: helloApp ?? lastApp } } : {})
          }
          queueMicrotask(() => listener(Buffer.from(JSON.stringify(hello))))
        }
      },
      send: () => {},
      ping: () => {},
      terminate: () => {}
    })
  } as unknown as SlackLocalServiceDeps
  const service = new SlackLocalService(deps)
  return { service, tokens, records, runtime, posts }
}

const local = (record: Bot | undefined) =>
  record?.slackConnection?.mode === 'local' ? record.slackConnection : null

it('saves tokens with their workspace, keeps the old pair when the record fails, and one app per bot', async () => {
  const h = harness([bot('b1'), bot('b2')])
  await h.service.config.useLocal('b1')
  await h.service.config.setTokens('b1', {
    botToken: 'xoxb-team-one-aaaaaaaaaa',
    appToken: APP_TOKEN
  })
  expect(local(h.records.get('b1'))).toMatchObject({
    teamId: 'T1',
    botUserId: 'U0BOT1',
    appId: 'A1'
  })
  expect(await h.tokens.read('b1')).toMatchObject({ teamId: 'T1' })

  // Another bot can't take the same app.
  await h.service.config.useLocal('b2')
  await expect(
    h.service.config.setTokens('b2', { botToken: 'xoxb-team-one-aaaaaaaaaa', appToken: APP_TOKEN })
  ).rejects.toThrow('slack_local:app_claimed')
  expect(await h.tokens.has('b2')).toBe(false)

  // The record can't be saved: the file goes back to the pair that worked.
  const failing = harness([bot('b1')], false)
  await failing.service.config.useLocal('b1')
  await failing.service.config.setTokens('b1', {
    botToken: 'xoxb-team-one-aaaaaaaaaa',
    appToken: APP_TOKEN
  })
  const update = failing.records.get('b1')!
  const failingOnce = harness([update], true)
  await failingOnce.tokens.write('b1', (await failing.tokens.read('b1'))!)
  await expect(
    failingOnce.service.config.setTokens('b1', { botToken: 'xoxb-team-two-bbbbbbbbbb' })
  ).rejects.toThrow('disk full')
  expect(await failingOnce.tokens.read('b1')).toMatchObject({ teamId: 'T1' })
})

it('drops the old workspace’s people and owner on a workspace change, and refuses stale requests', async () => {
  const h = harness([bot('b1')])
  await h.service.config.useLocal('b1')
  await h.service.config.setTokens('b1', {
    botToken: 'xoxb-team-one-aaaaaaaaaa',
    appToken: APP_TOKEN
  })
  await h.service.config.setOwner('b1', 'T1', 'U0OWNER')
  await h.service.config.addAskers('b1', 'T1', [{ id: 'U0FRIEND' }])
  expect(h.records.get('b1')!.members).toMatchObject([{ id: 'U0FRIEND', source: 'slack-local' }])

  await h.service.config.setTokens('b1', { botToken: 'xoxb-team-two-bbbbbbbbbb' })
  expect(local(h.records.get('b1'))).toMatchObject({ teamId: 'T2' })
  expect(local(h.records.get('b1'))?.ownerUserId).toBeUndefined()
  expect(h.records.get('b1')!.members).toEqual([])
  // A request made while the bot showed T1 doesn't land on T2.
  await expect(h.service.config.addAskers('b1', 'T1', [{ id: 'U0FRIEND' }])).rejects.toThrow(
    'team_changed'
  )
  await expect(h.service.config.setOwner('b1', 'T1', 'U0OWNER')).rejects.toThrow('team_changed')
  expect(h.records.get('b1')!.members).toEqual([])

  // Back to Orca Cloud: the own app's people go with it.
  await h.service.config.addAskers('b1', 'T2', [{ id: 'U0OTHER' }])
  await h.service.config.useOrca('b1', true)
  expect(h.records.get('b1')!.members).toEqual([])
  expect(await h.tokens.has('b1')).toBe(false)
})

it('lets a generic update remove local askers but never add or restore one', () => {
  const asker = { id: 'U0FRIEND', name: 'f', source: 'slack-local', workspaceId: 'T1' }
  const withAsker = { members: [asker] }
  expect(() => refuseLocalSlackMemberAdds(withAsker, { members: [] })).not.toThrow()
  expect(() => refuseLocalSlackMemberAdds(withAsker, { members: [asker] })).not.toThrow()
  // After the removal landed, a stale full list that still names them is refused.
  expect(() => refuseLocalSlackMemberAdds({ members: [] }, { members: [asker] })).toThrow()
  expect(() => refuseLocalSlackMemberAdds({ members: [] }, { addMembers: [asker] })).toThrow()
  expect(() =>
    refuseLocalSlackMemberAdds(
      { members: [] },
      { addMembers: [{ id: 'U1', name: 'u', source: 'slack' }] }
    )
  ).not.toThrow()
})

it('forgets the tokens of a bot that no longer exists, and keeps the others', async () => {
  const h = harness([bot('b1')])
  await h.service.config.useLocal('b1')
  await h.service.config.setTokens('b1', {
    botToken: 'xoxb-team-one-aaaaaaaaaa',
    appToken: APP_TOKEN
  })
  const stray = await h.tokens.read('b1')
  await h.tokens.write('gone', { ...stray!, teamId: 'T3', botUserId: 'U0GONE' })
  h.service.start()
  await vi.waitFor(async () => expect(await h.tokens.has('gone')).toBe(false))
  expect(await h.tokens.has('b1')).toBe(true)
  h.service.stop()
})

it('leaves no tokens behind when the bot was deleted while its new tokens were being saved', async () => {
  const h = harness([bot('b1')])
  await h.service.config.useLocal('b1')
  await h.service.config.setTokens('b1', {
    botToken: 'xoxb-team-one-aaaaaaaaaa',
    appToken: APP_TOKEN
  })
  // The bot goes while the record update for new tokens is queued: that update then fails.
  const update = h.runtime.bots.update
  h.runtime.bots.update = async (botId, edit) => {
    h.records.delete(botId)
    return update(botId, edit)
  }
  await expect(
    h.service.config.setTokens('b1', { botToken: 'xoxb-team-two-bbbbbbbbbb' })
  ).rejects.toThrow()
  expect(await h.tokens.has('b1')).toBe(false)
})

it('refuses a pair of tokens from two different apps before replacing anything', async () => {
  const h = harness([bot('b1')], false, 'A9')
  const unnamed = harness([bot('b1')], false, '')
  await unnamed.service.config.useLocal('b1')
  await expect(
    unnamed.service.config.setTokens('b1', {
      botToken: 'xoxb-team-one-aaaaaaaaaa',
      appToken: APP_TOKEN
    })
  ).rejects.toThrow('slack_local:app_unknown')
  expect(await unnamed.tokens.has('b1')).toBe(false)
  await h.service.config.useLocal('b1')
  await expect(
    h.service.config.setTokens('b1', { botToken: 'xoxb-team-one-aaaaaaaaaa', appToken: APP_TOKEN })
  ).rejects.toThrow('slack_local:app_mismatch')
  expect(await h.tokens.has('b1')).toBe(false)
  expect(local(h.records.get('b1'))?.teamId).toBeUndefined()
})

it('keeps an answer waiting out a rate limit through a token change of the same app', async () => {
  const h = harness([bot('b1')], false, undefined, [
    new Response('', { status: 429, headers: { 'retry-after': '1' } })
  ])
  await h.service.config.useLocal('b1')
  await h.service.config.setTokens('b1', {
    botToken: 'xoxb-team-one-aaaaaaaaaa',
    appToken: APP_TOKEN
  })
  h.service.deliver('b1', {
    kind: 'turn-ended',
    conversation: { source: 'slack-local', externalId: 'T1:C1:1800000000.000100:U0BOT1' },
    worktreeId: 'wt',
    paneKey: 'p',
    turnId: 1,
    stopReason: 'success',
    at: 1,
    origin: 'delivery',
    lastAssistantMessage: 'done'
  })
  await vi.waitFor(() => expect(h.posts).toHaveLength(1))
  // Reissued while the answer waits: it goes on with the new token, once.
  await h.service.config.setTokens('b1', { botToken: 'xoxb-team-one-rotated-dd' })
  await vi.waitFor(() => expect(h.posts).toHaveLength(2), { timeout: 4_000 })
  expect(h.posts).toEqual([
    { token: 'xoxb-team-one-aaaaaaaaaa', text: 'done' },
    { token: 'xoxb-team-one-rotated-dd', text: 'done' }
  ])
  expect(await h.service.status('b1')).not.toHaveProperty('lastReplyError')
  h.service.stop()
})
