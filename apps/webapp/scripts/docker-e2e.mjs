import { chromium } from '@playwright/test'
const SHOTS = '/tmp/claude-1000/-home-icybear/7c74d31c-0e6b-4269-98c6-419583a360d0/scratchpad'
const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] })
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 } })
const page = await context.newPage()
const responses = []
page.on('response', r => { if (r.url().includes('/auth') || r.url().includes('/login')) responses.push(`${r.request().method()} ${r.url()} -> ${r.status()}`) })
page.on('console', m => { if (m.type() === 'error') responses.push('[console] ' + m.text().slice(0, 150)) })
await page.goto('https://localhost/login', { waitUntil: 'networkidle' })
await page.fill('input[name="username"], input[type="text"]', 'admin')
await page.fill('input[name="password"], input[type="password"]', 'hermes-web-test-pw')
await page.screenshot({ path: `${SHOTS}/docker-login.png` })
await Promise.all([
  page.waitForResponse(r => r.url().includes('password-login'), { timeout: 15000 }).catch(() => null),
  page.click('button[type="submit"], input[type="submit"], button')
])
await page.waitForTimeout(10000)
console.log('URL:', page.url())
console.log('RESPONSES:', JSON.stringify(responses, null, 1))
const text = await page.evaluate(() => document.body.innerText.slice(0, 300))
console.log('BODY:', text.replace(/\n+/g, ' | '))
await page.screenshot({ path: `${SHOTS}/docker-app.png` })
await browser.close()
