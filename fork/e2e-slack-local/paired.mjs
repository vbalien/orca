// Calls the isolated server over a real E2EE pairing as a person (no agent claim) or as the CLI.
// usage: paired.mjs <client data dir> <pairing url> <who: person|agent> <method> <json params>
const out = `${process.env.DIST}/resources/app.asar.unpacked/out`
const [clientData, pairing, who, method, params] = process.argv.slice(2)
const { resolveRemoteConnection } = await import(
  `${out}/cli/runtime/pairing/runtime-remote-pairing.js`
)
const { sendRemoteRuntimeRequestOnSocket } = await import(
  `${out}/shared/remote-runtime/requests/remote-runtime-request-socket.js`
)
const { CLI_CLIENT_CAPABILITIES } = await import(
  `${out}/cli/runtime/connection/websocket-transport.js`
)
const connection = pairing.startsWith('orca://')
  ? await resolveRemoteConnection(clientData, pairing, null)
  : await resolveRemoteConnection(clientData, null, pairing)
let r
try {
  r = await sendRemoteRuntimeRequestOnSocket(
    connection,
    method,
    JSON.parse(params),
    60000,
    undefined,
    undefined,
    undefined,
    who === 'agent' ? CLI_CLIENT_CAPABILITIES : []
  )
} catch (e) {
  r = { ok: false, thrown: true, code: e?.code, message: e?.message }
}
console.log(
  JSON.stringify(
    r.ok
      ? { ok: true, result: r.result }
      : { ok: false, code: r.error?.code ?? r.code, message: r.error?.message ?? r.message }
  )
)
process.exit(0)
