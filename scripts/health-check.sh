#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Effy — Health Check Script
# Usage: ./scripts/health-check.sh [host] [port]
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

HOST="${1:-localhost}"
PORT="${2:-3100}"

echo "🔍 Checking Effy at $HOST:$PORT..."

# HTTP health endpoint
if curl -sf "http://$HOST:$PORT/health" > /dev/null 2>&1; then
  echo "✅ HTTP health: OK"
else
  echo "❌ HTTP health: FAIL"
  exit 1
fi

echo "🎉 All checks passed."
