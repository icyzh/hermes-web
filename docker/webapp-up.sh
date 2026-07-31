#!/usr/bin/env bash
# One-command self-host for Hermes Web.
#
#   cp docker/webapp.env.example .env   # then edit credentials/domain
#   ./docker/webapp-up.sh
#
# Builds the stock hermes-agent image, layers the web UI on top, and starts
# the stack (hermes + Caddy TLS). Idempotent — rerun after a git pull to
# rebuild and restart.

set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
    echo "No .env found. Run:  cp docker/webapp.env.example .env  and edit it first." >&2
    exit 1
fi

COMPOSE=(docker compose -f docker-compose.webapp.yml)

# 1. The base image (repo-root Dockerfile) — the webapp image extends it.
"${COMPOSE[@]}" --profile build build hermes-base

# 2. The web UI layer + Caddy, then up.
"${COMPOSE[@]}" build hermes
"${COMPOSE[@]}" up -d hermes caddy

echo
echo "Hermes Web is starting."
echo "  https://$(grep -E '^HERMES_WEB_DOMAIN=' .env | cut -d= -f2- || echo localhost)"
echo "  logs: docker compose -f docker-compose.webapp.yml logs -f"
