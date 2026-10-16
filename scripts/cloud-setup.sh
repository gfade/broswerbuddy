#!/usr/bin/env bash
# Setup for Claude Code cloud / any Linux box: dependencies + headless Chromium.
set -euo pipefail
cd "$(dirname "$0")/.."
node --version
npm ci --no-audit --no-fund || npm install --no-audit --no-fund
npx playwright-core install --with-deps chromium || npx playwright-core install chromium
[ -f .env ] || cp .env.example .env
echo "setup done: fill .env (or environment variables) from .env.example, then run: npx tsx packages/llm/scripts/smoke.ts"
