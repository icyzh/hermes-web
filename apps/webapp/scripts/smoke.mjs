import { chromium } from '@playwright/test'

const url = process.argv[2] || 'http://127.0.0.1:9119/'
const shot = process.argv[3] || '/tmp/claude-1000/-home-icybear/7c74d31c-0e6b-4269-98c6-419583a360d0/scratchpad/smoke.png'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const consoleLines = []
page.on('console', msg => {
  const type = msg.type()
  if (type === 'error' || type === 'warning') {
    consoleLines.push(`[${type}] ${msg.text().slice(0, 300)}`)
  }
})
page.on('pageerror', err => consoleLines.push(`[pageerror] ${String(err).slice(0, 400)}`))

const failedRequests = []
page.on('requestfailed', req => failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText}`))

const wsEvents = []
page.on('websocket', ws => {
  wsEvents.push(`WS OPEN ${ws.url().replace(/(token|ticket)=[^&]+/, '$1=***')}`)
  ws.on('close', () => wsEvents.push(`WS CLOSE ${ws.url().split('?')[0]}`))
})

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForTimeout(9000)

await page.screenshot({ path: shot, fullPage: false })

const rootText = await page.evaluate(() => document.getElementById('root')?.innerText?.slice(0, 800) || '(empty root)')
const title = await page.title()

console.log('=== TITLE:', title)
console.log('=== ROOT TEXT (first 800 chars):')
console.log(rootText)
console.log('=== WEBSOCKETS:')
for (const line of wsEvents) console.log(' ', line)
console.log('=== FAILED REQUESTS:', failedRequests.length)
for (const line of failedRequests.slice(0, 10)) console.log(' ', line)
console.log('=== CONSOLE ERRORS/WARNINGS:', consoleLines.length)
for (const line of consoleLines.slice(0, 25)) console.log(' ', line)

await browser.close()
