# Hermes Web — self-hostable browser front end for Hermes Agent.
#
# Two stages:
#   1. webapp_build — Node stage that compiles apps/webapp (the desktop
#      renderer running against the browser polyfill) into a static dist.
#   2. final        — extends the stock hermes-agent image (built from the
#      repo-root Dockerfile, see docker/webapp-up.sh) with that dist, the
#      voice STT extra, and web-friendly defaults.
#
# Build via docker-compose.webapp.yml / docker/webapp-up.sh — the stock
# image must exist as `hermes-agent` first (BASE_IMAGE arg to override).

ARG BASE_IMAGE=hermes-agent

FROM node:22-bookworm-slim AS webapp_build

WORKDIR /src

# Workspace manifests first for layer caching. npm needs every workspace
# named in the root package.json to exist, so the sparse copy includes each
# package.json the workspaces glob resolves to.
COPY package.json package-lock.json ./
COPY apps/shared/package.json apps/shared/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/webapp/package.json apps/webapp/package.json
COPY apps/bootstrap-installer/package.json apps/bootstrap-installer/package.json
COPY web/package.json web/package.json
COPY ui-tui/package.json ui-tui/package.json
COPY ui-tui/packages/hermes-ink/package.json ui-tui/packages/hermes-ink/package.json
COPY tests-js/package.json tests-js/package.json

# node-pty (desktop-only, native) has no place in a web image; the webapp
# workspace doesn't depend on it, and --workspace scoping keeps the install
# to what apps/webapp + apps/shared actually need.
RUN npm install --workspace apps/webapp --workspace apps/shared --no-audit --no-fund

COPY apps/shared apps/shared
COPY apps/desktop apps/desktop
COPY apps/webapp apps/webapp

RUN npm run build --workspace apps/webapp


ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# The compiled SPA. mount_spa() serves whatever HERMES_WEB_DIST points at —
# no Python changes involved in swapping the UI.
COPY --from=webapp_build /src/apps/webapp/dist /opt/hermes/webapp_dist
ENV HERMES_WEB_DIST=/opt/hermes/webapp_dist

# Local speech-to-text for the browser mic (POST /api/audio/transcribe with
# stt.provider=local). faster-whisper + numpy are the server-side halves of
# the `voice` extra; sounddevice (server-local audio I/O) is irrelevant for
# the web path and would drag in PortAudio, so it is deliberately skipped.
# Cloud STT providers (groq/openai/mistral/xai/elevenlabs) need none of this.
RUN . /opt/hermes/.venv/bin/activate && \
    uv pip install --no-cache-dir faster-whisper numpy || \
    pip install --no-cache-dir faster-whisper numpy

# Web-terminal pane (/api/terminal): a browser-reachable login shell in the
# container. Enabled here because the shell is confined to the container
# (same trust boundary as the agent's own terminal tool); set to 0 to turn
# the pane off entirely.
ENV HERMES_DASHBOARD_TERMINAL=1

# Dashboard on in the supervision tree (see docker/s6-rc.d/dashboard/run);
# binds 0.0.0.0:9119 in-container — only Caddy publishes it outward.
ENV HERMES_DASHBOARD=1
