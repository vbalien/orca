// Writes the gates the channel E2E saves, from the repo's own defaults and examples, to <out dir>.
// usage: node --import tsx gates.mts <repo> <out dir> <rules script command>
import { mkdirSync, writeFileSync } from 'node:fs'
const [repo, out, script] = process.argv.slice(2)
const d = await import(`${repo}/src/shared/bots/slack-gate-default-rules.ts`)
const { validateSlackGateRules } = await import(
  `${repo}/src/shared/bots/slack-gate-rules-validate.ts`
)
const banter = d.SLACK_GATE_RULES_EXAMPLES.find((e: { id: string }) => e.id === 'banter').config
const base = {
  on: true,
  kind: 'openai',
  appliesTo: ['thread_reply'],
  channelMessages: { channels: ['C0CHAN01'] },
  timeoutSeconds: 10,
  onError: 'wake'
}
const only = (name: string, limit: object) => ({
  ...banter,
  questions: banter.questions.filter((q: { name: string }) => q.name === name),
  rules: banter.rules
    .filter((r: { question: string }) => r.question === name)
    .map((r: object) => ({ ...r, limit }))
})
const gates: Record<string, { openai: unknown }> = {
  channel: { ...base, openai: d.SLACK_GATE_CHANNEL_DEFAULT_RULES },
  day: {
    ...base,
    openai: {
      ...banter,
      rules: banter.rules.map((r: { limit?: object }) =>
        r.limit ? { ...r, limit: { perDay: 1 } } : r
      )
    }
  },
  cooldown: { ...base, openai: only('joinable_banter', { cooldownMinutes: 60 }) },
  script: { ...base, openai: d.SLACK_GATE_CHANNEL_DEFAULT_RULES, rulesCommand: script }
}
mkdirSync(out, { recursive: true })
for (const [name, gate] of Object.entries(gates)) {
  const check = validateSlackGateRules(gate.openai)
  if (!check.ok) {
    throw new Error(`${name}: ${JSON.stringify(check.issues)}`)
  }
  writeFileSync(`${out}/${name}.json`, JSON.stringify(gate))
}
console.log(Object.keys(gates).join(' '))
