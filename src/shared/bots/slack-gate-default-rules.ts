// The rules a new OpenAI Decisions gate starts with, and the editor's "Insert example" configs. English
// whatever the UI language: it is what OpenAI reads. Names no bot: the bot's name goes along as botName.
import type { SlackGateRulesConfig } from './slack-gate-rules-config'

/** Wakes for any thread reply meant for the bot, and leans to waking: a missed request costs more than
 *  an extra wake. At or above 0.5 wakes; 0.25 up to 0.5 is unsure and wakes too; only below 0.25 blocks.
 *  Wording and numbers chosen on labelled real threads (fork/README.md, "OpenAI 게이트 임계값 맞추기"). */
export const SLACK_GATE_DEFAULT_RULES: SlackGateRulesConfig = {
  questions: [
    {
      type: 'predicate',
      name: 'for_the_bot',
      instructions:
        'If mentioned is true, the message @mentions the bot: answer true. A Slack bot takes part in this thread; its name is botName. Decide whether the new message (message), or any message sent right after it by the same person (laterMessages), is meant for the bot: it mentions or talks to the bot (mentioned is true when it @mentions the bot), answers something the bot said or asked, asks it a question, or asks it to do something, even without naming it. earlierMessages are the thread\'s earlier messages, oldest first, each marked from "this_bot" (the bot itself), "app" (some Slack app, possibly the bot), "person" or "note". Answer false only when people are talking among themselves, answering someone other than the bot, thanking, or reacting, with nothing for the bot to do. The bot\'s own @mention is removed from message (that is what mentioned: true reports), so any <@…> left in message mentions someone else, a person or another app: a message that speaks to someone that way is for them, unless it also asks the bot.'
    }
  ],
  send: {
    message: true,
    earlierMessages: 10,
    earlierSpeakers: true,
    laterMessages: true,
    mentioned: true,
    fromRole: true,
    botName: true,
    truncated: true
  },
  rules: [{ question: 'for_the_bot', wakeIf: { atLeast: 0.5 }, unsureFrom: 0.25 }],
  whenUnsure: 'wake'
}

const THREAD_QUESTION = SLACK_GATE_DEFAULT_RULES.questions[0]!

/** The question for a channel message no one addressed to the bot: conservative, it passes only what
 *  speaks to the bot or asks the room for its kind of help. Put botRole (what the bot is for), botNames
 *  and ownerName in `extra`. Chosen on real channel messages for no needless wakes (fork/README.md,
 *  "채널 글 기준"). */
const CHANNEL_QUESTION = {
  type: 'predicate' as const,
  name: 'asks_the_bot',
  instructions:
    "If case is not channel_message, answer false. A Slack bot is in this channel. Its names are botName and any in botNames; ownerName, if given, is its owner, a person. botRole, if given, says what the bot is for. The new message (message) was posted in the channel without @mentioning the bot; earlierMessages, if any, are the earlier messages of its thread, oldest first. Decide whether the message is for the bot. Answer true only if (a) it calls the bot by one of its names (any spelling or case) and greets it, asks it something or asks it to do something, even when the request is about someone else, such as passing a message on to a person; or (b) it asks the room, without naming anyone, for help with something botRole says the bot does. Answer false when the message names or @mentions someone else and speaks to them: a person (the owner included, whose name may look like the bot's) or another bot. Also answer false when people are talking among themselves, or for an announcement, a status or leave notice, a link without a question, work talk outside botRole, a joke, banter, thanks or a reaction. Any <@…> in message is someone other than this bot (its own mention is removed)."
}

/** Rules for thread replies and channel messages together: the thread question as before (told to
 *  answer false for a channel message) and the channel question at 0.9. A channel message is never
 *  woken by an unsure answer, whatever whenUnsure says. */
export const SLACK_GATE_CHANNEL_DEFAULT_RULES: SlackGateRulesConfig = {
  questions: [
    {
      ...THREAD_QUESTION,
      instructions: `If case is channel_message, answer false. ${THREAD_QUESTION.instructions}`
    },
    CHANNEL_QUESTION
  ],
  send: { ...SLACK_GATE_DEFAULT_RULES.send, case: true },
  rules: [
    { question: 'for_the_bot', wakeIf: { atLeast: 0.5 }, unsureFrom: 0.25 },
    { question: 'asks_the_bot', wakeIf: { atLeast: 0.9 } }
  ],
  combine: 'any',
  whenUnsure: 'wake'
}

export type SlackGateRulesExample = {
  id: 'default' | 'channel' | 'banter' | 'smallTalk' | 'topic'
  config: SlackGateRulesConfig
}

export const SLACK_GATE_RULES_EXAMPLES: readonly SlackGateRulesExample[] = [
  { id: 'default', config: SLACK_GATE_DEFAULT_RULES },
  { id: 'channel', config: SLACK_GATE_CHANNEL_DEFAULT_RULES },
  {
    id: 'banter',
    config: {
      ...SLACK_GATE_CHANNEL_DEFAULT_RULES,
      questions: [
        ...SLACK_GATE_CHANNEL_DEFAULT_RULES.questions,
        {
          type: 'predicate',
          name: 'joinable_banter',
          instructions:
            'If case is not channel_message, answer false. A Slack bot is in this channel; its names are botName and any in botNames; botRole, if given, says what it is for and how it may chat. Answer true only if the new message (message) is light, casual small talk open to anyone in the channel (everyday chat, a joke, a fun or idle question to the room) with no work request or work discussion in it, where a short friendly reply from the bot would feel natural rather than intrusive. Answer false when the message is about work (code, builds, releases, bugs, reviews, plans, schedules, tools used for work), is a leave, attendance or status notice, is directed at a particular person or another bot (by name or with <@…>), is private or sensitive, is part of a conversation between particular people, or is only a link or a one-word reaction.'
        }
      ],
      extra: {
        botRole: 'Describe what the bot is for here, and that it may join casual chat now and then.'
      },
      rules: [
        ...SLACK_GATE_CHANNEL_DEFAULT_RULES.rules,
        {
          question: 'joinable_banter',
          wakeIf: { atLeast: 0.9 },
          limit: { perDay: 4, cooldownMinutes: 30 },
          note: 'banter: join briefly, casual tone'
        }
      ]
    }
  },
  {
    id: 'smallTalk',
    config: {
      questions: [
        {
          type: 'predicate',
          name: 'small_talk',
          instructions:
            'Is this message (message) small talk between people, with nothing for the bot named botName to answer or do?'
        }
      ],
      send: { message: true, earlierMessages: 5, earlierSpeakers: true, botName: true },
      rules: [{ question: 'small_talk', blockIf: { atLeast: 0.8 } }]
    }
  },
  {
    id: 'topic',
    config: {
      questions: [
        {
          type: 'choice',
          name: 'topic',
          instructions: 'What is this message (message) about?',
          choices: [
            { value: 'deploy', description: 'Releases and deploys' },
            { value: 'review', description: 'Code review' },
            { value: 'other', description: 'Anything else' }
          ]
        },
        {
          type: 'score',
          name: 'urgency',
          instructions: 'How urgent is this message (message)?',
          levels: [
            { label: 'Can wait' },
            { label: 'This week' },
            { label: 'Today', description: 'Something is broken or blocked now' }
          ]
        }
      ],
      send: { message: true, earlierMessages: 5, case: true, place: true, fromRole: true },
      extra: { team: 'The team ships a desktop app and reviews code in Slack.' },
      rules: [
        { question: 'topic', wakeIf: { oneOf: ['deploy', 'review'] } },
        { question: 'urgency', wakeIf: { atLeast: 1.5 }, unsureFrom: 1 }
      ],
      combine: 'any',
      whenUnsure: 'wake'
    }
  }
]
