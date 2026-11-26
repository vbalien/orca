#!/usr/bin/env bash
# Inside the namespace: sets the gate's "Rules from a script" the way its owner can, in Orca on the
# server's own computer: stops the server, opens its profile in a window, fills the field (channel
# messages on, channel C0CHAN01), saves, closes the window and starts the server again.
# usage: set-script.sh '<command>' <screenshot.png>
set -u; source "$(dirname "$0")/lib.sh"
CDP=$($E/server-desktop.sh | sed -n 's/^CDP //p')
REPO=$REPO node $E/ui.cjs $CDP "$2" "
await page.waitForTimeout(3000)
const later = page.getByText('Set up later'); if (await later.count()) await later.first().click()
await page.keyboard.press('Escape')
for (const name of ['Later', 'Set up later']) { const b = page.getByRole('button', { name, exact: true }); if (await b.count()) await b.first().click({ force: true }).catch(() => undefined) }
await page.getByText('chanbot').first().click(); await page.waitForTimeout(2500)
await page.getByText('Connectors', { exact: true }).first().click(); await page.waitForTimeout(2000)
await page.locator('button', { hasText: 'Fake team' }).first().click({ force: true }); await page.waitForTimeout(2500)
const ch = page.getByLabel('Channels to check')
if (!(await ch.count())) { await page.getByText('Channel messages (your own Slack app)').first().click(); await page.waitForTimeout(800) }
await page.getByLabel('Channels to check').fill('C0CHAN01')
const script = page.getByLabel(/Rules from a script/)
await script.scrollIntoViewIfNeeded(); await script.fill($(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$1"))
await page.waitForTimeout(800)
// First-run tips may sit over the page; the button only has to be enabled.
const save = page.getByRole('button', { name: 'Save', exact: true }).last()
if (!(await save.isEnabled())) return ['Save is disabled']
await save.evaluate((button) => button.click())
// Wait for this save's own answer, past any first-run toast.
await page.getByText('Gate saved.').first().waitFor({ timeout: 15000 }).catch(() => undefined)
await page.waitForTimeout(500)
const t = await page.locator('body').innerText(); const i = t.indexOf('Rules from a script')
return [await page.locator('[data-sonner-toast]').allInnerTexts(), t.slice(i, i + 260).replace(/\n+/g, ' | ')]"
n0=$(count $R/fake/calls.jsonl '"socket":"open"')
$E/server-desktop.sh --close; env PATH=$PATH $E/start-server.sh >/dev/null; socket_back $n0; sleep 3
