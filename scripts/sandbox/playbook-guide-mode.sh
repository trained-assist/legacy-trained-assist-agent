#!/usr/bin/env bash
# Sandbox (S3, ~5 s): playbook_run «гайд» mode end-to-end through the real MCP handler —
# issue #1894 (epic #1887 п.1). Temp USERS_DIR/AGENT_DATA_DIR, fixture development playbook,
# real SQLite durable store and the real GTD checklist parser; no network, no LLM.
# Covers: default→guide in Telegram; second in same chat→background (not bound to session);
# explicit background; web/s-plan-* stay background; MODE_CONFLICT; gates protected; rollback flag.
# Plus the existing playbook_run suite as the background-path regression.
set -u
cd "$(dirname "$0")/../.."
NODE_ENV= npx vitest run tests/unit/playbook-run-guide.test.js tests/unit/playbook-run.test.js
rc=$?
[ $rc = 0 ] && echo "SANDBOX PASS" || echo "SANDBOX FAIL"
exit $rc
