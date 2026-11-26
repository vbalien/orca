#!/usr/bin/env node
// A starting point for "Rules from a script" (OpenAI Decisions gate). Copy it somewhere outside the
// bot's folders, edit the parts marked EDIT, and set the gate's "Rules from a script" to run it by its
// full path (it runs in a temporary folder), e.g.
//   node /home/me/orca-gate/channel-rules.mjs
// Orca runs it once per message the gate checks, with the event as JSON on stdin, and reads one JSON
// object from stdout:
//   {"useSaved": true}                 use the rules saved in the gate's editor
//   {"wake": false}                    don't wake; {"wake": true, "reason": "..."} wakes now
//   {"ask": { ...rules JSON }}         ask OpenAI these questions (Orca calls it with the saved key)
// The script never gets the OpenAI key. Any other output, a non-zero exit or a timeout is a failed check,
// and with a rules script a failed check never wakes the bot. Try it from a terminal first:
//   node --import tsx fork/gate-rules-script/try.ts --script "node $PWD/channel-rules.mjs" \
//     --event fork/gate-rules-script/events/channel-question.json
// Plain Node, no dependencies.
import { createHash } from 'node:crypto'

// ---- EDIT: the bot ------------------------------------------------------------------------------
// Every name people call the bot by (any case). A channel message that calls it by one of these wakes
// it at once, without asking OpenAI: names are matched letter by letter, which OpenAI did poorly on in
// tuning (it took other bots' and the owner's names for the bot's).
const BOT_NAMES = ['mybot']
// Its owner, a person (helps OpenAI tell the owner's name from the bot's).
const OWNER_NAME = 'Owner Name'

// ---- EDIT: channels -----------------------------------------------------------------------------
// Slack channel ids (channel details → bottom → Channel ID). A channel not listed gets {"wake": false};
// list the same ids in the gate's "Channels to check".
const CHANNELS = {
  C0000000001: {
    // What the bot is for in this channel (OpenAI reads it as botRole).
    role: "The bot answers questions about the team's shared notes even when not mentioned, and stays out of work discussions that are not about them.",
    // Join casual chat now and then: at most perDay times a local day, cooldownMinutes apart; null: never.
    banter: { perDay: 4, cooldownMinutes: 30 }
  },
  C0000000002: {
    role: 'A casual channel for bots and people. The bot may chat here, but does not discuss work.',
    banter: { perDay: 10, cooldownMinutes: 10 }
  }
}
// Higher wakes less. 0.9 kept needless wakes at 0 in tuning (fork/README.md, "채널 글 기준").
const HELP_AT_LEAST = 0.9
const BANTER_AT_LEAST = 0.9
// --------------------------------------------------------------------------------------------------

const HELP =
  'A Slack bot is in this channel; botRole, if given, says what it is for. The new message (message) was posted in the channel; earlierMessages, if any, are the earlier messages of its thread, oldest first. Does the message ask the room, without naming or @mentioning anyone, for help with something botRole says the bot does? Answer false when it names or @mentions a person or another bot, when it only shares a word with botRole, or when it is chat, a joke, an announcement, a status or leave notice, a link without a question, work talk outside botRole, thanks or a reaction.'
const BANTER =
  'A Slack bot is in this channel; its names are botName and any in botNames; botRole, if given, says what it is for and how it may chat. Answer true only if the new message (message) is light, casual small talk open to anyone in the channel (everyday chat, a joke, a fun or idle question to the room) with no work request or work discussion in it, where a short friendly reply from the bot would feel natural rather than intrusive. Answer false when the message is about work (code, builds, releases, bugs, reviews, plans, schedules, tools used for work), is a leave, attendance or status notice, is directed at a particular person or another bot (by name or with <@…>), is private or sensitive, is part of a conversation between particular people, or is only a link or a one-word reaction.'

/** The key Orca counts a limited rule under, as stdin's `wakes` names it. */
const wakeKey = (questionName) =>
  createHash('sha256').update(questionName).digest('hex').slice(0, 16)

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const NAMED = new RegExp(`(^|[^\\p{L}\\p{N}])(${BOT_NAMES.map(escape).join('|')})`, 'iu')

function decide(event) {
  // Mentions, DMs and replies in the bot's own threads: the editor's saved rules.
  const channelMessage =
    event.case === 'channel_message' ||
    (event.case === 'trigger' && event.trigger?.event === 'message')
  if (!channelMessage) {
    return { useSaved: true }
  }
  const channel = CHANNELS[event.channelId]
  if (!channel) {
    return { wake: false }
  }
  if (NAMED.test(event.text ?? '')) {
    return { wake: true, reason: 'called by name' }
  }
  const questions = [{ type: 'predicate', name: 'asks_for_role_help', instructions: HELP }]
  const rules = [
    {
      question: 'asks_for_role_help',
      wakeIf: { atLeast: HELP_AT_LEAST },
      note: 'asked the room for help: answer it'
    }
  ]
  // Leave the banter question out while its limit is used up: one question less to pay for.
  const used = event.wakes?.[wakeKey('joinable_banter')]
  const banterOpen =
    channel.banter &&
    !used?.pending &&
    !(used && used.today >= channel.banter.perDay) &&
    !(used?.lastAt && Date.now() - used.lastAt < channel.banter.cooldownMinutes * 60_000)
  if (banterOpen) {
    questions.push({ type: 'predicate', name: 'joinable_banter', instructions: BANTER })
    rules.push({
      question: 'joinable_banter',
      wakeIf: { atLeast: BANTER_AT_LEAST },
      limit: { perDay: channel.banter.perDay, cooldownMinutes: channel.banter.cooldownMinutes },
      note: 'banter: join briefly, casual tone'
    })
  }
  return {
    ask: {
      questions,
      send: { message: true, earlierMessages: 10, earlierSpeakers: true, botName: true },
      extra: { botRole: channel.role, botNames: BOT_NAMES, ownerName: OWNER_NAME },
      rules,
      combine: 'any'
    }
  }
}

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => (input += chunk))
process.stdin.on('end', () => {
  process.stdout.write(`${JSON.stringify(decide(JSON.parse(input)))}\n`)
})
