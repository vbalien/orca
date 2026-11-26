// Fork-only: a loopback stand-in for POST /v1/decisions, to try tune.ts (and the gate) without OpenAI.
// Deterministic: a message that asks something of the bot scores high, anything else low; each predicate
// question gets that probability, the first choice and the middle level for the others.
//   node fork/gate-tune/fake-decisions.mjs [port] [mode]   (prints the address; Ctrl-C stops it)
// mode: ok (default), refuse (every answer a refusal), redirect (307 to an outside address), broken-json,
// no-usage, drop (closes mid-answer), slow (answers after 35 s), 429 (always rate limited).
import { createServer } from 'node:http'

const ASKS =
  /\b(bot|please|can you|could you|check|look|deploy|review|roll back)\b|@|\?|봇|해 ?줘|해주세요|부탁|확인|봐 ?줘/i

function answer(question, data) {
  const text = [
    data.message,
    ...(Array.isArray(data.laterMessages) ? data.laterMessages : [])
  ].join(' ')
  const probability = ASKS.test(String(text)) ? 0.86 : 0.12
  switch (question.type) {
    case 'predicate':
      return { type: 'predicate', name: question.name ?? null, probability }
    case 'choice':
      return {
        type: 'choice',
        name: question.name ?? null,
        choice: question.choices[0].value,
        confidence: 0.7,
        probabilities: question.choices.map((choice, index) => ({
          value: choice.value,
          probability: index === 0 ? 0.7 : 0.3 / (question.choices.length - 1)
        }))
      }
    default: {
      const middle = Math.floor((question.levels.length - 1) / 2)
      return {
        type: 'score',
        name: question.name ?? null,
        score: middle,
        confidence: 0.6,
        probabilities: question.levels.map((level, index) => ({
          label: level.label,
          value: index,
          probability: index === middle ? 1 : 0
        }))
      }
    }
  }
}

const MODE = process.argv[3] ?? 'ok'

const server = createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => (body += chunk))
  request.on('end', () => {
    if (request.method !== 'POST' || request.url !== '/v1/decisions') {
      response.writeHead(404).end()
      return
    }
    if (MODE === 'redirect') {
      response.writeHead(307, { location: 'https://example.com/v1/decisions' }).end()
      return
    }
    if (MODE === '429') {
      response
        .writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' })
        .end('{"error":{}}')
      return
    }
    if (MODE === 'broken-json') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"answers": [')
      return
    }
    if (MODE === 'drop') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"answers": [')
      response.socket?.destroy()
      return
    }
    try {
      const parsed = JSON.parse(body)
      const data = parsed.input?.[1]?.content?.[0]?.data ?? {}
      const tokens = Math.ceil(Buffer.byteLength(body) / 4)
      const reply = JSON.stringify({
        model: parsed.model,
        answers: parsed.questions.map((question) =>
          MODE === 'refuse'
            ? { type: 'refusal', name: question.name ?? null }
            : answer(question, data)
        ),
        ...(MODE === 'no-usage'
          ? {}
          : {
              usage: {
                input_tokens: tokens,
                input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
                output_tokens: 0,
                output_tokens_details: { reasoning_tokens: 0 },
                total_tokens: tokens
              }
            })
      })
      const send = () => response.writeHead(200, { 'content-type': 'application/json' }).end(reply)
      if (MODE === 'slow') {
        setTimeout(send, 35_000)
      } else {
        send()
      }
    } catch {
      response
        .writeHead(400, { 'content-type': 'application/json' })
        .end('{"error":{"type":"invalid_request_error"}}')
    }
  })
})

server.listen(Number(process.argv[2] ?? 0), '127.0.0.1', () => {
  console.log(`fake decisions at http://127.0.0.1:${server.address().port}`)
})
