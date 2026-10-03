# OpenCode Configuration

`base.json` (MCP servers, the read-only `review` agent) + the profile's model routing →
`~/.config/opencode/opencode.json` (via `infra/opencode-switch-profile.sh`, machine-wide baseline).
Real task runs get the same shape per-invocation through `OPENCODE_CONFIG`
(`writeOpencodeMcpConfig` in `src/runner/claude-runner.js`).

## Models: the llm-ladder worker (issue #1687)

OpenCode runs use ONE provider, `ladder` — the trained-assist-llm-ladder Cloudflare Worker
(`https://llm-ladder.trainedassist.store/v1`, openai-compatible, key `{env:OPENCODE_LADDER_TOKEN}`,
which the runner injects per run). The model id per role is the worker's ladder id with the role:
`ladder/service:build`, `ladder/doctor:review`, `ladder/free:plan`.

Rung order, failover, per-model health, OpenCode Go key rotation and the paid OpenRouter tail all
live **only in the worker** (`config/ladders.json` in trained-assist/trained-assist-llm-ladder).
This repo keeps no ladder: `src/opencode-ladder-provider.js` only maps a profile to a ladder name.
If the worker is unreachable, the run fails with `worker_unreachable`; if every rung fails, with
`ladder_exhausted` — no in-process fallback.

| Profile | Worker ladder | Note |
|---------|---------------|------|
| `service` | `service` | default (`src/profiles.js`); playbook `bachelor`/`master` |
| `doctor` | `doctor` | playbook `doctor` fallback after claude → codex |
| `free` | `free` | cheap/free rungs |
| `russian` | `service` | service ladder + a strict Russian reviewer prompt |
| `research` | `research` | `hermes_research`: worker ladder, Go-first + paid tail (llm-ladder #28); was a flat `opencode-go` pin until the 2026-10-01 weekly-cap incident |

Profiles are named after the llm-ladder ladder (llm-ladder #49/#101). The retired names still
resolve on read — `deepseek`/`value` → `service`, `max` → `doctor` (`LEGACY_PROFILE_LADDER` in
`src/opencode-ladder-provider.js`) — and `/oc_<profile>` / `OPENCODE_PROFILE` accept them.

Switch: `/oc_<profile>` in Telegram (per profile, `src/runner/intent-engine.js`), or
`./infra/opencode-switch-profile.sh <profile>` / `OPENCODE_PROFILE` for the machine baseline.

## MCP in OpenCode

OpenCode does NOT support PostToolUse hooks (unlike Claude Code). This means:

- **compress-on-input** cannot run as a hook here — only via its `--wrap <cmd>` proxy mode, which
  wraps another MCP server's stdio and compresses results in transit. That's how **playwright**
  below is wired up.
- **trained-skills** MCP is not configured here — it is per-session context-dependent (needs
  USER_ID, WORK_DIR per user) and is injected by `src/runner.js` via a temp `.mcp.json` file.

The only global MCPs in base.json are **playwright** (browser automation, local) and **Neon**
(remote, database access — currently removed, see #812).

## Playwright (live)

```json
"playwright": {
  "type": "local",
  "command": ["compress-on-input", "--wrap", "npx @playwright/mcp --browser chromium"]
}
```

**`--wrap` takes ONE string, not separate argv tokens.** Passing `"npx", "@playwright/mcp",
"--browser", "chromium"` as four array elements makes `compress-on-input` parse `--browser` as
its own unknown flag and exit 0 without ever starting the MCP server — OpenCode then logs
`server unavailable key=playwright status=failed` and every model silently loses the tool. This
is exactly what happened in production until 2026-09-20; fixed by collapsing the wrapped command
into a single string element.

Verified end-to-end (`opencode run -m <model> --auto`) after the fix:
- Cheap/free Zen models (`nemotron-3.5-lightning-free`, `mimo-v2.5-free`) CAN drive
  navigate → snapshot → close correctly at $0 cost on simple pages — the earlier "free models
  can't use tools" impression was actually this config bug, not a model limitation.
- Free-tier reliability is inconsistent on less trivial prompts: same cheapest model truncated
  mid-thought and never called a tool on a slightly more complex ask. Don't route anything you
  need to actually complete to the free tier without a fallback/retry.
- `compress-on-input`'s DOM-snapshot compressor only trims ~12% on real pages (a Wikipedia
  article snapshot was 281k→248k raw tokens) — it's built for screenshots (~99% reduction) and
  JSON, not aria-snapshot YAML. Something downstream still truncates before the LLM call (actual
  request was ~281 input tokens for that step), but don't rely on compress-on-input alone to make
  heavy pages fit a small context window.
