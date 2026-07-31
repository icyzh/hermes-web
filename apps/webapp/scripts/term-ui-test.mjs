import { chromium } from '@playwright/test'

const BASE = process.argv[2] || 'http://127.0.0.1:9319'
const SHOTS = '/tmp/claude-1000/-home-icybear/7c74d31c-0e6b-4269-98c6-419583a360d0/scratchpad'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
const errors = []
page.on('pageerror', err => errors.push(String(err).slice(0, 250)))

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(8000)

// Toggle the terminal pane (Ctrl+`)
await page.keyboard.press('Control+`')
await page.waitForTimeout(5000)
await page.screenshot({ path: `${SHOTS}/term-ui-1.png` })

// Type into the terminal via keyboard (xterm captures focus on open)
await page.keyboard.type('echo UI-TERMINAL-WORKS && uname -a')
await page.keyboard.press('Enter')
await page.waitForTimeout(2500)
await page.screenshot({ path: `${SHOTS}/term-ui-2.png` })

const text = await page.evaluate(() => document.body.innerText.slice(0, 400))
console.log('has UI-TERMINAL-WORKS output:', /UI-TERMINAL-WORKS/.test(await page.evaluate(() => document.body.innerText)))
console.log('=== ERRORS:', errors.length)
for (const e of errors) console.log(' ', e)
await browser.close()
