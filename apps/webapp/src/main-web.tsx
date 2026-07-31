// Hermes Web entry point.
//
// Installs the browser polyfill for the `window.hermesDesktop` bridge BEFORE
// any desktop renderer module loads — the renderer's side-effect imports
// (store/active-work, store/power, store/translucency, …) touch the bridge at
// module scope, so the app tree is pulled in with a dynamic import that only
// starts evaluating after the polyfill is in place.

import { installHermesDesktopPolyfill, webBasePath } from './polyfill/hermes-desktop'

async function ensureAuthenticated(): Promise<boolean> {
  if (window.__HERMES_AUTH_REQUIRED__ !== true) {
    return true
  }

  const base = webBasePath()

  try {
    const res = await fetch(`${base}/api/auth/me`, { credentials: 'same-origin' })

    if (res.status === 401 || res.status === 403) {
      const next = encodeURIComponent(window.location.pathname + window.location.search + window.location.hash)
      window.location.href = `${base}/login?next=${next}`

      return false
    }
  } catch {
    // Backend unreachable — let the app render its own connection error UI
    // instead of bouncing through a login redirect loop.
  }

  return true
}

async function boot() {
  installHermesDesktopPolyfill()

  if (!(await ensureAuthenticated())) {
    return
  }

  // The desktop entry module renders the full app tree (chat, settings,
  // command center, …) against window.hermesDesktop — which is now our
  // browser polyfill speaking same-origin fetch + WebSockets.
  await import('@/main')
}

void boot()
