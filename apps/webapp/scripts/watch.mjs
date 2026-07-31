import { chromium } from '@playwright/test'
const S = '/tmp/claude-1000/-home-icybear/7c74d31c-0e6b-4269-98c6-419583a360d0/scratchpad'
const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] })
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 454, height: 454 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto('https://localhost/login', { waitUntil: 'networkidle' })
await page.fill('input[name="username"], input[type="text"]', 'admin')
await page.fill('input[name="password"], input[type="password"]', 'hermes-web-test-pw')
await page.click('button[type="submit"]')
await page.waitForTimeout(12000)
await page.screenshot({ path: `${S}/watch-app.png` })
await ctx.close(); await browser.close()
console.log('done')
