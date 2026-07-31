// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installHermesDesktopPolyfill, mintWsUrlForPath, webBasePath } from './hermes-desktop'

function mockFetchOnce(status: number, body: string, contentType = 'application/json') {
  const fn = vi.fn(async () => new Response(body, { status, headers: { 'content-type': contentType } }))
  vi.stubGlobal('fetch', fn)

  return fn
}

beforeEach(() => {
  window.__HERMES_BASE_PATH__ = ''
  window.__HERMES_SESSION_TOKEN__ = 'tok-123'
  window.__HERMES_AUTH_REQUIRED__ = false
  installHermesDesktopPolyfill()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('api()', () => {
  it('returns parsed JSON and sends the session-token header', async () => {
    const fetchMock = mockFetchOnce(200, '{"ok":true}')
    const result = await window.hermesDesktop.api<{ ok: boolean }>({ path: '/api/status' })

    expect(result).toEqual({ ok: true })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/status')
    expect((init.headers as Record<string, string>)['X-Hermes-Session-Token']).toBe('tok-123')
    expect(init.credentials).toBe('same-origin')
  })

  it('rejects with the Electron bridge error contract on >=400', async () => {
    mockFetchOnce(500, 'boom')
    await expect(window.hermesDesktop.api({ path: '/api/x' })).rejects.toThrow('500: boom')
  })

  it('resolves null on an empty body', async () => {
    mockFetchOnce(200, '')
    await expect(window.hermesDesktop.api({ path: '/api/x' })).resolves.toBeNull()
  })

  it('rejects clearly when an unregistered path falls through to HTML', async () => {
    mockFetchOnce(200, '<!doctype html><html></html>', 'text/html')
    await expect(window.hermesDesktop.api({ path: '/api/gone' })).rejects.toThrow(/got HTML/)
  })

  it('serializes JSON bodies with content-type', async () => {
    const fetchMock = mockFetchOnce(200, '{}')
    await window.hermesDesktop.api({ path: '/api/x', method: 'POST', body: { a: 1 } })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.body).toBe('{"a":1}')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('prefixes the reverse-proxy base path', async () => {
    window.__HERMES_BASE_PATH__ = '/hermes'
    const fetchMock = mockFetchOnce(200, '{}')
    await window.hermesDesktop.api({ path: '/api/status' })
    expect(fetchMock.mock.calls[0][0]).toBe('/hermes/api/status')
  })
})

describe('connection + gateway WS URL', () => {
  it('describes a remote token-mode connection', async () => {
    const conn = await window.hermesDesktop.getConnection()

    expect(conn.mode).toBe('remote')
    expect(conn.authMode).toBe('token')
    expect(conn.token).toBe('tok-123')
    expect(conn.wsUrl).toContain('/api/ws?token=tok-123')
  })

  it('token mode mints the WS URL without a ticket round-trip', async () => {
    const fetchMock = mockFetchOnce(200, '{}')
    const result = await window.hermesDesktop.getGatewayWsUrl()

    expect(result).toMatchObject({ ok: true })
    expect((result as { wsUrl: string }).wsUrl).toContain('token=tok-123')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('gated mode mints a fresh single-use ticket per URL', async () => {
    window.__HERMES_AUTH_REQUIRED__ = true
    window.__HERMES_SESSION_TOKEN__ = ''
    const fetchMock = mockFetchOnce(200, '{"ticket":"t-1","ttl_seconds":30}')

    const result = await window.hermesDesktop.getGatewayWsUrl()
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/ws-ticket', expect.objectContaining({ method: 'POST' }))
    expect((result as { wsUrl: string }).wsUrl).toContain('ticket=t-1')
  })

  it('gated mode surfaces reauth on a 401 ticket mint', async () => {
    window.__HERMES_AUTH_REQUIRED__ = true
    mockFetchOnce(401, 'no')

    const result = await window.hermesDesktop.getGatewayWsUrl()
    expect(result).toMatchObject({ ok: false, needsOauthLogin: true })
  })

  it('mintWsUrlForPath carries params for other WS endpoints', async () => {
    const url = await mintWsUrlForPath('/api/terminal', { cols: '80', rows: '24' })
    expect(url).toContain('/api/terminal?')
    expect(url).toContain('cols=80')
    expect(url).toContain('token=tok-123')
  })
})

describe('browser-file synthetic paths', () => {
  it('getPathForFile registers a file readable via readFileDataUrl and readFileText', async () => {
    const file = new File(['hello web'], 'note.txt', { type: 'text/plain' })
    const path = window.hermesDesktop.getPathForFile(file)

    expect(path).toMatch(/^hermes-web-upload:\/\//)
    expect(path).toContain('note.txt')

    const dataUrl = await window.hermesDesktop.readFileDataUrl(path)
    expect(dataUrl).toMatch(/^data:text\/plain/)

    const text = await window.hermesDesktop.readFileText(path)
    expect(text.text).toBe('hello web')
  })

  it('server paths fall through to /api/fs/read-data-url', async () => {
    const fetchMock = mockFetchOnce(200, '"data:image/png;base64,AAA"')
    const dataUrl = await window.hermesDesktop.readFileDataUrl('/srv/pic.png')

    expect(dataUrl).toBe('data:image/png;base64,AAA')
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/fs/read-data-url?path=%2Fsrv%2Fpic.png')
  })
})

describe('drift safety net', () => {
  it('unknown bridge methods become logged no-op stubs instead of crashes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const anyDesktop = window.hermesDesktop as unknown as Record<string, () => Promise<unknown>>

    await expect(anyDesktop.someFutureMethod()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()

    // Only warns once per method name.
    await anyDesktop.someFutureMethod()
    expect(warn).toHaveBeenCalledOnce()
  })
})

describe('webBasePath()', () => {
  it('normalizes prefixes', () => {
    window.__HERMES_BASE_PATH__ = ''
    expect(webBasePath()).toBe('')
    window.__HERMES_BASE_PATH__ = '/'
    expect(webBasePath()).toBe('')
    window.__HERMES_BASE_PATH__ = '/hermes/'
    expect(webBasePath()).toBe('/hermes')
    window.__HERMES_BASE_PATH__ = 'hermes'
    expect(webBasePath()).toBe('/hermes')
  })
})
