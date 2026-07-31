import { chromium } from '@playwright/test'

const BASE = process.argv[2] || 'http://127.0.0.1:9319'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(6000)

const result = await page.evaluate(async () => {
  const t = window.hermesDesktop.terminal
  const out = []
  try {
    const session = await t.start({ cols: 100, rows: 30 })
    t.onData(session.id, chunk => out.push(chunk))
    await new Promise(r => setTimeout(r, 1200))
    await t.write(session.id, 'echo WEB-TERMINAL-$((21*2))\n')
    await new Promise(r => setTimeout(r, 1500))
    await t.resize(session.id, { cols: 120, rows: 40 })
    await t.write(session.id, 'stty size\n')
    await new Promise(r => setTimeout(r, 1200))
    const cwd = await t.cwd(session.id)
    await t.dispose(session.id)
    return { ok: true, session, cwd, output: out.join('').slice(-1500) }
  } catch (err) {
    return { ok: false, error: String(err), output: out.join('') }
  }
})

console.log(JSON.stringify({ ok: result.ok, session: result.session, cwd: result.cwd, error: result.error }, null, 1))
console.log('=== OUTPUT TAIL ===')
console.log(result.output)
await browser.close()
