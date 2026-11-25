// Which connector actions a bot on its own Slack app may still send to Orca Cloud: only those that
// name Linear or GitHub for certain, and never anything from a local thread's chat.
import { expect, it } from 'vitest'
import type { ConnectorActionArgs } from '../../shared/connector-action-contract'
import { localSlackActionRefusal } from './slack-local-action-policy'

const linear = { source: 'linear', externalId: 'org:ENG-1' }
const github = { source: 'github', externalId: 'acme/web#4' }
const localThread = { source: 'slack-local', externalId: 'T9:C9:1800000000.000100:U0OWN' }

const allowed = (input: {
  local?: boolean
  linked?: { source: string; externalId: string } | null
  verb: string
  ref?: string
  args?: ConnectorActionArgs
}): boolean =>
  localSlackActionRefusal({
    botUsesLocalSlack: input.local ?? true,
    linked: input.linked ?? null,
    cloudTarget: input.linked && input.linked.source !== 'slack-local' ? input.linked : null,
    verb: input.verb,
    ref: input.ref,
    args: input.args ?? {}
  }) === null

it('refuses everything from a local thread, and all Slack or unsure actions of a local bot', () => {
  // From a local thread's chat, not even a Linear post: its words could carry the thread.
  expect(allowed({ linked: localThread, verb: 'post', ref: 'ENG-1', args: { text: 'x' } })).toBe(
    false
  )
  expect(allowed({ local: false, linked: localThread, verb: 'reply' })).toBe(false)
  // A local bot elsewhere: Slack refs, bare names, raw ids, searches and Slack-only args stay home.
  expect(allowed({ verb: 'read', ref: 'slack:T1:C1' })).toBe(false)
  expect(allowed({ verb: 'find', ref: 'general' })).toBe(false)
  expect(allowed({ verb: 'post', ref: 'C0123ABCD', args: { text: 'x' } })).toBe(false)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a search arg of the shape the CLI sends.
  expect(allowed({ verb: 'find', args: { search: { text: 'q' } } as ConnectorActionArgs })).toBe(
    false
  )
  expect(allowed({ verb: 'canvas' })).toBe(false)
  expect(allowed({ verb: 'post', ref: 'ENG-1', args: { workspace: 'slack:T1:workspace' } })).toBe(
    false
  )
  expect(allowed({ verb: 'post', ref: 'ENG-1', args: { join: true } })).toBe(false)
  expect(allowed({ verb: 'capabilities', args: { text: 'x' } })).toBe(false)
  expect(allowed({ verb: 'reply' })).toBe(false)
  // What names Linear or GitHub goes on, as do the bot's cloud conversations' own replies.
  expect(allowed({ verb: 'post', ref: 'ENG-1', args: { text: 'x' } })).toBe(true)
  expect(allowed({ verb: 'react', ref: 'github:1:2', args: { emoji: '+1' } })).toBe(true)
  expect(allowed({ verb: 'capabilities' })).toBe(true)
  expect(allowed({ verb: 'places', args: { of: 'place' } })).toBe(true)
  expect(allowed({ linked: github, verb: 'reply', args: { text: 'x' } })).toBe(true)
  expect(allowed({ linked: linear, verb: 'reply', args: { stage: true } })).toBe(true)
  // A bot on Orca Cloud's Slack is not touched.
  expect(allowed({ local: false, verb: 'read', ref: 'slack:T1:C1' })).toBe(true)
})
