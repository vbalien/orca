// The Slack wake gate card alone, at the connector page's width, in both kinds and in Korean.
import { i18n, loadRendererUiLanguage } from '@/i18n/i18n'
import type { UiLanguage } from '../../../../../shared/i18n/ui-language'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotSlackGate } from '../../../../../shared/bots/bot-slack-gate'
import { slackOnly } from '../bot-connectors-host-fixture'
import { BotSlackGateCard } from './BotSlackGateCard'
import { SLACK_GATE_DEFAULT_RULES } from '../../../../../shared/bots/slack-gate-default-rules'

const openai: BotSlackGate = {
  on: true,
  kind: 'openai',
  appliesTo: ['thread_reply', 'trigger'],
  timeoutSeconds: 10,
  onError: 'wake',
  openai: SLACK_GATE_DEFAULT_RULES
}
const command: BotSlackGate = {
  on: true,
  kind: 'command',
  appliesTo: ['mention', 'dm', 'thread_reply'],
  timeoutSeconds: 5,
  onError: 'block',
  command: '~/bin/slack-gate --strict'
}

function answerKeyStatus(apiKeySet: boolean): void {
  const call = window.api.runtime.call
  window.api.runtime.call = async (args) =>
    args.method === 'bots.slackGate.status'
      ? {
          id: 'slack-gate-status',
          ok: true,
          _meta: { runtimeId: 'fixture' },
          result: { apiKeySet, openaiKeySet: apiKeySet, sealing: 'os-keychain' }
        }
      : call(args)
}

const card = (
  gate: BotSlackGate | undefined,
  options: { language?: UiLanguage; key?: boolean } = {}
) =>
  defineFixture({
    width: 390,
    setup: () => answerKeyStatus(options.key ?? false),
    render: () => {
      const bot: Bot = { ...slackOnly, ...(gate ? { slackGate: gate } : {}) }
      return (
        <div className="bg-sidebar p-3 text-sidebar-foreground">
          <BotSlackGateCard bot={bot} />
        </div>
      )
    },
    interact: async () => {
      // Fixture pages share one i18n instance; a localized shot sets it back afterwards.
      await i18n.changeLanguage(await loadRendererUiLanguage(options.language ?? 'en'))
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  })

export const off = card(undefined)
export const openaiWithKey = card(openai, { key: true })
export const commandGate = card(command)
export const koreanOpenAI = card(openai, { language: 'ko' })
export const koreanCommand = card(command, { language: 'ko', key: true })
