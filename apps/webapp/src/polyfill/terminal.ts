// Web implementation of the `window.hermesDesktop.terminal` bridge.
//
// The desktop app spawns the user's shell through node-pty in the Electron
// main process. On the web the PTY lives server-side: each terminal id maps to
// one WebSocket against the dashboard's `/api/terminal` endpoint
// (hermes_cli/terminal_ws.py), which spawns the interactive shell via
// PtyBridge and relays raw bytes both ways.
//
// Wire protocol (mirrors the dashboard's existing /api/pty conventions):
//   · client → server: raw input as text frames
//   · client → server: in-band resize escape  ESC [RESIZE:<cols>;<rows>]
//   · server → client: first frame is a JSON hello {type:'hello',id,shell,cwd}
//   · server → client: everything after = raw PTY output (text/binary frames)
//   · socket close    = PTY exit
//
// The consumer (src/app/right-sidebar/terminal/use-terminal-session.ts, 1000+
// lines) is used completely unchanged — this module only satisfies its
// 7-method contract.

import type { HermesTerminalExit, HermesTerminalSession } from '@/global'

type MintWsUrl = (path: string, params?: Record<string, string>) => Promise<string>

interface TerminalHandle {
  socket: WebSocket
  dataListeners: Set<(payload: string) => void>
  exitListeners: Set<(payload: HermesTerminalExit) => void>
  // Output that arrived before the first onData listener attached (start()
  // resolves before the hook wires listeners; shells emit their prompt fast).
  pending: string[]
  exited: boolean
  cwd: string
}

const RESIZE_ESCAPE = (cols: number, rows: number) => `\x1b[RESIZE:${cols};${rows}]`

export function createWebTerminal(mintWsUrl: MintWsUrl): Window['hermesDesktop']['terminal'] {
  const terminals = new Map<string, TerminalHandle>()
  let fallbackSeq = 0

  const emitData = (handle: TerminalHandle, chunk: string) => {
    if (handle.dataListeners.size === 0) {
      handle.pending.push(chunk)

      return
    }

    for (const listener of [...handle.dataListeners]) {
      listener(chunk)
    }
  }

  const emitExit = (handle: TerminalHandle, payload: HermesTerminalExit) => {
    if (handle.exited) {
      return
    }

    handle.exited = true

    for (const listener of [...handle.exitListeners]) {
      listener(payload)
    }
  }

  return {
    start: async options => {
      const params: Record<string, string> = {}

      if (options?.cols) params.cols = String(options.cols)
      if (options?.rows) params.rows = String(options.rows)
      if (options?.cwd) params.cwd = options.cwd

      const url = await mintWsUrl('/api/terminal', params)
      const socket = new WebSocket(url)
      socket.binaryType = 'arraybuffer'

      const handle: TerminalHandle = {
        socket,
        dataListeners: new Set(),
        exitListeners: new Set(),
        pending: [],
        exited: false,
        cwd: options?.cwd || ''
      }

      const decoder = new TextDecoder()

      const session = await new Promise<HermesTerminalSession>((resolve, reject) => {
        let resolved = false

        socket.onmessage = event => {
          const text = typeof event.data === 'string' ? event.data : decoder.decode(event.data, { stream: true })

          if (!resolved) {
            // First frame is the JSON hello.
            try {
              const hello = JSON.parse(text) as { type?: string; id?: string; shell?: string; cwd?: string }

              if (hello.type === 'hello' && hello.id) {
                resolved = true
                handle.cwd = hello.cwd || handle.cwd
                terminals.set(hello.id, handle)
                resolve({ id: hello.id, shell: hello.shell || 'shell', cwd: handle.cwd })

                return
              }
            } catch {
              // Not a hello — treat as output below (server predates hello?).
              resolved = true
              const id = `web-term-${++fallbackSeq}`
              terminals.set(id, handle)
              resolve({ id, shell: 'shell', cwd: handle.cwd })
            }
          }

          emitData(handle, text)
        }

        socket.onerror = () => {
          if (!resolved) {
            resolved = true
            reject(new Error('Could not open a terminal on the Hermes server (is /api/terminal enabled?)'))
          }
        }

        socket.onclose = event => {
          if (!resolved) {
            resolved = true
            reject(
              new Error(
                event.code === 4401 || event.code === 4403
                  ? 'Terminal connection rejected: not authorized.'
                  : `Terminal connection closed (${event.code}).`
              )
            )

            return
          }

          emitExit(handle, { code: event.wasClean ? 0 : 1, signal: null })
        }
      })

      return session
    },

    write: async (id, data) => {
      const handle = terminals.get(id)

      if (!handle || handle.socket.readyState !== WebSocket.OPEN) {
        return false
      }

      handle.socket.send(data)

      return true
    },

    resize: async (id, size) => {
      const handle = terminals.get(id)

      if (!handle || handle.socket.readyState !== WebSocket.OPEN) {
        return false
      }

      handle.socket.send(RESIZE_ESCAPE(size.cols, size.rows))

      return true
    },

    dispose: async id => {
      const handle = terminals.get(id)

      if (!handle) {
        return false
      }

      terminals.delete(id)
      handle.exited = true

      try {
        handle.socket.close(1000)
      } catch {
        // already closed
      }

      return true
    },

    cwd: async id => {
      const handle = terminals.get(id)

      return handle?.cwd || null
    },

    onData: (id, callback) => {
      const handle = terminals.get(id)

      if (!handle) {
        return () => undefined
      }

      handle.dataListeners.add(callback)

      if (handle.pending.length) {
        const backlog = handle.pending.splice(0)

        for (const chunk of backlog) {
          callback(chunk)
        }
      }

      return () => handle.dataListeners.delete(callback)
    },

    onExit: (id, callback) => {
      const handle = terminals.get(id)

      if (!handle) {
        return () => undefined
      }

      if (handle.exited) {
        callback({ code: 0, signal: null })

        return () => undefined
      }

      handle.exitListeners.add(callback)

      return () => handle.exitListeners.delete(callback)
    }
  }
}
