// The OpenAI Decisions rules in the gate card: a new gate with the default rules, an example, a gate an
// older host still runs (TypeSafe Jev) or this host retired, mistakes placed on their lines, and the
// larger editor; Korean and the narrow side panel included.
import { i18n, loadRendererUiLanguage } from '@/i18n/i18n'
import type { UiLanguage } from '../../../../../../shared/i18n/ui-language'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { Bot } from '../../../../../../shared/bot-types'
import type { BotSlackGate } from '../../../../../../shared/bots/bot-slack-gate'
import { slackOnly } from '../../bot-connectors-host-fixture'
import { BotSlackGateCard } from '../BotSlackGateCard'
import { BotSlackGateRulesEditor } from './BotSlackGateRulesEditor'
import { SLACK_GATE_RULES_EXAMPLES } from '../../../../../../shared/bots/slack-gate-default-rules'

const topic: BotSlackGate = {
  on: true,
  kind: 'openai',
  appliesTo: ['mention', 'thread_reply'],
  timeoutSeconds: 10,
  onError: 'wake',
  openai: SLACK_GATE_RULES_EXAMPLES[2]!.config
}
// What an older host still keeps and sends: a gate kind this Orca no longer knows.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a stored shape this build's type no longer has.
const olderHostJev = {
  on: true,
  kind: 'jev',
  appliesTo: ['thread_reply'],
  timeoutSeconds: 10,
  onError: 'wake',
  jev: { question: 'Is this a request?', threshold: 0.6 }
} as unknown as BotSlackGate
const broken = `{
  "questions": [
    { "type": "predicate", "name": "asks_bot", "instructions": "Asks the bot?" },
    { "type": "choice", "name": "asks_bot", "instructions": "Topic?", "choices": [{ "value": "deploy" }] }
  ],
  "rules": [
    { "question": "asks_bot", "wakeIf": { "atLeast": 1.5 } }
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
          result: { apiKeySet: false, openaiKeySet: true, sealing: 'os-keychain' }
        }
      : call(args)
}

const language = (lang: UiLanguage) => async () => {
  await i18n.changeLanguage(await loadRendererUiLanguage(lang))
  await new Promise((resolve) => setTimeout(resolve, 300))
}

const card = (
  gate: BotSlackGate | undefined,
  width: number,
  lang: UiLanguage = 'ko',
  extra: Partial<Bot> = {}
) =>
  defineFixture({
    width,
    setup: answerKeyStatus,
    render: () => {
      const bot: Bot = {
        ...slackOnly,
        name: 'Elyang',
        ...(gate ? { slackGate: gate } : {}),
        ...extra
      }
      return (
        <div className="bg-sidebar p-3 text-sidebar-foreground">
          <BotSlackGateCard bot={bot} />
        </div>
      )
    },
    interact: language(lang)
  })

export const koreanDefault = card(undefined, 390)
export const koreanNarrow = card(undefined, 330)
export const koreanTopic = card(topic, 390)
export const koreanRetired = card(undefined, 390, 'ko', { slackGateRetired: 'jev' })
export const koreanOlderHost = card(olderHostJev, 390)
export const englishDefault = card(undefined, 390, 'en')

export const koreanErrors = defineFixture({
  width: 390,
  render: () => (
    <div className="bg-sidebar p-3 text-sidebar-foreground">
      <BotSlackGateRulesEditor text={broken} botName="Elyang" onChange={() => {}} />
    </div>
  ),
  interact: language('ko')
})

export const koreanLarger = defineFixture({
  width: 1100,
  render: () => (
    <div className="h-[760px] bg-sidebar p-3 text-sidebar-foreground">
      <BotSlackGateRulesEditor text={broken} botName="Elyang" onChange={() => {}} />
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
