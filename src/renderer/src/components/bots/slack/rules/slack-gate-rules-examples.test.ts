// Every "Insert example" config, the default first, is valid as inserted and builds a request.
import { describe, expect, it } from 'vitest'
import { slackGateOpenAIRequest } from '../../../../../../shared/bots/slack-gate-openai-request'
import { parseSlackGateRulesText } from '../../../../../../shared/bots/slack-gate-rules-text'
import { SLACK_GATE_RULES_EXAMPLES } from '../../../../../../shared/bots/slack-gate-default-rules'
import { SLACK_GATE_SAMPLE_EVENT } from './slack-gate-rules-examples'

describe('SLACK_GATE_RULES_EXAMPLES', () => {
  it('inserts only configs the editor accepts', () => {
    expect(SLACK_GATE_RULES_EXAMPLES.map((example) => example.id)).toEqual([
      'default',
      'smallTalk',
      'topic'
    ])
    for (const example of SLACK_GATE_RULES_EXAMPLES) {
      const parsed = parseSlackGateRulesText(JSON.stringify(example.config, null, 2))
      expect(parsed.ok ? [] : parsed.issues).toEqual([])
      const request = slackGateOpenAIRequest(
        example.config,
        { name: 'Elyang' },
        SLACK_GATE_SAMPLE_EVENT
      )
      expect(request?.questions).toEqual(example.config.questions)
    }
  })
})
