import { chromium } from '@playwright/test'

const BASE = process.argv[2] || 'http://127.0.0.1:9219'
const SHOTS = '/tmp/claude-1000/-home-icybear/7c74d31c-0e6b-4269-98c6-419583a360d0/scratchpad'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', err => errors.push(String(err).slice(0, 300)))

await page.goto(BASE, { waitUntil: 'domcontentloaded' })

// Wait out boot; dismiss onboarding if it appears (provider IS configured, so
// it should auto-complete, but guard both paths).
try {
  const later = page.getByText("I'll choose a provider later", { exact: false })
  await later.first().waitFor({ state: 'visible', timeout: 20000 })
  await later.first().click()
} catch {
  // no picker — configured
}

// The composer: a textbox with the "What are we building?" placeholder family.
const composer = page.locator('textarea, [contenteditable="true"]').first()
await composer.waitFor({ state: 'visible', timeout: 30000 })
await page.waitForTimeout(1500)
await composer.click()
await composer.fill('Say hello')
await page.screenshot({ path: `${SHOTS}/chat-1-typed.png` })
await composer.press('Enter')

// Wait for the streamed mock reply to land in the transcript.
try {
  await page.getByText('Hello from the mock inference server', { exact: false }).first().waitFor({ timeout: 60000 })
  console.log('STREAMED REPLY RENDERED ✓')
} catch {
  console.log('!! reply did not render within 60s')
}

await page.waitForTimeout(1500)
await page.screenshot({ path: `${SHOTS}/chat-2-reply.png` })

const transcript = await page.evaluate(() => document.getElementById('root')?.innerText?.slice(0, 1200) || '')
console.log('=== PAGE TEXT ===')
console.log(transcript)
console.log('=== ERRORS:', errors.length)
for (const e of errors.slice(0, 10)) console.log(' ', e)
await browser.close()
