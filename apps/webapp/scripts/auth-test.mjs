import { chromium } from '@playwright/test'

const BASE = process.argv[2] || 'http://127.0.0.1:9419'
const SHOTS = '/tmp/claude-1000/-home-icybear/7c74d31c-0e6b-4269-98c6-419583a360d0/scratchpad'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
const errors = []
page.on('pageerror', err => errors.push(String(err).slice(0, 250)))

const wsEvents = []
page.on('websocket', ws => wsEvents.push(`WS ${ws.url().replace(/(ticket|token)=[^&]+/, '$1=***')}`))

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
console.log('landed on:', page.url())
await page.screenshot({ path: `${SHOTS}/auth-1-login.png` })

// Fill the login form
await page.fill('input[name="username"], input[type="text"]', 'admin')
await page.fill('input[name="password"], input[type="password"]', 'hermes-web-test-pw')
await page.click('button[type="submit"], input[type="submit"]')
await page.waitForTimeout(9000)
console.log('after login:', page.url())
await page.screenshot({ path: `${SHOTS}/auth-2-app.png` })

const rootText = await page.evaluate(() => document.getElementById('root')?.innerText?.slice(0, 300) || '(no root)')
console.log('=== ROOT TEXT:', rootText.replace(/\n+/g, ' | ').slice(0, 300))
console.log('=== WEBSOCKETS:')
for (const w of wsEvents) console.log(' ', w)
console.log('=== ERRORS:', errors.length)
for (const e of errors) console.log(' ', e)
await browser.close()
