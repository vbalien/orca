// Runs Playwright steps on the isolated client's window. usage: node ui.cjs <cdp-port> <png> '<js body using page>'
const { chromium } = require(`${process.env.REPO}/node_modules/playwright-core`)
;(async () => {
  const [port, png, body] = process.argv.slice(2)
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 30000 })
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().includes('renderer/index.html'))
  await page.setViewportSize({ width: 1280, height: 800 })
  const out = await new Function('page', `return (async () => { ${body} })()`)(page)
  if (out !== undefined) {
    console.log(JSON.stringify(out))
  }
  for (let i = 0; i < 3; i++) {
    try {
      await page.screenshot({ path: png, timeout: 20000 })
      break
    } catch (e) {
      if (i === 2) {
        console.error('screenshot failed', e.message.slice(0, 80))
      }
    }
  }
  process.exit(0)
})().catch((e) => {
  console.error('ERR', e.message.slice(0, 600))
  process.exit(1)
})
