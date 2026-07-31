import { chromium } from '@playwright/test'

const SHOTS = '/tmp/claude-1000/-home-icybear/7c74d31c-0e6b-4269-98c6-419583a360d0/scratchpad'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', err => errors.push(String(err).slice(0, 300)))
page.on('console', msg => {
  if (msg.type() === 'error') errors.push('[console] ' + msg.text().slice(0, 250))
})

await page.goto('http://127.0.0.1:9119/', { waitUntil: 'domcontentloaded' })

// Dismiss provider onboarding once the runtime check resolves and the picker
// renders (the check probes providers server-side and can take ~15s).
const later = page.getByText("I'll choose a provider later", { exact: false })
try {
  await later.first().waitFor({ state: 'visible', timeout: 30000 })
  await later.first().click()
  await page.waitForTimeout(2500)
} catch {
  console.log('(no onboarding picker appeared — continuing)')
}

await page.screenshot({ path: `${SHOTS}/tour-main.png` })

const views = ['settings', 'command-center', 'skills', 'artifacts', 'cron', 'starmap', 'agents', 'messaging']
for (const view of views) {
  await page.goto(`http://127.0.0.1:9119/#/${view}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3500)
  await page.screenshot({ path: `${SHOTS}/tour-${view}.png` })
}

console.log('=== ERRORS:', errors.length)
for (const e of errors.slice(0, 20)) console.log(' ', e)
await browser.close()
