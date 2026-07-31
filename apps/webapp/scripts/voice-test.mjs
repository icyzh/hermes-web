import { chromium } from '@playwright/test'

const BASE = process.argv[2] || 'http://127.0.0.1:9319'
const SHOTS = '/tmp/claude-1000/-home-icybear/7c74d31c-0e6b-4269-98c6-419583a360d0/scratchpad'

const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required']
})
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, permissions: ['microphone'] })
const page = await context.newPage()
const errors = []
page.on('pageerror', err => errors.push(String(err).slice(0, 250)))

const requests = []
page.on('request', req => {
  if (req.url().includes('/api/audio/')) requests.push(`${req.method()} ${req.url().split('?')[0]}`)
})
page.on('response', async res => {
  if (res.url().includes('/api/audio/')) requests.push(`  -> ${res.status()} ${res.url().split('?')[0]}`)
})

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(7000)

// 1. speak-stream: drive the streaming TTS WebSocket exactly like
//    voice-playback.ts does (send {text} deltas then {done:true}; expect a
//    JSON 'start' frame then binary PCM frames).
const streamResult = await page.evaluate(async () => {
  const conn = await window.hermesDesktop.getConnection()
  const url = new URL(conn.wsUrl)
  url.pathname = '/api/audio/speak-stream'
  return new Promise(resolve => {
    const ws = new WebSocket(url.toString())
    ws.binaryType = 'arraybuffer'
    let started = false
    let pcmBytes = 0
    let sampleRate = 0
    const timer = setTimeout(() => {
      ws.close()
      resolve({ started, pcmBytes, sampleRate, timeout: true })
    }, 30000)
    ws.onopen = () => {
      ws.send(JSON.stringify({ text: 'Hello from the Hermes web voice streaming test. ' }))
      ws.send(JSON.stringify({ text: 'This audio was synthesized sentence by sentence.' }))
      ws.send(JSON.stringify({ done: true }))
    }
    ws.onmessage = ev => {
      if (typeof ev.data === 'string') {
        try {
          const frame = JSON.parse(ev.data)
          if (frame.type === 'start') {
            started = true
            sampleRate = frame.sample_rate
          }
          if (frame.type === 'end') {
            clearTimeout(timer)
            ws.close()
            resolve({ started, pcmBytes, sampleRate })
          }
        } catch { /* ignore */ }
      } else {
        pcmBytes += ev.data.byteLength
      }
    }
    ws.onerror = () => {
      clearTimeout(timer)
      resolve({ started, pcmBytes, sampleRate, error: true })
    }
    ws.onclose = () => {
      clearTimeout(timer)
      resolve({ started, pcmBytes, sampleRate })
    }
  })
})
console.log('SPEAK-STREAM:', JSON.stringify(streamResult))

// 2. Mic capture: click the composer mic button, record ~3s of the fake
//    device's tone, stop — the app should POST /api/audio/transcribe.
const micButton = page.locator('button:has(svg.tabler-icon-microphone), button[aria-label*="oice" i], button[title*="oice" i], button[aria-label*="icrophone" i]').first()
const micCount = await micButton.count()
console.log('mic button found:', micCount > 0)
if (micCount) {
  await micButton.click()
  await page.waitForTimeout(3000)
  await page.screenshot({ path: `${SHOTS}/voice-recording.png` })
  // Stop: click again (or the stop affordance replacing it)
  await micButton.click().catch(() => {})
  await page.waitForTimeout(4000)
  await page.screenshot({ path: `${SHOTS}/voice-after.png` })
}

console.log('=== /api/audio requests ===')
for (const r of requests) console.log(' ', r)
console.log('=== ERRORS:', errors.length)
for (const e of errors) console.log(' ', e)
await browser.close()
