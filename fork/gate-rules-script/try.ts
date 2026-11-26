// Runs a gate rules script the way Orca does, on an event from a file, and shows what Orca would do: the
// script's output as checked, and for {"ask": …} the OpenAI Decisions request it would send (nothing is
// sent; no key is read). For trying a script from a terminal before setting it on a gate. Like the gate,
// it runs the command in a temporary folder: give the script's full path.
//   node --import tsx fork/gate-rules-script/try.ts --script "node $PWD/fork/gate-rules-script/channel-rules.mjs" \
//     --event fork/gate-rules-script/events/channel-question.json [--bot-name mybot] [--wakes wakes.json]
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import type { SlackGateEvent } from '../../src/shared/bots/bot-slack-gate'
import { slackGateOpenAIRequest } from '../../src/shared/bots/slack-gate-openai-request'
import { formatSlackGateRulesText } from '../../src/shared/bots/slack-gate-rules-text'
import { rulesScriptStdin } from '../../src/main/bots/slack-gate/slack-gate'
import { runSlackGateCommand } from '../../src/main/bots/slack-gate/slack-gate-command'
import {
  readRulesScriptOutput,
  SLACK_GATE_SCRIPT_MAX_OUTPUT_BYTES
} from '../../src/main/bots/slack-gate/slack-gate-rules-script'

const { values } = parseArgs({
  options: {
    script: { type: 'string' },
    event: { type: 'string' },
    'bot-name': { type: 'string', default: 'mybot' },
    wakes: { type: 'string' },
    'timeout-seconds': { type: 'string', default: '10' }
  }
})

async function main(): Promise<void> {
  if (!values.script || !values.event) {
    console.error(
      'usage: try.ts --script "<command>" --event <event.json> [--bot-name n] [--wakes f]'
    )
    process.exitCode = 2
    return
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a person's own test file; the script reads it as data.
  const event = JSON.parse(readFileSync(values.event, 'utf8')) as SlackGateEvent
  const wakes: Record<string, unknown> = values.wakes
    ? JSON.parse(readFileSync(values.wakes, 'utf8'))
    : {}
  const run = runSlackGateCommand({
    command: values.script,
    stdin: rulesScriptStdin({ id: 'try', name: values['bot-name'] }, event, wakes),
    key: null,
    timeoutMs: Number(values['timeout-seconds']) * 1000,
    signal: new AbortController().signal,
    stdoutLimit: SLACK_GATE_SCRIPT_MAX_OUTPUT_BYTES
  })
  const outcome = await run.outcome
  await run.released
  if (outcome.kind !== 'exit') {
    console.log(`failed check: ${outcome.kind}${'error' in outcome ? ` (${outcome.error})` : ''}`)
    return
  }
  if (outcome.code !== 0 || outcome.stdoutTooLarge) {
    console.log(
      outcome.stdoutTooLarge
        ? 'failed check: the script printed too much'
        : `failed check: exited with ${outcome.code}`
    )
    return
  }
  const answer = readRulesScriptOutput(outcome.stdout ?? '')
  switch (answer.kind) {
    case 'error':
      console.log(`failed check: ${answer.error}`)
      return
    case 'useSaved':
      console.log('uses the rules saved in the gate')
      return
    case 'verdict':
      console.log(
        `${answer.wake ? 'wakes' : 'does not wake'}${answer.reason ? ` (reason: ${answer.reason})` : ''}`
      )
      return
    case 'ask': {
      const request = slackGateOpenAIRequest(answer.config, { name: values['bot-name'] }, event)
      console.log('asks OpenAI; the request Orca would send:')
      console.log(
        request ? formatSlackGateRulesText(request) : '(too large to send: a failed check)'
      )
    }
  }
}

void main()
