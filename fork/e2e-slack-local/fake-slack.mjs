// Fake Slack + fake OpenAI Decisions for the isolated own-app E2E, all on 127.0.0.1: Slack's Web API over
// HTTP, Socket Mode over WSS (throwaway CA), and POST /v1/decisions. Keeps each thread's messages so
// conversations.replies pages them (latest, cursor) like Slack. Logs every call to calls.jsonl and every
// Decisions request body to decisions.jsonl (run folder only).
// usage: node fake-slack.mjs <state dir> <api port> <wss port> <control port> <repo with node_modules>
// Decisions answers by a tag in the message, per question: [wake] 0.95 (joinable_banter 0.05), [banter]
// joinable_banter 0.95 (others 0.05), [chat] 0.05, [unsure] 0.4, [refuse] a refusal, [slow] after 15 s,
// [hold] once POST /release, [5xx] HTTP 503; anything else 0.95.
import { createServer } from 'node:http'
import { createServer as createHttps } from 'node:https'
import { appendFileSync, readFileSync } from 'node:fs'
const [dir, apiPort, wssPort, ctlPort, repo] = process.argv.slice(2)
const { WebSocketServer } = await import(`${repo}/node_modules/ws/wrapper.mjs`)
const held = []
const MESSAGE_MARK = 'e2emsgmark'
let postsMode = 'ok' // ok | 429 (the next post answers 429, Retry-After 3)
const log = (entry) =>
  appendFileSync(`${dir}/calls.jsonl`, `${JSON.stringify({ at: Date.now(), ...entry })}\n`)
const TEAM = 'T0TEST01',
  BOT_USER = 'U0BOT001',
  APP = 'A0APP001',
  BOT_ID = 'B0BOT001'
const threads = new Map() // channel:thread_ts -> [{ ts, user, bot_id?, text }]
const sockets = new Set()
let tick = 0
let repliesMode = 'ok' // ok | slow (answers after 5 s) | 429 (Retry-After 30)
const nextTs = () =>
  `${1800000000 + (Math.floor(Date.now() / 1000) % 100000)}.${String(++tick).padStart(6, '0')}`
const thread = (channel, ts) => {
  const key = `${channel}:${ts}`
  if (!threads.has(key)) {
    threads.set(key, [])
  }
  return threads.get(key)
}
const decide = (res, body) => {
  appendFileSync(`${dir}/decisions.jsonl`, `${body}\n`)
  const request = JSON.parse(body)
  const data = request.input?.[1]?.content?.[0]?.data ?? {}
  const text = String(data.message ?? '')
  const tag = /\[(wake|banter|chat|unsure|refuse|slow|hold|5xx)\]/.exec(text)?.[1] ?? 'wake'
  log({
    decisions: tag,
    auth: (res.req.headers.authorization ?? '').startsWith('Bearer ') ? 'bearer' : 'none'
  })
  if (tag === '5xx') {
    res.writeHead(503, { 'content-type': 'application/json' })
    return res.end('{"error":{"type":"server_error"}}')
  }
  const probabilityOf = (name) =>
    tag === 'banter'
      ? name === 'joinable_banter'
        ? 0.95
        : 0.05
      : tag === 'wake'
        ? name === 'joinable_banter'
          ? 0.05
          : 0.95
        : ({ chat: 0.05, unsure: 0.4 }[tag] ?? 0.95)
  const answer = (q) =>
    tag === 'refuse'
      ? { type: 'refusal', name: q.name }
      : { type: 'predicate', name: q.name, probability: probabilityOf(q.name) }
  const reply = () => {
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        model: request.model,
        answers: request.questions.map(answer),
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens: 0,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 100
        }
      })
    )
  }
  if (tag === 'slow') {
    setTimeout(reply, 15000)
  } else if (tag === 'hold') {
    held.push(reply)
  } else {
    reply()
  }
}
const api = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (req.url === '/v1/decisions') {
      return decide(res, body)
    }
    const method = req.url.replace(/^\/api\//, '')
    const params = Object.fromEntries(new URLSearchParams(body))
    const auth = req.headers.authorization ?? ''
    const kind = auth.startsWith('Bearer xoxb-')
      ? 'bot'
      : auth.startsWith('Bearer xapp-')
        ? 'app'
        : 'none'
    log({
      api: method,
      token: kind,
      params: method === 'chat.postMessage' ? params : Object.keys(params)
    })
    const send = (o) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(o))
    }
    switch (method) {
      case 'auth.test':
        return send({
          ok: true,
          team_id: TEAM,
          team: 'Fake team',
          user_id: BOT_USER,
          bot_id: BOT_ID
        })
      case 'bots.info':
        return send({ ok: true, bot: { id: BOT_ID, app_id: APP } })
      case 'apps.connections.open':
        return send({ ok: true, url: `wss://127.0.0.1:${wssPort}/link/?ticket=t${Date.now()}` })
      case 'users.info':
        return send({
          ok: true,
          user: {
            id: params.user,
            name: 'person',
            real_name: 'Person',
            profile: { display_name: params.user },
            team_id: TEAM
          }
        })
      case 'conversations.replies': {
        if (repliesMode === '429') {
          res.writeHead(429, { 'retry-after': '30', 'content-type': 'application/json' })
          return res.end('{"ok":false,"error":"ratelimited"}')
        }
        if (repliesMode === 'slow') {
          const later = { ...params }
          return setTimeout(
            () =>
              send({
                ok: true,
                messages: thread(later.channel, later.ts)
                  .filter((m) => Number(m.ts) < Number(later.latest ?? Infinity))
                  .slice(0, 200)
              }),
            5000
          )
        }
        const all = thread(params.channel, params.ts).filter(
          (m) =>
            !params.latest ||
            Number(m.ts) < Number(params.latest) ||
            (params.inclusive === 'true' && m.ts === params.latest)
        )
        const limit = Number(params.limit ?? 100)
        const start = Number(params.cursor || 0)
        const page = all.slice(start, start + limit)
        const more = start + limit < all.length
        return send({
          ok: true,
          messages: page,
          has_more: more,
          ...(more ? { response_metadata: { next_cursor: String(start + limit) } } : {})
        })
      }
      case 'chat.postMessage': {
        if (postsMode === '429') {
          postsMode = 'ok'
          res.writeHead(429, { 'retry-after': '3', 'content-type': 'application/json' })
          return res.end('{"ok":false,"error":"ratelimited"}')
        }
        const ts = nextTs()
        if (params.thread_ts) {
          thread(params.channel, params.thread_ts).push({
            ts,
            user: BOT_USER,
            bot_id: BOT_ID,
            text: params.text ?? ''
          })
        }
        return send({ ok: true, ts, channel: params.channel })
      }
      default:
        return send({ ok: false, error: 'unknown_method' })
    }
  })
})
api.listen(Number(apiPort), '127.0.0.1')
const tls = createHttps({
  key: readFileSync(`${dir}/../tls/server.key`),
  cert: readFileSync(`${dir}/../tls/server.crt`)
})
const wss = new WebSocketServer({ server: tls })
wss.on('connection', (socket) => {
  sockets.add(socket)
  log({ socket: 'open', live: sockets.size })
  socket.send(
    JSON.stringify({
      type: 'hello',
      num_connections: sockets.size,
      connection_info: { app_id: APP }
    })
  )
  socket.on('message', (data) => log({ socket: 'in', data: String(data).slice(0, 120) }))
  socket.on('close', () => {
    sockets.delete(socket)
    log({ socket: 'close', live: sockets.size })
  })
})
tls.listen(Number(wssPort), '127.0.0.1')
// Control: POST /event {user, text, mention?, thread_ts?, channel?} sends an event (app_mention, or a
// plain thread reply when mention is false) and records it in its thread; POST /seed {thread_ts,
// messages: [{user?, bot_id?, text}]} adds history; GET / tells the live sockets.
createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const input = body ? JSON.parse(body) : {}
    const channel = input.channel ?? 'C0CHAN01'
    if (req.url === '/event') {
      const ts = nextTs()
      const mention = input.mention !== false
      // Every message carries a mark, so the leak check finds any of them stored where no text belongs.
      const words = `${input.text} ${MESSAGE_MARK}`
      const text = mention ? `<@${BOT_USER}> ${words}` : words
      const event = mention
        ? {
            type: 'app_mention',
            user: input.user,
            text,
            channel,
            ts,
            ...(input.thread_ts ? { thread_ts: input.thread_ts } : {})
          }
        : {
            type: 'message',
            channel_type: 'channel',
            user: input.user,
            text,
            channel,
            ts,
            ...(input.thread_ts ? { thread_ts: input.thread_ts } : {})
          }
      thread(channel, input.thread_ts ?? ts).push({ ts, user: input.user, text })
      const envelope = {
        envelope_id: `env-${ts}`,
        type: 'events_api',
        accepts_response_payload: false,
        payload: {
          type: 'event_callback',
          team_id: TEAM,
          api_app_id: APP,
          event_id: `Ev${ts.replace('.', '')}`,
          event
        }
      }
      for (const s of sockets) {
        s.send(JSON.stringify(envelope))
      }
      log({ sent: 'event', ts, mention, live: sockets.size })
      res.end(JSON.stringify({ ts, live: sockets.size }))
    } else if (req.url === '/release') {
      const n = held.length
      held.splice(0).forEach((reply) => reply())
      res.end(JSON.stringify({ released: n }))
    } else if (req.url === '/posts-mode') {
      postsMode = input.mode
      res.end('{}')
    } else if (req.url === '/replies-mode') {
      repliesMode = input.mode
      res.end('{}')
    } else if (req.url === '/seed') {
      const list = thread(channel, input.thread_ts)
      for (const m of input.messages) {
        list.push({ ts: nextTs(), ...m })
      }
      res.end(JSON.stringify({ count: list.length }))
    } else {
      res.end(JSON.stringify({ live: sockets.size }))
    }
  })
}).listen(Number(ctlPort), '127.0.0.1')
log({ started: true })
