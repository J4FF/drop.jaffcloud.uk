#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
export DROP_HOST="${DROP_HOST:-0.0.0.0}"
export DROP_PORT="${DROP_PORT:-8787}"
exec node server.js
