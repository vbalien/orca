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

export type SlackGateRulesExample = {
  id: 'default' | 'smallTalk' | 'topic'
  config: SlackGateRulesConfig
}

export const SLACK_GATE_RULES_EXAMPLES: readonly SlackGateRulesExample[] = [
  { id: 'default', config: SLACK_GATE_DEFAULT_RULES },
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
