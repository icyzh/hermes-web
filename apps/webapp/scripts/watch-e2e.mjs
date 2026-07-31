import { chromium } from '@playwright/test'

const BASE = process.argv[2] || 'http://127.0.0.1:9319'
const S = '/tmp/claude-1000/-home-icybear/7c74d31c-0e6b-4269-98c6-419583a360d0/scratchpad'

// Token-mode dev server: pull the session token from the SPA index.
const indexHtml = await (await fetch(`${BASE}/`)).text()
const token = (indexHtml.match(/__HERMES_SESSION_TOKEN__="([^"]+)"/) || [])[1] || ''

const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] })
const ctx = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 454, height: 454 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2
})
const page = await ctx.newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 200)))

await page.goto(`${BASE}/watch.html${token ? `?token=${token}` : ''}`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)
await page.screenshot({ path: `${S}/watch-1-ready.png` })

await page.fill('#input', 'Say hello')
await page.click('#send')
try {
  await page.getByText('Hello from the mock inference server', { exact: false }).waitFor({ timeout: 60000 })
  console.log('WATCH REPLY STREAMED ✓')
} catch {
  console.log('!! no reply within 60s')
}
await page.waitForTimeout(800)
await page.screenshot({ path: `${S}/watch-2-reply.png` })
console.log('ERRORS:', errors.length, errors.join(' | '))
await ctx.close()
await browser.close()
