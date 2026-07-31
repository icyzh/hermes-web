import { defineConfig } from '@playwright/test'

/**
 * E2E against a live Hermes backend serving the built webapp dist.
 *
 * Point HERMES_WEB_URL at a running instance:
 *
 *   HERMES_WEB_DIST=$PWD/dist hermes dashboard --port 9119 --no-open --skip-build
 *   HERMES_WEB_URL=http://127.0.0.1:9119 npx playwright test
 *
 * Optional flags for deeper suites:
 *   HERMES_WEB_E2E_CHAT=1      — a mock/real model provider is configured;
 *                                run the streaming-chat spec.
 *   HERMES_WEB_E2E_TERMINAL=1  — HERMES_DASHBOARD_TERMINAL=1 on the server;
 *                                run the terminal spec.
 *   HERMES_WEB_E2E_LOGIN_USER / _PASSWORD — the instance is auth-gated;
 *                                run the login spec (and use these to sign in).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  retries: 0,
  use: {
    baseURL: process.env.HERMES_WEB_URL || 'http://127.0.0.1:9119',
    viewport: { width: 1600, height: 900 },
    // Fake mic for the voice spec; harmless elsewhere.
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
    },
    permissions: ['microphone']
  }
})
