// The Jev rules editor in the gate card: a config with rules, the legacy one-question gate as JSON,
// mistakes placed on their lines, and the larger editor; Korean and the narrow side panel included.
import { i18n, loadRendererUiLanguage } from '@/i18n/i18n'
import type { UiLanguage } from '../../../../../../shared/i18n/ui-language'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { Bot } from '../../../../../../shared/bot-types'
import type { BotSlackGate } from '../../../../../../shared/bots/bot-slack-gate'
import { slackOnly } from '../../bot-connectors-host-fixture'
import { BotSlackGateCard } from '../BotSlackGateCard'
import { BotSlackGateJevEditor } from './BotSlackGateJevEditor'

const shared: Pick<BotSlackGate, 'on' | 'appliesTo' | 'timeoutSeconds' | 'onError'> = {
  on: true,
  appliesTo: ['mention', 'thread_reply'],
  timeoutSeconds: 10,
  onError: 'wake'
}
const rules: BotSlackGate = {
  ...shared,
  kind: 'jev',
  jev: {
    questions: {
      asks_bot: {
        type: 'noul',
        instructions: '이 글은 엘량에게 답이나 일을 요구하는가?',
        criteria: {
          true: '엘량을 부르거나 엘량에게 일을 시킴',
          false: '사람끼리의 대화, 인사, 공지'
        }
      },
      small_talk: { type: 'noul', instructions: '엘량이 할 일이 없는, 사람끼리의 잡담인가?' }
    },
    send: {
      message: true,
      earlierMessages: 5,
      earlierOwn: true,
      case: true,
      place: true,
      fromRole: true,
      mentioned: true,
      botName: true,
      truncated: true
    },
    extra: { botRole: '엘량은 Orca 저장소의 코드 리뷰와 배포를 돕는 봇이다.' },
    rules: [
      { question: 'asks_bot', wakeIf: { atLeast: 0.7 }, unsureFrom: 0.4 },
      { question: 'small_talk', blockIf: { atLeast: 0.8 } }
    ],
    whenUnsure: 'block',
    question: '이 글은 엘량에게 답이나 일을 요구하는가?',
    threshold: 0.7
  }
}
const legacy: BotSlackGate = {
  ...shared,
  kind: 'jev',
  jev: { question: '이 글은 엘량에게 답을 요구하는가?', threshold: 0.6 }
}
const broken = `{
  "questions": {
    "asks_bot": { "type": "noul", "instructions": "엘량에게 일을 시키는가?" },
    "topic": { "type": "choice", "criteria": { "deploy": "배포" } }
  },
  "rules": [
    { "question": "asks_bot", "wakeIf": { "atLeast": 1.5 } },
    { "question": "topic", "wakeIf": { "oneOf": ["review"] } }
  ]
}`

function answerKeyStatus(): void {
  const call = window.api.runtime.call
  window.api.runtime.call = async (args) =>
    args.method === 'bots.slackGate.status'
      ? {
          id: 'status',
          ok: true,
          _meta: { runtimeId: 'fixture' },
          result: { apiKeySet: true, sealing: 'os-keychain' }
        }
      : call(args)
}

const language = (lang: UiLanguage) => async () => {
  await i18n.changeLanguage(await loadRendererUiLanguage(lang))
  await new Promise((resolve) => setTimeout(resolve, 300))
}

const card = (gate: BotSlackGate, width: number, lang: UiLanguage = 'ko') =>
  defineFixture({
    width,
    setup: answerKeyStatus,
    render: () => {
      const bot: Bot = { ...slackOnly, name: '엘량', slackGate: gate }
      return (
        <div className="bg-sidebar p-3 text-sidebar-foreground">
          <BotSlackGateCard bot={bot} />
        </div>
      )
    },
    interact: language(lang)
  })

export const koreanRules = card(rules, 390)
export const koreanNarrow = card(rules, 330)
export const koreanLegacy = card(legacy, 390)
export const englishRules = card(rules, 390, 'en')

export const koreanErrors = defineFixture({
  width: 390,
  render: () => (
    <div className="bg-sidebar p-3 text-sidebar-foreground">
      <BotSlackGateJevEditor text={broken} botName="엘량" onChange={() => {}} />
    </div>
  ),
  interact: language('ko')
})

export const koreanLarger = defineFixture({
  width: 1100,
  render: () => (
    <div className="h-[760px] bg-sidebar p-3 text-sidebar-foreground">
      <BotSlackGateJevEditor text={broken} botName="엘량" onChange={() => {}} />
    </div>
  ),
  interact: async (frame) => {
    await language('ko')()
    const open = [...frame.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('넓게')
    )
    open?.click()
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
})
