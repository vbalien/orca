// Right before each post to Slack: a chat posts only while it still holds its thread's link, for the
// bot whose answer it is, and a channel-message chat (`:c`) only while no ordinary chat of the same
// bot holds the thread.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { localSlackConversation } from '../../shared/connectors/local-slack-conversation'
import { removeLink, writeLink } from '../external-conversations/external-conversation-links'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { canonicalLocalChat } from './slack-local-watch'

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'slack-canonical-'))
})
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

const place = { teamId: 'T1', channelId: 'C1', threadTs: '1800000000.000100', botUserId: 'U0BOT' }
const ordinary = localSlackConversation(place)
const channel = localSlackConversation({ ...place, channel: true })

async function home() {
  const store = createStore()
  const group = store.createProjectGroup({
    name: 'Bots',
    parentPath: testState.dir,
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'manual'
  })
  const folder = store.createFolderWorkspace({
    projectGroupId: group.id,
    folderPath: testState.dir
  })
  const link = (key: typeof ordinary, botId: string, sessionId: string) =>
    writeLink(
      store,
      { worktreeId: folderWorkspaceKey(folder.id), sshHostId: null },
      {
        ...key,
        sessionId,
        agent: 'claude',
        paneKey: sessionId,
        bot: { kind: 'bot', botId },
        createdAt: 1
      }
    )
  return { store, link }
}

const of = (botId: string, paneKey: string) => ({ botId, paneKey })

it('posts only for the chat that still holds its thread', async () => {
  const { store, link } = await home()
  expect(canonicalLocalChat(store, ordinary.externalId, of('b1', 's1'))).toBe(false)
  link(ordinary, 'b1', 's1')
  expect(canonicalLocalChat(store, ordinary.externalId, of('b1', 's1'))).toBe(true)
  expect(canonicalLocalChat(store, ordinary.externalId, of('b2', 's1'))).toBe(false)
  // Another chat of the same bot took the thread while an answer waited (a 429): the old one is out.
  link(ordinary, 'b1', 's3')
  expect(canonicalLocalChat(store, ordinary.externalId, of('b1', 's1'))).toBe(false)
  expect(canonicalLocalChat(store, ordinary.externalId, of('b1', 's3'))).toBe(true)
  // Unlinked: nothing goes.
  removeLink(store, ordinary)
  expect(canonicalLocalChat(store, ordinary.externalId, of('b1', 's3'))).toBe(false)
})

it('lets a channel-message chat post only while the bot has no ordinary chat in that thread', async () => {
  const { store, link } = await home()
  link(channel, 'b1', 's1')
  expect(canonicalLocalChat(store, channel.externalId, of('b1', 's1'))).toBe(true)
  link(ordinary, 'b1', 's2')
  expect(canonicalLocalChat(store, channel.externalId, of('b1', 's1'))).toBe(false)
  expect(canonicalLocalChat(store, ordinary.externalId, of('b1', 's2'))).toBe(true)
})
