// Every "Insert example" config is valid as inserted, and the preview's sample builds a request.
import { describe, expect, it } from 'vitest'
import { slackGateJevRequest } from '../../../../../../shared/bots/slack-gate-jev-request'
import { parseSlackGateJevText } from '../../../../../../shared/bots/slack-gate-jev-text'
import { slackGateJevExamples, slackGateJevSampleEvent } from './slack-gate-jev-examples'

const t: Parameters<typeof slackGateJevExamples>[0] = (
  _key: string,
  text?: string,
  vars?: Record<string, unknown>
) => (text ?? '').replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(vars?.[name] ?? ''))

describe('slackGateJevExamples', () => {
  it('inserts only configs the editor accepts', () => {
    const examples = slackGateJevExamples(t, 'Elyang')
    expect(examples.map((example) => example.id)).toEqual(['asked', 'smallTalk', 'topic'])
    for (const example of examples) {
      const parsed = parseSlackGateJevText(JSON.stringify(example.config, null, 2))
      expect(parsed.ok ? [] : parsed.issues).toEqual([])
      const request = slackGateJevRequest(
        example.config,
        { name: 'Elyang' },
        slackGateJevSampleEvent(t)
      )
      expect(request.questions).toEqual(example.config.questions)
    }
  })
})
