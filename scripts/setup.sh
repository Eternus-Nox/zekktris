#!/usr/bin/env bash
# Kept for anyone (and any doc) that still runs ./scripts/setup.sh — the
# installer at the repo root replaced it. It detects the network, opens router
# ports, writes .env and starts the stack; with an existing .env it only fills
# in what's missing.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/install.sh" "$@"
