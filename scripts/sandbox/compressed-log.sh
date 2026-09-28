#!/usr/bin/env bash
# Sandbox (S3+, ~15 s): «📋 Сжатый лог» end-to-end without a human — issue #1777.
#   agent: node --test test/session-digest.test.cjs  (real sqlite trace → digest → cache → endpoints)
#   web:   node test/web-digest.mjs                  (worker delegation + Playwright click)
# Usage: scripts/sandbox/compressed-log.sh [path-to-trained-assist-web]
#   (or WEB_DIR=...). Without a web checkout only the agent half runs.
set -u
cd "$(dirname "$0")/../.."
WEB_DIR="${1:-${WEB_DIR:-}}"
fail=0
echo "── agent: session-digest"
env -u OPENROUTER_API_KEY LLM_LADDER_URL=http://llm-ladder.invalid node --test test/session-digest.test.cjs || fail=1
if [ -n "$WEB_DIR" ]; then
  echo "── web: web-digest ($WEB_DIR)"
  (cd "$WEB_DIR" && node test/web-digest.mjs) || fail=1
else
  echo "── web: skipped (pass the trained-assist-web path as \$1 or WEB_DIR)"
fi
[ $fail = 0 ] && echo "SANDBOX PASS" || echo "SANDBOX FAIL"
exit $fail
