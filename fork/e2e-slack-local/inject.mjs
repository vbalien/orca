// Attaches to the isolated server's Electron main, paused by --inspect-brk before its first line, and
// installs the E2E redirect before any app code runs: Slack's Web API and OpenAI Decisions go to the local
// fake, any other slack.com / openai.com address is refused, and the throwaway CA is trusted for 127.0.0.1
// only. With --inspect-brk every worker thread also waits for a debugger, so this stays attached and
// lets each one run as it starts. Writes "hooked" to <ready file> once the main may go on.
// usage: node inject.mjs <inspector port> <fake api base> <ca.crt> <ready file>
import { readFileSync, writeFileSync } from 'node:fs'
const [port, api, caFile, readyFile] = process.argv.slice(2)
const ca = readFileSync(caFile, 'utf8')
let list
for (let i = 0; i < 300 && !list; i++) {
  try {
    list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  } catch {
    await new Promise((r) => setTimeout(r, 100))
  }
}
if (!list?.[0]) {
  console.error('inspector not reachable')
  process.exit(1)
}
const ws = new WebSocket(list[0].webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let id = 0
const pending = new Map()
let workers = 0
const send = (method, params = {}) =>
  new Promise((r) => {
    const n = ++id
    pending.set(n, r)
    ws.send(JSON.stringify({ id: n, method, params }))
  })
ws.addEventListener('message', (m) => {
  const d = JSON.parse(String(m.data))
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d)
    pending.delete(d.id)
    return
  }
  if (d.method === 'NodeWorker.attachedToWorker') {
    workers++
    ws.send(
      JSON.stringify({
        id: ++id,
        method: 'NodeWorker.sendMessageToWorker',
        params: {
          sessionId: d.params.sessionId,
          message: JSON.stringify({ id: 1, method: 'Runtime.runIfWaitingForDebugger' })
        }
      })
    )
    console.log(`worker released: ${d.params.workerInfo?.title ?? '?'} (${workers})`)
  }
})
ws.addEventListener('close', () => {
  console.log('inspector closed')
  process.exit(0)
})
const hook = `(() => {
  if (globalThis.__orcaE2EHook) return 'already'
  const api = ${JSON.stringify(api)}
  const realFetch = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (/^https:\\/\\/slack\\.com\\/api\\//.test(url)) return realFetch(url.replace('https://slack.com/api/', api + '/api/'), init)
    if (url === 'https://api.openai.com/v1/decisions') return realFetch(api + '/v1/decisions', init)
    if (/^[a-z]+:\\/\\/([^/]*\\.)?(slack\\.com|openai\\.com)(\\/|:|$)/i.test(url)) return Promise.reject(new Error('blocked by the E2E hook'))
    return realFetch(input, init)
  }
  const tls = process.getBuiltinModule('tls')
  const connect = tls.connect
  const ca = ${JSON.stringify(ca)}
  tls.connect = function (...args) {
    const options = args.find((a) => a && typeof a === 'object')
    if (options && (options.host === '127.0.0.1' || options.servername === '127.0.0.1')) options.ca = [...tls.rootCertificates, ca]
    return connect.apply(this, args)
  }
  globalThis.__orcaE2EHook = { at: Date.now() }
  return 'hooked'
})()`
await send('Runtime.enable')
await send('NodeWorker.enable', { waitForDebuggerOnStart: true })
const result = await send('Runtime.evaluate', { expression: hook, returnByValue: true })
const value = result.result?.result?.value
console.log('inject:', JSON.stringify(value ?? result))
if (value !== 'hooked' && value !== 'already') {
  process.exit(1)
}
await send('Runtime.runIfWaitingForDebugger')
writeFileSync(readyFile, 'hooked\n')
