#!/usr/bin/env bash
# Sandbox (S3, ~5 s): «Полный лог» + «Сжатый лог» honesty — issue #1893, plan 1cb1e1f9.
# Walks DL-10…DL-14 through the real blocks (web route → session-trace-store →
# readTrace fallback → session-digest) with an injected LLM and no network.
# Usage: scripts/sandbox/session-logs.sh
set -u
cd "$(dirname "$0")/../.."
if env -u OPENROUTER_API_KEY LLM_LADDER_URL=http://llm-ladder.invalid node --test test/session-logs-sandbox.test.cjs; then
  echo "SANDBOX PASS"; exit 0
else
  echo "SANDBOX FAIL"; exit 1
fi
