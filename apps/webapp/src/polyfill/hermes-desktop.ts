// Browser polyfill for the `window.hermesDesktop` bridge.
//
// Hermes Desktop exposes ~90 Electron IPC methods to the renderer via
// contextBridge (apps/desktop/electron/preload.ts). This module implements the
// same surface with plain web APIs against the Hermes dashboard backend
// (`hermes dashboard`, FastAPI on :9119):
//
//   · `api()`            → same-origin fetch (cookies or session-token header)
//   · `getGatewayWsUrl()`→ single-use WS tickets from POST /api/auth/ws-ticket
//   · connection         → a static `mode: 'remote'` descriptor, which flips
//                          the renderer's fs/git layers onto their existing
//                          REST branches (/api/fs/*, /api/git/*)
//   · terminal           → WebSocket PTY bridge (see ./terminal)
//   · notifications, clipboard, wake lock, file pickers → web platform APIs
//
// Everything Electron-only (auto-update, bootstrap installer, SSH tunnels,
// pet overlay window, zoom chrome) is stubbed to a benign no-op so the shared
// renderer code degrades gracefully.

import { buildHermesWebSocketUrl } from '@hermes/shared'

import type {
  DesktopBootProgress,
  DesktopBootstrapState,
  DesktopConnectionConfig,
  HermesApiRequest,
  HermesConnection,
  HermesNotification,
  HermesPreviewTarget,
  HermesReadFileTextResult,
  HermesSelectPathsOptions
} from '@/global'

import { createWebTerminal } from './terminal'

declare global {
  interface Window {
    __HERMES_AUTH_REQUIRED__?: boolean
    __HERMES_BASE_PATH__?: string
    __HERMES_SESSION_TOKEN__?: string
  }
}

const DEFAULT_TIMEOUT_MS = 30_000

export function webBasePath(): string {
  const raw = window.__HERMES_BASE_PATH__ ?? ''

  if (!raw || raw === '/') {
    return ''
  }

  const withLead = raw.startsWith('/') ? raw : `/${raw}`

  return withLead.replace(/\/+$/, '')
}

function sessionToken(): string {
  return window.__HERMES_SESSION_TOKEN__ ?? ''
}

function authRequired(): boolean {
  return window.__HERMES_AUTH_REQUIRED__ === true
}

function redirectToLogin(): void {
  const next = encodeURIComponent(window.location.pathname + window.location.search + window.location.hash)
  window.location.href = `${webBasePath()}/login?next=${next}`
}

// ── REST bridge ─────────────────────────────────────────────────────────────

async function apiFetch<T>(request: HermesApiRequest): Promise<T> {
  const base = webBasePath()
  const url = `${base}${request.path.startsWith('/') ? request.path : `/${request.path}`}`
  const controller = new AbortController()
  const timeoutMs = Math.max(1, request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const timer = window.setTimeout(
    () => controller.abort(new Error(`Timed out connecting to Hermes backend after ${timeoutMs}ms`)),
    timeoutMs
  )

  const headers: Record<string, string> = {}
  const token = sessionToken()

  if (token) {
    headers['X-Hermes-Session-Token'] = token
  }

  let body: BodyInit | undefined

  if (request.upload) {
    const form = new FormData()
    // Field name "file" mirrors the Electron bridge's multipartBody() and the
    // dashboard's FastAPI UploadFile endpoints.
    form.append(
      'file',
      new Blob([request.upload.bytes], { type: request.upload.contentType || 'application/octet-stream' }),
      request.upload.filename || 'file'
    )
    body = form
  } else if (request.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(request.body)
  }

  let res: Response

  try {
    res = await fetch(url, {
      method: request.method || 'GET',
      credentials: 'same-origin',
      headers,
      body,
      signal: controller.signal
    })
  } finally {
    window.clearTimeout(timer)
  }

  if (res.status === 401 && authRequired()) {
    // Cookie session expired mid-use: bounce through the login page, which
    // returns to the current SPA route via ?next=.
    redirectToLogin()
    throw new Error('401: session expired')
  }

  const text = await res.text()

  if (res.status >= 400) {
    // Mirror the Electron bridge's error contract: `Error("<status>: <text>")`.
    throw new Error(`${res.status}: ${text || res.statusText}`)
  }

  if (!text) {
    return null as T
  }

  const looksHtml = /^\s*<(?:!doctype|html)/i.test(text)
  const contentType = res.headers.get('content-type') || ''

  if (looksHtml || contentType.includes('text/html')) {
    throw new Error(
      `Expected JSON from ${url} but got HTML (status ${res.status}). ` +
        'The endpoint is likely missing on the Hermes backend.'
    )
  }

  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`Invalid JSON from ${url} (status ${res.status}): ${text.slice(0, 200)}`)
  }
}

// ── Connection descriptor + gateway WebSocket URL ───────────────────────────

function buildTokenWsUrl(): string {
  const token = sessionToken()

  return buildHermesWebSocketUrl({
    path: '/api/ws',
    basePath: webBasePath(),
    authParam: token ? ['token', token] : undefined
  })
}

function connectionDescriptor(profile?: string | null): HermesConnection {
  return {
    // 'remote' is the whole trick: the renderer's fs/git/preview layers
    // (src/lib/desktop-fs.ts, desktop-git.ts) route every operation through
    // the dashboard REST API when the connection is remote.
    mode: 'remote',
    remoteKind: 'url',
    authMode: authRequired() ? 'oauth' : 'token',
    baseUrl: `${window.location.origin}${webBasePath()}`,
    wsUrl: buildTokenWsUrl(),
    token: sessionToken(),
    isFullscreen: false,
    nativeOverlayWidth: 0,
    windowButtonPosition: null,
    logs: [],
    source: 'env',
    ...(profile ? { profile } : {})
  }
}

async function mintGatewayWsUrl(): Promise<{ ok: true; wsUrl: string } | { ok: false; error: string; needsOauthLogin?: boolean }> {
  if (!authRequired()) {
    return { ok: true, wsUrl: buildTokenWsUrl() }
  }

  try {
    const result = await apiFetch<{ ticket: string }>({ method: 'POST', path: '/api/auth/ws-ticket' })

    return {
      ok: true,
      wsUrl: buildHermesWebSocketUrl({
        path: '/api/ws',
        basePath: webBasePath(),
        authParam: ['ticket', result.ticket]
      })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    return { ok: false, error: message, needsOauthLogin: message.startsWith('401') }
  }
}

/** Mint a ticketed/tokened WebSocket URL for any dashboard WS endpoint
 *  (/api/terminal, /api/pty, …). Exported for the terminal polyfill. */
export async function mintWsUrlForPath(path: string, params?: Record<string, string>): Promise<string> {
  if (!authRequired()) {
    const token = sessionToken()

    return buildHermesWebSocketUrl({
      path,
      basePath: webBasePath(),
      params,
      authParam: token ? ['token', token] : undefined
    })
  }

  const result = await apiFetch<{ ticket: string }>({ method: 'POST', path: '/api/auth/ws-ticket' })

  return buildHermesWebSocketUrl({
    path,
    basePath: webBasePath(),
    params,
    authParam: ['ticket', result.ticket]
  })
}

// ── Browser-file attachments via synthetic paths ────────────────────────────
//
// The renderer's attach flows are path-based: drag-drop calls
// `getPathForFile(file)` and pickers return path arrays, then the paths are
// read back through readFileDataUrl/readFileText. Browsers never expose real
// paths, so we mint synthetic `hermes-web-upload://` paths and resolve them
// from an in-memory File registry.

const WEB_FILE_SCHEME = 'hermes-web-upload://'
const webFileRegistry = new Map<string, File>()
let webFileSeq = 0

function registerWebFile(file: File): string {
  const key = `${WEB_FILE_SCHEME}${++webFileSeq}/${file.name || 'file'}`
  webFileRegistry.set(key, file)

  return key
}

function lookupWebFile(path: string): File | null {
  return webFileRegistry.get(path) ?? null
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.onload = () => resolve(String(reader.result))
    reader.readAsDataURL(file)
  })
}

function pickBrowserFiles(options?: HermesSelectPathsOptions): Promise<string[]> {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = options?.multiple !== false

    if (options?.filters?.length) {
      const exts = options.filters.flatMap(f => f.extensions).filter(e => e && e !== '*')

      if (exts.length) {
        input.accept = exts.map(e => `.${e}`).join(',')
      }
    }

    input.style.display = 'none'
    document.body.appendChild(input)

    const finish = (files: FileList | null) => {
      input.remove()
      resolve(files ? Array.from(files).map(registerWebFile) : [])
    }

    input.onchange = () => finish(input.files)
    // `cancel` fires on modern Chromium/Firefox/Safari when the dialog closes
    // without a selection.
    input.oncancel = () => finish(null)
    input.click()
  })
}

// ── fs helpers over the dashboard REST API ──────────────────────────────────

function fsQueryPath(endpoint: string, filePath: string): string {
  return `/api/fs/${endpoint}?path=${encodeURIComponent(filePath)}`
}

async function readTextViaApi(path: string): Promise<HermesReadFileTextResult> {
  return apiFetch<HermesReadFileTextResult>({ path: fsQueryPath('read-text', path) })
}

async function readDataUrlViaApi(path: string): Promise<string> {
  const result = await apiFetch<string | { dataUrl?: string }>({ path: fsQueryPath('read-data-url', path) })

  return typeof result === 'string' ? result : result.dataUrl || ''
}

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)

  return parts[parts.length - 1] || p
}

// ── Small event-channel helper (Electron ipcRenderer.on replacement) ────────

type Unsub = () => void

function createChannel<T>() {
  const listeners = new Set<(payload: T) => void>()

  return {
    emit(payload: T) {
      for (const listener of [...listeners]) {
        listener(payload)
      }
    },
    on(callback: (payload: T) => void): Unsub {
      listeners.add(callback)

      return () => listeners.delete(callback)
    }
  }
}

const notificationActionChannel = createChannel<{ actionId: string; sessionId?: string }>()
const focusSessionChannel = createChannel<string>()

const noopUnsub: Unsub = () => undefined

// ── Notifications ───────────────────────────────────────────────────────────

async function webNotify(payload: HermesNotification): Promise<boolean> {
  if (typeof Notification === 'undefined') {
    return false
  }

  if (Notification.permission === 'default') {
    await Notification.requestPermission().catch(() => 'denied')
  }

  if (Notification.permission !== 'granted') {
    return false
  }

  const notification = new Notification(payload.title || 'Hermes', {
    body: payload.body || '',
    silent: payload.silent ?? false,
    tag: payload.sessionId ? `hermes-session-${payload.sessionId}` : undefined
  })

  notification.onclick = () => {
    window.focus()

    if (payload.sessionId) {
      focusSessionChannel.emit(payload.sessionId)
      notificationActionChannel.emit({ actionId: payload.actions?.[0]?.id ?? 'open', sessionId: payload.sessionId })
    }

    notification.close()
  }

  return true
}

// ── Wake lock ───────────────────────────────────────────────────────────────

let wakeLockSentinel: { release: () => Promise<void> } | null = null
let wakeLockWanted = false

async function acquireWakeLock(): Promise<void> {
  const wakeLock = (navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<any> } }).wakeLock

  if (!wakeLock) {
    return
  }

  try {
    wakeLockSentinel = await wakeLock.request('screen')
  } catch {
    wakeLockSentinel = null
  }
}

function setKeepAwake(on: boolean): void {
  wakeLockWanted = on

  if (on) {
    void acquireWakeLock()
  } else {
    void wakeLockSentinel?.release().catch(() => undefined)
    wakeLockSentinel = null
  }
}

document.addEventListener('visibilitychange', () => {
  // Wake locks auto-release when the tab hides; re-acquire on return.
  if (wakeLockWanted && document.visibilityState === 'visible' && !wakeLockSentinel) {
    void acquireWakeLock()
  }
})

// ── Cross-tab ambient-cue claim ─────────────────────────────────────────────
//
// Multiple tabs of the web app behave like the desktop's multiple windows: the
// first tab to claim a cue key (turn-end sound, spoken reply) plays it, peers
// stay quiet. localStorage writes are atomic enough for this best-effort dedup.

function claimAmbientCue(key: string): boolean {
  try {
    const storageKey = `hermes-web-ambient:${String(key)}`
    const now = Date.now()
    const prior = Number(localStorage.getItem(storageKey) || 0)

    if (prior && now - prior < 5_000) {
      return false
    }

    localStorage.setItem(storageKey, String(now))

    return true
  } catch {
    return true
  }
}

// ── Preview target normalization ────────────────────────────────────────────

async function normalizePreviewTarget(target: string, baseDir?: string): Promise<HermesPreviewTarget | null> {
  const trimmed = String(target || '').trim()

  if (!trimmed) {
    return null
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return { kind: 'url', label: trimmed, source: trimmed, url: trimmed }
  }

  const path = trimmed.startsWith('/')
    ? trimmed
    : baseDir
      ? `${baseDir.replace(/\/+$/, '')}/${trimmed}`
      : trimmed

  try {
    const info = await readTextViaApi(path)
    const previewKind = info.binary
      ? info.mimeType?.startsWith('image/')
        ? 'image'
        : 'binary'
      : info.mimeType === 'text/html' || /\.html?$/i.test(path)
        ? 'html'
        : 'text'

    return {
      kind: 'file',
      label: basename(path),
      path: info.path || path,
      source: trimmed,
      url: `file://${info.path || path}`,
      binary: info.binary,
      byteSize: info.byteSize,
      language: info.language,
      mimeType: info.mimeType,
      previewKind
    }
  } catch {
    return null
  }
}

// ── The polyfill surface ────────────────────────────────────────────────────

export function installHermesDesktopPolyfill(): void {
  const version = '0.1.0'

  const desktop: Window['hermesDesktop'] = {
    // Connection --------------------------------------------------------------
    getConnection: async profile => connectionDescriptor(profile),
    revalidateConnection: async () => ({ ok: true, rebuilt: false }),
    touchBackend: async () => ({ ok: true }),
    getGatewayWsUrl: async () => mintGatewayWsUrl(),

    // Windows: the web equivalent of a session window is a browser tab.
    openSessionWindow: async sessionId => {
      if (!sessionId) {
        return { ok: false, error: 'invalid-session' }
      }

      window.open(`${webBasePath()}/#/${encodeURIComponent(sessionId)}`, '_blank', 'noopener')

      return { ok: true }
    },
    openWindow: async () => {
      window.open(`${webBasePath()}/`, '_blank', 'noopener')

      return { ok: true }
    },
    claimAmbientCue: async key => claimAmbientCue(key),

    // Electron-only window furniture — benign stubs.
    petOverlay: {
      open: async () => ({ ok: false }),
      close: async () => ({ ok: true }),
      setBounds: () => undefined,
      setIgnoreMouse: () => undefined,
      setFocusable: () => undefined,
      pushState: () => undefined,
      control: () => undefined,
      onState: () => noopUnsub,
      onControl: () => noopUnsub
    },
    quickEntry: {
      getSettings: async () => ({ enabled: false, registered: false, shortcut: '' }) as any,
      setSettings: async () => ({ enabled: false, registered: false, shortcut: '', error: 'unsupported' }) as any,
      submit: () => undefined,
      dismiss: () => undefined,
      pushState: () => undefined,
      onState: () => noopUnsub,
      onSubmit: () => noopUnsub,
      onShown: () => noopUnsub
    },

    getBootProgress: async (): Promise<DesktopBootProgress> => ({
      error: null,
      fakeMode: false,
      message: 'ready',
      phase: 'ready',
      progress: 1,
      running: false,
      timestamp: Date.now()
    }),

    // Connection-config settings surface: the server IS the connection in a
    // web deployment, so these read as a fixed env-driven remote config.
    getConnectionConfig: async (): Promise<DesktopConnectionConfig> => ({
      envOverride: true,
      mode: 'remote',
      profile: null,
      remoteAuthMode: authRequired() ? 'oauth' : 'token',
      remoteOauthConnected: authRequired(),
      remoteTokenPreview: null,
      remoteTokenSet: Boolean(sessionToken()),
      remoteUrl: `${window.location.origin}${webBasePath()}`,
      cloudOrg: '',
      sshHost: '',
      sshUser: '',
      sshPort: null,
      sshKeyPath: '',
      sshRemoteHermesPath: ''
    }),
    saveConnectionConfig: async () => desktop.getConnectionConfig(),
    applyConnectionConfig: async () => desktop.getConnectionConfig(),
    testConnectionConfig: async () => ({ ok: true, reachable: true, baseUrl: `${window.location.origin}${webBasePath()}` }),
    sshConfigHosts: async () => ({ hosts: [] }),
    sshResolveHost: async () => ({ hostname: null, identityFile: null, port: null, user: null }),
    probeConnectionConfig: async remoteUrl => ({
      baseUrl: remoteUrl,
      reachable: false,
      authMode: 'unknown',
      providers: [],
      version: null,
      error: 'Connecting to other gateways is not supported from the web app.'
    }),
    oauthLoginConnectionConfig: async remoteUrl => ({ ok: false, baseUrl: remoteUrl, connected: false }),
    oauthLogoutConnectionConfig: async () => ({ ok: false, connected: false }),
    cloud: {
      status: async () => ({ portalBaseUrl: '', signedIn: false }),
      login: async () => ({ portalBaseUrl: '', signedIn: false, ok: false }),
      logout: async () => ({ portalBaseUrl: '', signedIn: false, ok: true }),
      discover: async () => ({ agents: [] }),
      agentSignIn: async dashboardUrl => ({ baseUrl: dashboardUrl, connected: false })
    },

    profile: {
      get: async () => ({ profile: localStorage.getItem('hermes-web-profile') }),
      set: async name => {
        if (name) {
          localStorage.setItem('hermes-web-profile', name)
        } else {
          localStorage.removeItem('hermes-web-profile')
        }

        window.location.reload()

        return { profile: name }
      }
    },

    // REST ------------------------------------------------------------------
    api: apiFetch,

    // Notifications / mic ---------------------------------------------------
    notify: webNotify,
    requestMicrophoneAccess: async () => true,

    // Local-file reads: synthetic browser-upload paths resolve from the File
    // registry; anything else is a server path read over /api/fs/*.
    readFileDataUrl: async filePath => {
      const file = lookupWebFile(filePath)

      return file ? readFileAsDataUrl(file) : readDataUrlViaApi(filePath)
    },
    readFileDataUrlForAttach: async filePath => {
      const file = lookupWebFile(filePath)

      return file ? readFileAsDataUrl(file) : readDataUrlViaApi(filePath)
    },
    dataUrlReadMax: {
      get: async () => ({ defaultMaxMb: 25, maxBytes: 25 * 1024 * 1024, maxMb: 25 }),
      set: async maxMb => ({ defaultMaxMb: 25, maxBytes: maxMb * 1024 * 1024, maxMb })
    },
    readFileText: async filePath => {
      const file = lookupWebFile(filePath)

      if (file) {
        return {
          path: filePath,
          text: await file.text(),
          byteSize: file.size,
          mimeType: file.type || undefined
        }
      }

      return readTextViaApi(filePath)
    },
    selectPaths: async options => {
      if (options?.directories) {
        // Directory selection means a SERVER directory (workspace cwd). The
        // renderer routes this through its remote picker UI when one is
        // registered (src/lib/desktop-fs.ts); reaching the bridge without one
        // means no picker is available.
        return []
      }

      return pickBrowserFiles(options)
    },
    writeClipboard: async text => {
      try {
        await navigator.clipboard.writeText(text)

        return true
      } catch {
        return false
      }
    },
    readClipboard: async () => {
      try {
        return await navigator.clipboard.readText()
      } catch {
        return ''
      }
    },
    saveImageFromUrl: async url => {
      try {
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = basename(url.split('?')[0]) || 'image'
        anchor.rel = 'noopener'
        anchor.click()

        return true
      } catch {
        return false
      }
    },
    saveImageBuffer: async (data, ext) => {
      const blob = new Blob([data instanceof Uint8Array ? (data as Uint8Array<ArrayBuffer>) : new Uint8Array(data)])
      const url = URL.createObjectURL(blob)
      const name = `hermes-image.${ext || 'png'}`
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000)

      return name
    },
    saveClipboardImage: async () => {
      try {
        const items = await (navigator.clipboard as Clipboard & { read?: () => Promise<ClipboardItems> }).read?.()

        if (!items) {
          return ''
        }

        for (const item of items) {
          const imageType = item.types.find(t => t.startsWith('image/'))

          if (imageType) {
            const blob = await item.getType(imageType)
            const url = URL.createObjectURL(blob)
            const anchor = document.createElement('a')
            anchor.href = url
            anchor.download = `clipboard.${imageType.split('/')[1] || 'png'}`
            anchor.click()
            window.setTimeout(() => URL.revokeObjectURL(url), 30_000)

            return anchor.download
          }
        }

        return ''
      } catch {
        return ''
      }
    },
    getPathForFile: file => registerWebFile(file),

    normalizePreviewTarget,
    watchPreviewFile: async url => ({ id: `web-watch-${Date.now()}`, path: url }),
    watchDirectory: async dir => ({ id: `web-watch-${Date.now()}`, path: dir }),
    stopPreviewFileWatch: async () => true,

    setActiveWork: () => undefined,
    setTitleBarTheme: payload => {
      const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')

      if (meta && payload?.background) {
        meta.content = payload.background
      }
    },
    setNativeTheme: () => undefined,
    setTranslucency: () => undefined,
    setKeepAwake,
    setPreviewShortcutActive: () => undefined,

    openExternal: async url => {
      window.open(url, '_blank', 'noopener')
    },
    openPreviewInBrowser: async url => {
      window.open(url, '_blank', 'noopener')
    },
    fetchLinkTitle: async () => '',
    sanitizeWorkspaceCwd: async cwd => ({ cwd: cwd || '', sanitized: false }),

    settings: {
      getDefaultProjectDir: async () => {
        const dir = localStorage.getItem('hermes-web-default-project-dir')

        let resolvedCwd = dir || ''

        if (!resolvedCwd) {
          try {
            const info = await apiFetch<{ cwd: string }>({ path: '/api/fs/default-cwd' })
            resolvedCwd = info.cwd || ''
          } catch {
            resolvedCwd = ''
          }
        }

        return { defaultLabel: 'Server default', dir, resolvedCwd }
      },
      setDefaultProjectDir: async dir => {
        if (dir) {
          localStorage.setItem('hermes-web-default-project-dir', dir)
        } else {
          localStorage.removeItem('hermes-web-default-project-dir')
        }

        return { dir }
      },
      pickDefaultProjectDir: async () => {
        // Server-directory picking needs the renderer's remote picker UI; the
        // settings page lets the user type a path either way.
        return { canceled: true, dir: null }
      }
    },

    zoom: {
      get: async () => ({ level: 0, percent: 100 }),
      setPercent: () => undefined,
      onChanged: () => noopUnsub
    },

    revealLogs: async () => ({ ok: false, path: '', error: 'Not available in the web app' }),
    getRecentLogs: async () => {
      try {
        const result = await apiFetch<{ logs?: string[]; lines?: string[]; path?: string }>({ path: '/api/logs' })

        return { path: result.path || 'server', lines: result.lines || result.logs || [] }
      } catch {
        return { path: '', lines: [] }
      }
    },

    // Server fs (renderer mostly hits these via its remote REST branches; the
    // direct bridge methods delegate to the same endpoints for stragglers).
    readDir: async dirPath => apiFetch({ path: fsQueryPath('list', dirPath) }),
    gitRoot: async startPath => {
      try {
        const result = await apiFetch<{ root: string | null }>({ path: fsQueryPath('git-root', startPath) })

        return result.root
      } catch {
        return null
      }
    },
    revealPath: async () => false,
    openDir: async () => ({ ok: false, error: 'Not available in the web app' }),
    desktopPluginsRoot: async () => '',
    renamePath: async (targetPath, newName) => {
      const result = await apiFetch<{ path?: string }>({
        method: 'POST',
        path: '/api/fs/rename',
        body: { path: targetPath, newName }
      })

      return { path: result.path || targetPath }
    },
    writeTextFile: async (filePath, content) => {
      const result = await apiFetch<{ path?: string }>({
        method: 'POST',
        path: '/api/fs/write-text',
        body: { content, path: filePath }
      })

      return { path: result.path || filePath }
    },
    trashPath: async targetPath => {
      await apiFetch({ method: 'POST', path: '/api/fs/trash', body: { path: targetPath } })

      return true
    },

    // Git: the renderer's desktop-git.ts already routes every review/worktree
    // operation through /api/git/* in remote mode, so the bridge-level `git`
    // object is intentionally absent — desktop-git checks remote mode FIRST,
    // and absence keeps any non-remote-aware straggler failing soft.
    git: undefined,

    terminal: createWebTerminal(mintWsUrlForPath),

    onClosePreviewRequested: () => noopUnsub,
    onOpenFolderRequested: () => noopUnsub,
    onOpenUpdatesRequested: () => noopUnsub,
    onDeepLink: () => noopUnsub,
    signalDeepLinkReady: async () => ({ ok: true }),
    onWindowStateChanged: () => noopUnsub,
    onFocusSession: callback => focusSessionChannel.on(callback),
    onNotificationAction: callback => notificationActionChannel.on(callback),
    onPreviewFileChanged: () => noopUnsub,
    onBackendExit: () => noopUnsub,
    onConnectionApplied: () => noopUnsub,
    onPowerResume: callback => {
      const listener = () => {
        if (document.visibilityState === 'visible') {
          callback()
        }
      }

      document.addEventListener('visibilitychange', listener)

      return () => document.removeEventListener('visibilitychange', listener)
    },
    getOnBattery: async () => {
      try {
        const battery = await (navigator as Navigator & { getBattery?: () => Promise<{ charging: boolean }> }).getBattery?.()

        return battery ? !battery.charging : false
      } catch {
        return false
      }
    },
    onBatteryChanged: () => noopUnsub,
    onBootProgress: () => noopUnsub,

    getBootstrapState: async (): Promise<DesktopBootstrapState> => ({
      active: false,
      manifest: null,
      stages: {},
      error: null,
      log: [],
      startedAt: null,
      completedAt: null,
      setupChoice: null,
      unsupportedPlatform: null
    }),
    continueBootstrapLocal: async () => ({ ok: true }),
    resetBootstrap: async () => ({ ok: true }),
    repairBootstrap: async () => ({ ok: true }),
    cancelBootstrap: async () => ({ ok: true, cancelled: false }),
    onBootstrapEvent: () => noopUnsub,

    getVersion: async () => ({
      appVersion: version,
      electronVersion: '',
      nodeVersion: '',
      platform: 'web',
      hermesRoot: ''
    }),
    getRemoteDisplayReason: async () => null,

    uninstall: {
      summary: async () => ({
        hermes_home: '',
        agent_installed: true,
        gui_installed: false,
        source_built_artifacts: [],
        packaged_app_paths: [],
        userdata_dir: '',
        userdata_exists: false,
        platform: 'web'
      }),
      run: async () => ({ ok: false, error: 'Not available in the web app' })
    },
    updates: {
      check: async () => ({ supported: false, reason: 'web', message: 'Update the server deployment instead.' }),
      apply: async () => ({ ok: false, error: 'Not available in the web app' }),
      getBranch: async () => ({ branch: 'main' }),
      setBranch: async name => ({ branch: name }),
      onProgress: () => noopUnsub
    },
    themes: {
      fetchMarketplace: async () => {
        throw new Error('The VS Code theme marketplace is not available in the web app yet.')
      },
      searchMarketplace: async () => []
    },

    // Find-in-page: browsers already own Ctrl/Cmd+F.
    findInPage: async () => ({ count: 0 }),
    stopFindInPage: async () => undefined,
    onFoundInPage: () => noopUnsub
  }

  // Soft-fail against upstream drift: a renderer update may call a bridge
  // method this polyfill doesn't know yet. Log once and return a resolved
  // promise instead of crashing the whole app on `x is not a function`.
  const warned = new Set<string>()
  const proxied = new Proxy(desktop as unknown as Record<PropertyKey, unknown>, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)

      if (value === undefined && typeof prop === 'string' && !(prop in target) && prop !== 'then') {
        if (!warned.has(prop)) {
          warned.add(prop)
          console.warn(`[hermes-web] Unimplemented hermesDesktop.${prop} — returning a no-op stub.`)
        }

        return () => Promise.resolve(undefined)
      }

      return value
    }
  })

  window.hermesDesktop = proxied as unknown as Window['hermesDesktop']
}
