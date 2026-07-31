import { chromium } from '@playwright/test'

const url = process.argv[2] || 'http://127.0.0.1:9119/'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', err => console.log('[pageerror]', String(err).slice(0, 300)))

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForTimeout(9000)

const info = await page.evaluate(() => {
  const sized = []
  const walk = el => {
    const r = el.getBoundingClientRect()
    if (r.width > 100 && r.width < 700 && r.height > 100) {
      const cls = (el.className && typeof el.className === 'string') ? el.className.slice(0, 120) : ''
      sized.push(`${el.tagName}.${cls} — ${Math.round(r.width)}x${Math.round(r.height)} @${Math.round(r.left)},${Math.round(r.top)}`)
    }
    for (const child of el.children) walk(child)
  }
  walk(document.body)
  const root = document.getElementById('root')
  const rootRect = root.getBoundingClientRect()
  return {
    rootSize: `${Math.round(rootRect.width)}x${Math.round(rootRect.height)}`,
    htmlClass: document.documentElement.className,
    bodyClass: document.body.className,
    firstLevels: Array.from(root.children).map(c => {
      const r = c.getBoundingClientRect()
      return `${c.tagName}.${String(c.className).slice(0, 100)} ${Math.round(r.width)}x${Math.round(r.height)}`
    }),
    sized: sized.slice(0, 20)
  }
})
console.log(JSON.stringify(info, null, 1))
await browser.close()
