// The tuning tool's report: each question's answers by label, misses and false wakes by threshold through
// the gate's own rules, a suggestion only from a complete run, and what was not run. Ids and numbers only.
import type {
  SlackGateRule,
  SlackGateRulesConfig
} from '../../src/shared/bots/slack-gate-rules-config'
import { validateSlackGateRules } from '../../src/shared/bots/slack-gate-rules-validate'
import type { SlackGateAnswer } from '../../src/main/bots/slack-gate/slack-gate-openai'
import { decideSlackGateRules } from '../../src/main/bots/slack-gate/slack-gate-rules'
import type { TuneCase } from './tune-cases'
import { usdOf, writeResultFile, type Spend } from './tune-ledger'

export type TuneResult = {
  id: string
  expect: 'wake' | 'block'
  answers?: Record<string, number>
  read?: Record<string, SlackGateAnswer>
  failure?: string
  inputTokens?: number
  latencyMs?: number
}

/** Each answer as a number: a probability or score, or a choice's position in its list (never its
 *  value, which is the config's own text). */
export function answerValues(
  config: SlackGateRulesConfig,
  answers: Record<string, SlackGateAnswer>
): Record<string, number> {
  return Object.fromEntries(
    config.questions.map((question) => {
      const answer = answers[question.name]!
      return [
        question.name,
        answer.type === 'choice' && question.type === 'choice'
          ? question.choices.findIndex((choice) => choice.value === answer.value)
          : Number(answer.value)
      ]
    })
  )
}

export type RunMeta = Record<string, string>

export function report(
  config: SlackGateRulesConfig,
  cases: TuneCase[],
  results: TuneResult[],
  spend: Spend,
  stopped: string | null,
  out: number | undefined,
  meta: RunMeta
): void {
  const answered = results.filter((result) => result.read)
  const failed = results.filter((result) => result.failure)
  const seen = new Set(results.map((result) => result.id))
  const unrunIds = cases.filter((entry) => !seen.has(entry.id)).map((entry) => entry.id)
  const unrun = unrunIds.length
  if (stopped) {
    console.log(`stopped: ${stopped}`)
  }
  console.log(
    `answered ${answered.length} of ${cases.length}; failed ${failed.length}; not run ${unrun}`
  )
  for (const result of failed) {
    console.log(`  failed ${result.id}: ${result.failure}`)
  }
  if (unrunIds.length > 0) {
    console.log(`  not run: ${unrunIds.join(', ')}`)
  }
  for (const question of config.questions) {
    console.log(
      `\n${question.name} (${question.type}${question.type === 'choice' ? ', by position in choices' : ''})`
    )
    for (const label of ['wake', 'block'] as const) {
      const shown = answered
        .filter((result) => result.expect === label)
        .map((result) => result.answers?.[question.name])
        .map((value) => (question.type === 'choice' ? `#${value}` : (value ?? 0).toFixed(3)))
        .sort()
      console.log(`  should ${label} (${shown.length}): ${shown.join(' ')}`)
    }
  }
  const evaluate = (candidate: SlackGateRulesConfig) => {
    const outcomes = answered.map((result) => ({
      result,
      wake: decideSlackGateRules(candidate, result.read ?? {}).wake
    }))
    return {
      misses: outcomes.filter((o) => o.result.expect === 'wake' && !o.wake).map((o) => o.result.id),
      falseWakes: outcomes
        .filter((o) => o.result.expect === 'block' && o.wake)
        .map((o) => o.result.id)
    }
  }
  const ruleIndex = config.rules.findIndex((entry) => entry.wakeIf)
  const rule = config.rules[ruleIndex]
  const question = rule && config.questions.find((entry) => entry.name === rule.question)
  const sole = rule && config.rules.filter((entry) => entry.question === rule.question).length === 1
  const complete =
    failed.length === 0 && unrun === 0 && !stopped && answered.length === cases.length
  const both =
    answered.some((result) => result.expect === 'wake') &&
    answered.some((result) => result.expect === 'block')
  let suggestion: { ruleIndex: number; rule: SlackGateRule } | null = null
  let thresholds: { atLeast: number; misses: number; falseWakes: number }[] | null = null
  if (!rule?.wakeIf || !('atLeast' in rule.wakeIf) || question?.type !== 'predicate' || !sole) {
    console.log(
      '\nno threshold table: it needs the first wakeIf rule to be the only rule on a predicate question, with atLeast'
    )
  } else {
    console.log(
      `\n${question.name}: each threshold run through the rules (that rule as { "atLeast": t }, no unsureFrom):`
    )
    console.log('  atLeast  misses  falseWakes')
    let best: { ruleIndex: number; rule: SlackGateRule } | null = null
    thresholds = []
    for (let step = 0; step <= 20; step++) {
      const atLeast = Number((step / 20).toFixed(2))
      const replacement: SlackGateRule = { question: rule.question, wakeIf: { atLeast } }
      const candidate = {
        ...config,
        rules: config.rules.map((entry, index) => (index === ruleIndex ? replacement : entry))
      }
      if (!validateSlackGateRules(candidate).ok) {
        continue
      }
      const counted = evaluate(candidate)
      thresholds.push({
        atLeast,
        misses: counted.misses.length,
        falseWakes: counted.falseWakes.length
      })
      console.log(
        `  ${atLeast.toFixed(2).padStart(7)}  ${String(counted.misses.length).padStart(6)}  ${String(counted.falseWakes.length).padStart(10)}`
      )
      if (counted.misses.length === 0) {
        best = { ruleIndex, rule: replacement }
      }
    }
    if (!complete || !both) {
      console.log(
        '  no suggestion: every case must be answered, with at least one to wake and one to block'
      )
    } else if (best) {
      suggestion = best
      console.log(
        `  suggested: rules[${best.ruleIndex}] = ${JSON.stringify(best.rule)} (the highest with no misses; replace the whole rule, so no unsureFrom stays behind). An unsureFrom with "whenUnsure": "wake" wakes from unsureFrom up, lowering this.`
      )
    }
  }
  const current = evaluate(config)
  console.log(
    `\nwith this config as it is: misses ${current.misses.length} [${current.misses.join(', ')}], false wakes ${current.falseWakes.length} [${current.falseWakes.join(', ')}]`
  )
  const latencies = answered.map((result) => result.latencyMs ?? 0).sort((a, b) => a - b)
  const percentile = (p: number) =>
    latencies.length
      ? latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))]
      : 0
  console.log(
    `latency p50 ${percentile(0.5)} ms, p95 ${percentile(0.95)} ms; input tokens ${spend.tokens} (cache reads ${spend.cached}, cache writes ${spend.writes}, held unknown ${spend.held}), about ${usdOf(spend).toFixed(6)} USD; output tokens are free`
  )
  if (out !== undefined) {
    // Ids, labels and numbers only: never the messages.
    writeResultFile(
      out,
      `${JSON.stringify(
        {
          meta,
          results: results.map(({ read: _read, ...rest }) => rest),
          suggestion,
          thresholds,
          current,
          inputTokens: spend.tokens,
          cachedTokens: spend.cached,
          cacheWriteTokens: spend.writes,
          heldTokens: spend.held,
          usd: usdOf(spend),
          stopped,
          unrunIds
        },
        null,
        2
      )}\n`
    )
  }
}
