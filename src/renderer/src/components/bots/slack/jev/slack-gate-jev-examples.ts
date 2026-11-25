// Ready-to-use Jev gate configs for "Insert example", and the sample Slack message the preview shows.
// Texts are in the reader's language: they are what Jev reads.
import type { useTranslate } from '@/i18n/use-translate'
import type { SlackGateEvent } from '../../../../../../shared/bots/bot-slack-gate'
import type { SlackGateJevConfig } from '../../../../../../shared/bots/slack-gate-jev-config'

type Translate = ReturnType<typeof useTranslate>

export type SlackGateJevExample = { id: string; label: string; config: SlackGateJevConfig }

export function slackGateJevExamples(t: Translate, botName: string): SlackGateJevExample[] {
  const bot = { bot: botName }
  return [
    {
      id: 'asked',
      label: t('bots.slack.gate.jev.example.asked', 'Answer only when asked'),
      config: {
        questions: {
          asks_bot: {
            type: 'noul',
            instructions: t(
              'bots.slack.gate.jev.example.askedQuestion',
              'Does this message ask {{bot}} to answer or do something?',
              bot
            ),
            criteria: {
              true: t(
                'bots.slack.gate.jev.example.askedTrue',
                'It calls {{bot}} or gives it a task',
                bot
              ),
              false: t(
                'bots.slack.gate.jev.example.askedFalse',
                'People talking to each other, greetings, announcements'
              )
            }
          }
        },
        extra: {
          botRole: t(
            'bots.slack.gate.jev.example.botRole',
            '{{bot}} answers questions and does tasks for this team.',
            bot
          )
        },
        rules: [{ question: 'asks_bot', wakeIf: { atLeast: 0.7 }, unsureFrom: 0.4 }],
        whenUnsure: 'block'
      }
    },
    {
      id: 'smallTalk',
      label: t('bots.slack.gate.jev.example.smallTalk', 'Block small talk'),
      config: {
        questions: {
          small_talk: {
            type: 'noul',
            instructions: t(
              'bots.slack.gate.jev.example.smallTalkQuestion',
              'Is this small talk between people, with nothing for {{bot}} to do?',
              bot
            )
          }
        },
        rules: [{ question: 'small_talk', blockIf: { atLeast: 0.8 } }]
      }
    },
    {
      id: 'topic',
      label: t('bots.slack.gate.jev.example.topic', 'Topic and urgency'),
      config: {
        questions: {
          topic: {
            type: 'choice',
            instructions: t(
              'bots.slack.gate.jev.example.topicQuestion',
              'What is this message about?'
            ),
            criteria: {
              deploy: t('bots.slack.gate.jev.example.topicDeploy', 'Releases and deploys'),
              review: t('bots.slack.gate.jev.example.topicReview', 'Code review'),
              other: t('bots.slack.gate.jev.example.topicOther', 'Anything else')
            }
          },
          urgency: {
            type: 'score',
            instructions: t('bots.slack.gate.jev.example.urgencyQuestion', 'How urgent is this?'),
            criteria: [
              t('bots.slack.gate.jev.example.urgencyLow', 'Can wait'),
              t('bots.slack.gate.jev.example.urgencyMid', 'This week'),
              t('bots.slack.gate.jev.example.urgencyHigh', 'Today')
            ]
          }
        },
        send: {
          message: true,
          earlierMessages: 5,
          case: true,
          place: true,
          fromRole: true,
          mentioned: true,
          botName: true,
          truncated: true
        },
        rules: [
          { question: 'topic', wakeIf: { oneOf: ['deploy', 'review'] } },
          { question: 'urgency', wakeIf: { atLeast: 1.5 }, unsureFrom: 1 }
        ],
        combine: 'any',
        whenUnsure: 'wake'
      }
    }
  ]
}

/** The message the preview builds a request for. */
export function slackGateJevSampleEvent(t: Translate): SlackGateEvent {
  return {
    eventId: 'preview',
    case: 'thread_reply',
    teamId: 'T0',
    channelId: 'C0',
    placeKind: 'public_channel',
    from: {
      userId: 'U0',
      name: t('bots.slack.gate.jev.sample.name', 'Dana'),
      role: 'member'
    },
    text: t('bots.slack.gate.jev.sample.message', 'Can you check why the deploy failed?'),
    mentioned: false,
    context: [
      {
        kind: 'earlier',
        text: t('bots.slack.gate.jev.sample.earlier1', 'The deploy is running now.')
      },
      { kind: 'bot', text: t('bots.slack.gate.jev.sample.earlier2', 'Started the deploy.') }
    ]
  }
}
