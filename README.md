# Hermes Web

**The full Hermes Desktop experience, self-hosted in your browser.**

Hermes Web serves the [Hermes Desktop](https://hermes-agent.nousresearch.com/docs/user-guide/desktop)
renderer — the same chat, streaming tool output, terminal, git review, memory
starmap, artifacts, file browser, voice mode, skills hub, cron, agents, and
settings UI — as a plain web app from your own `hermes dashboard` backend. No
Electron, no desktop install: open a browser tab, sign in, and everything
works, microphone included.

Built on [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) (MIT).

## How it works

The desktop app was always two halves: a React renderer and an Electron main
process bridging it to the OS and to a `hermes serve` backend over JSON-RPC/
WebSocket. Hermes Web keeps the renderer **byte-for-byte** (this workspace
aliases `@` → `../desktop/src`, no fork of the UI code) and replaces the
Electron bridge with a browser polyfill
([`src/polyfill/hermes-desktop.ts`](apps/webapp/src/polyfill/hermes-desktop.ts)):

| Electron bridge | Web replacement |
|---|---|
| `api()` IPC → backend REST | same-origin `fetch` with session cookies |
| gateway WS URL minting | single-use tickets from `POST /api/auth/ws-ticket` |
| local fs / git IPC | the renderer's own remote-mode REST branches (`/api/fs/*`, `/api/git/*`) |
| node-pty terminal | `/api/terminal` WebSocket PTY (new backend endpoint, opt-in) |
| mic permission IPC | `getUserMedia` (the capture code was already pure web) |
| notifications, clipboard, wake lock | Notification API, `navigator.clipboard`, `navigator.wakeLock` |
| auto-update, installer, SSH tunnels, pet overlay window | not applicable on web — stubbed |

Speech-to-text (`POST /api/audio/transcribe`) and streaming text-to-speech
(`/api/audio/speak-stream`, raw PCM with barge-in) were already served by the
dashboard backend; they work from the browser as-is. **HTTPS is required for
the microphone** (any secure context — the bundled Caddy handles it).

## Self-host (Docker, recommended)

```bash
git clone <this-repo> && cd <this-repo>
cp docker/webapp.env.example .env   # set username/password + domain
./docker/webapp-up.sh
```

Then open `https://<your-domain>/`, sign in, and connect a model provider in
onboarding (or pre-set an API key in `.env`).

## Development

```bash
# backend (needs a hermes-agent install; any recent version works)
HERMES_WEB_DIST=$PWD/apps/webapp/dist hermes dashboard --no-open

# frontend with HMR (proxies /api → 127.0.0.1:9119)
npm install --workspace apps/webapp --workspace apps/shared
npm run dev  -w apps/webapp     # http://127.0.0.1:5175
npm run build -w apps/webapp    # → apps/webapp/dist
```

Tests:

```bash
npm test -w apps/webapp                                  # polyfill unit tests
HERMES_WEB_URL=http://127.0.0.1:9119 npx playwright test # e2e (see playwright.config.ts)
```

## Web-specific notes

- **Terminal**: the browser terminal pane runs a real shell on the server via
  the new `/api/terminal` endpoint (`hermes_cli/terminal_ws.py`). It is
  **opt-in** (`HERMES_DASHBOARD_TERMINAL=1`) because a browser-reachable
  shell means a stolen session is code execution on the host. The Docker
  image enables it (the shell is confined to the container); think twice
  before enabling it on a bare-metal install.
- **Voice**: mic capture needs HTTPS or localhost. Local STT uses
  faster-whisper (installed in the Docker image); cloud STT (Groq, OpenAI,
  Mistral, xAI, ElevenLabs) needs only an API key. TTS defaults to edge-tts
  (no key needed).
- **Multi-user**: one instance = one Hermes (same model as the desktop app).
  The auth gate protects it; for multiple people, run one container each.
- Not portable to web: global quick-entry hotkey, the floating pet overlay
  window, "reveal in file manager", auto-update (redeploy instead).
  Multi-window becomes multi-tab.

## Staying current with upstream

The renderer is consumed in place from `apps/desktop/src`, so tracking
upstream is `git fetch upstream && git merge` — web-only code lives in
`apps/webapp/` plus one registration hunk in `hermes_cli/web_server.py`.
A new bridge method appearing upstream degrades to a logged no-op stub
(Proxy fallthrough) instead of crashing, and CI builds against fresh
upstream weekly to surface drift early.

## License

MIT — this project and the upstream it builds on.
Copyright (c) 2025 Nous Research (hermes-agent); web port additions under the
same license.
