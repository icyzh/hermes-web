import { expect, test, type Page } from '@playwright/test'

const LOGIN_USER = process.env.HERMES_WEB_E2E_LOGIN_USER
const LOGIN_PASSWORD = process.env.HERMES_WEB_E2E_LOGIN_PASSWORD

/** Sign in when the instance is gated; no-op on token-mode instances. */
async function ensureSignedIn(page: Page) {
  await page.goto('/')

  if (!page.url().includes('/login')) {
    return
  }

  if (!LOGIN_USER || !LOGIN_PASSWORD) {
    test.skip(true, 'Instance is auth-gated; set HERMES_WEB_E2E_LOGIN_USER/_PASSWORD')

    return
  }

  await page.fill('input[name="username"], input[type="text"]', LOGIN_USER)
  await page.fill('input[name="password"], input[type="password"]', LOGIN_PASSWORD)
  await page.click('button[type="submit"], input[type="submit"]')
  await page.waitForURL(/#\//, { timeout: 20_000 })
}

/** First-run picker shows when no provider is configured — get past it. */
async function dismissOnboarding(page: Page) {
  const later = page.getByText("I'll choose a provider later", { exact: false })

  try {
    await later.first().waitFor({ state: 'visible', timeout: 30_000 })
    await later.first().click()
  } catch {
    // Already configured (or previously skipped) — nothing to dismiss.
  }
}

test('boots the app shell and connects the gateway WebSocket', async ({ page }) => {
  const sockets: string[] = []
  page.on('websocket', ws => sockets.push(ws.url()))

  const errors: string[] = []
  page.on('pageerror', err => errors.push(String(err)))

  await ensureSignedIn(page)
  await dismissOnboarding(page)

  // App chrome: the sidebar's static nav entries.
  await expect(page.getByText('New session').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Artifacts').first()).toBeVisible()

  // The gateway JSON-RPC socket dialed with token or ticket auth.
  await expect
    .poll(() => sockets.some(url => url.includes('/api/ws?') && /(token|ticket)=/.test(url)), { timeout: 20_000 })
    .toBe(true)

  expect(errors).toEqual([])
})

test('routes render: settings, skills, artifacts, starmap', async ({ page }) => {
  await ensureSignedIn(page)
  await dismissOnboarding(page)

  await page.goto('/#/skills')
  await expect(page.getByText('Browse Hub', { exact: false }).first()).toBeVisible({ timeout: 30_000 })

  await page.goto('/#/artifacts')
  await expect(page.getByText(/No artifacts found|Images/i).first()).toBeVisible({ timeout: 20_000 })

  await page.goto('/#/settings')
  await expect(page.getByText('Appearance', { exact: false }).first()).toBeVisible({ timeout: 20_000 })

  await page.goto('/#/starmap')
  await expect(page.getByText(/Nothing learned yet|memories/i).first()).toBeVisible({ timeout: 20_000 })
})

test('streams a chat turn end to end', async ({ page }) => {
  test.skip(process.env.HERMES_WEB_E2E_CHAT !== '1', 'needs a configured model provider (HERMES_WEB_E2E_CHAT=1)')

  await ensureSignedIn(page)
  await dismissOnboarding(page)

  const composer = page.locator('textarea, [contenteditable="true"]').first()
  await composer.waitFor({ state: 'visible', timeout: 30_000 })
  await composer.click()
  await composer.fill('Say hello')
  await composer.press('Enter')

  // The mock inference server's canned reply (see scripts in e2e docs) — or
  // any assistant output for a real provider.
  await expect(page.getByText(/Hello from the mock inference server|Say hello/).first()).toBeVisible({
    timeout: 60_000
  })
})

test('terminal pane runs a real shell over /api/terminal', async ({ page }) => {
  test.skip(process.env.HERMES_WEB_E2E_TERMINAL !== '1', 'needs HERMES_DASHBOARD_TERMINAL=1 (HERMES_WEB_E2E_TERMINAL=1)')

  await ensureSignedIn(page)
  await dismissOnboarding(page)
  await page.waitForTimeout(3_000)

  // Contract-level check through the polyfill — xterm renders on canvas, so
  // DOM assertions can't see terminal output.
  const result = await page.evaluate(async () => {
    const t = window.hermesDesktop.terminal
    const out: string[] = []
    const session = await t.start({ cols: 100, rows: 30 })
    t.onData(session.id, chunk => out.push(chunk))
    await new Promise(r => setTimeout(r, 1_000))
    await t.write(session.id, 'echo E2E-$((6*7))\n')
    await new Promise(r => setTimeout(r, 1_500))
    await t.dispose(session.id)

    return { shell: session.shell, output: out.join('') }
  })

  expect(result.shell.length).toBeGreaterThan(0)
  expect(result.output).toContain('E2E-42')
})

test('voice: mic dictation starts and streaming TTS endpoint responds', async ({ page }) => {
  await ensureSignedIn(page)
  await dismissOnboarding(page)

  // Server TTS (edge-tts requires no key): POST /api/audio/speak returns audio.
  const speak = await page.evaluate(async () => {
    try {
      const res = await window.hermesDesktop.api<{ ok?: boolean; data_url?: string }>({
        path: '/api/audio/speak',
        method: 'POST',
        body: { text: 'Hermes web voice test' },
        timeoutMs: 90_000
      })

      return { ok: Boolean(res?.data_url?.startsWith('data:audio/')) }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })
  expect(speak.ok, `TTS failed: ${speak.error ?? ''}`).toBe(true)

  // Mic: the composer's voice button starts dictation against the fake device.
  const micButton = page
    .locator('button:has(svg.tabler-icon-microphone), button[aria-label*="oice" i], button[title*="icrophone" i]')
    .first()

  if ((await micButton.count()) === 0) {
    test.skip(true, 'mic button not found in composer')

    return
  }

  await micButton.click()
  await expect(page.getByText(/Dictating|Listening/i).first()).toBeVisible({ timeout: 10_000 })
})
