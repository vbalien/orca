// A fake Anthropic Messages API for the bot's claude agent in the isolated E2E (127.0.0.1 only). It answers
// every turn from the last user message: "[quiet]" → NO_REPLY (unless "[speak]" too), "[fail]" → HTTP 400 (not retried), otherwise a short
// answer naming the first [tag] it sees. Each request's text goes to anthropic.jsonl in the run folder
// (to check what the bot was told), never anywhere else.
// usage: node fake-anthropic.mjs <state dir> <port>
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
const [dir, port] = process.argv.slice(2)
const textOf = (content) =>
  typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('\n')
createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (req.url === '/health') {
      return res.end('ok')
    }
    if (!req.url.startsWith('/v1/messages')) {
      res.setHeader('content-type', 'application/json')
      return res.end('{}')
    }
    let request = {}
    try {
      request = JSON.parse(body)
    } catch {}
    if (req.url.startsWith('/v1/messages/count_tokens')) {
      res.setHeader('content-type', 'application/json')
      return res.end('{"input_tokens":10}')
    }
    const users = (request.messages ?? []).filter((m) => m.role === 'user')
    const last = textOf(users.at(-1)?.content)
    const all = (request.messages ?? []).map((m) => textOf(m.content)).join('\n')
    appendFileSync(
      `${dir}/anthropic.jsonl`,
      `${JSON.stringify({
        at: Date.now(),
        last: last.slice(-6000),
        // The whole conversation's text, to tell a continued chat from a new one.
        all: all.slice(-20000),
        stream: Boolean(request.stream)
      })}\n`
    )
    if (/\[fail\]/.test(last)) {
      // A request error the client doesn't retry: the turn fails at once.
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(
        '{"type":"error","error":{"type":"invalid_request_error","message":"e2e failure"}}'
      )
    }
    const tag = /\[([a-z0-9-]+)\]/.exec(last)?.[1] ?? 'none'
    // [speak] wins over a [quiet] that only came along in the thread's earlier messages.
    const text =
      /\[quiet\]/.test(last) && !/\[speak\]/.test(last) ? 'NO_REPLY' : `E2E answer (${tag}).`
    const usage = {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    }
    const message = {
      id: `msg_e2e_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: request.model ?? 'claude',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage
    }
    if (!request.stream) {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify(message))
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    send('message_start', {
      type: 'message_start',
      message: { ...message, content: [], stop_reason: null }
    })
    send('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' }
    })
    send('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text }
    })
    send('content_block_stop', { type: 'content_block_stop', index: 0 })
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 }
    })
    send('message_stop', { type: 'message_stop' })
    res.end()
  })
}).listen(Number(port), '127.0.0.1')
