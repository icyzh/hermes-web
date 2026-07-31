import { chromium } from '@playwright/test'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const frames = []
page.on('websocket', ws => {
  const path = ws.url().split('?')[0]
  ws.on('framesent', f => frames.push(`>> ${path} ${String(f.payload).slice(0, 200)}`))
  ws.on('framereceived', f => frames.push(`<< ${path} ${String(f.payload).slice(0, 200)}`))
  ws.on('close', () => frames.push(`XX ${path} closed`))
})

await page.goto('http://127.0.0.1:9119/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(12000)

const skip = await page.evaluate(() => ({
  skipped: localStorage.getItem('hermes-onboarding-skipped-v1'),
  configured: localStorage.getItem('hermes-desktop-onboarded-v1')
}))
console.log('localStorage:', JSON.stringify(skip))
console.log('=== WS FRAMES:', frames.length)
for (const f of frames.slice(0, 60)) console.log(f)
await browser.close()
