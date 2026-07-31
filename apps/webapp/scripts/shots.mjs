import { chromium } from '@playwright/test'
const S = '/tmp/claude-1000/-home-icybear/7c74d31c-0e6b-4269-98c6-419583a360d0/scratchpad'
const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] })
// Desktop login
let ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } })
let page = await ctx.newPage()
await page.goto('https://localhost/login', { waitUntil: 'networkidle' })
await page.screenshot({ path: `${S}/login-desktop.png` })
await ctx.close()
// Mobile login + app
ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
page = await ctx.newPage()
await page.goto('https://localhost/login', { waitUntil: 'networkidle' })
await page.screenshot({ path: `${S}/login-mobile.png` })
await page.fill('input[name="username"], input[type="text"]', 'admin')
await page.fill('input[name="password"], input[type="password"]', 'hermes-web-test-pw')
await page.click('button[type="submit"], input[type="submit"]')
await page.waitForTimeout(12000)
await page.screenshot({ path: `${S}/app-mobile.png` })
await ctx.close()
await browser.close()
console.log('done')
