# OpenCode Configuration

`base.json` + a profile from `profiles/` → `~/.config/opencode/opencode.json` (via `infra/opencode-switch-profile.sh`).

## Profiles

Consolidated from 6 to 4 in issue #1061 — each profile is now a **ladder** of models per agent
role (`build`/`plan`/`explore`/`general`/`review`), not one fixed model. `src/opencode-ladder.js`
resolves the ladder per invocation, degrading to the next rung on quota/rate-limit errors and
skipping rungs that need one-time manual account setup (e.g. Go "Global regions"). See
`MODEL-LADDER.md` for the current rung order and the reasoning behind it.

| Profile | Use case |
|---------|----------|
| `max` | Default — top rung is OpenCode Go (GPT-6/5.6 Luna family), degrades down to paid DeepSeek. Needs `OPENCODE_GO_API_KEY` (GCP only, see below) for its top rungs. |
| `value` | Economical but not free — DeepSeek/GLM/Qwen ladder |
| `free` | Zero cost — only `:free`-tier models, cycles through several |
| `russian` | Russian-language tasks (recruiting and beyond) — GigaChat Pro/Ultra/Max ladder |

The old `quality`/`mimo`/`lavish-luna`/`russian-recruiter` profiles were folded into `max`/`value`/
`russian`'s ladders as rungs rather than staying standalone profiles — `/oc_quality` etc. now
returns a redirect message instead of switching (see `OC_PROFILE_INTENT` in
`src/runner/intent-engine.js`).

Switch: `./infra/opencode-switch-profile.sh <profile>` (or set `OPENCODE_PROFILE` in `secrets.env`)
sets the machine-wide baseline (first rung of each role) — actual per-task invocations resolve
the full ladder via `src/opencode-ladder.js` and override this per-invocation. `/oc_<profile>`
in Telegram switches per-profile instead (see `src/runner/intent-engine.js`).

## `deepseek` — shared uniform profile + Go/OpenRouter toggle (issue #1096)

`max`/`value`/`russian`/`free` are per-role ladders scoped to a single trained-assist profile
(each is one VM user's own `ocProfile` choice). `deepseek` is different on both axes:

- **Uniform, not laddered.** `deepseek-go.json` and `deepseek-openrouter.json` each set one flat
  `model` — the same model on every role, deliberately, because the 3-person team sharing the
  OpenCode Go subscription wanted one dead-simple daily driver, not a per-role waterfall.
- **Global, not per-profile.** The team confirmed empirically that the Go subscription's rate
  limit is account-wide, not per-model (heavy `grok-4.7` use exhausted a completely unrelated Go
  model too) — so which gateway backs `deepseek` is ONE piece of state for the whole VM
  (`src/opencode-go-toggle.js`, `~/.config/opencode/go-mode.json`), not per trained-assist
  profile like `ocProfile` is. Every profile that has selected `deepseek` (`/oc_deepseek`) reads
  the same toggle.

| Command | Effect |
|---------|--------|
| `/oc_deepseek` | Select the shared `deepseek` logical profile for *your* trained-assist profile (like any other `/oc_*`) — follows the VM-wide toggle below |
| `/oc_go` | Manually point the VM-wide toggle at `opencode-go/deepseek-v4.1-flash` — sticks until changed again, affects everyone on `deepseek` |
| `/oc_openrouter` | Manually point it at `openrouter/deepseek/deepseek-v4-flash-0731` — sticks until changed again, affects everyone on `deepseek` |
| `/oc_ds_go` (`/oc_deepseek_go`) | Pin *your* profile straight to the `deepseek-go` file — ignores the VM-wide toggle, unaffected by `/oc_go`/`/oc_openrouter` |
| `/oc_ds_or` (`/oc_deepseek_openrouter`) | Pin *your* profile straight to the `deepseek-openrouter` file — ignores the VM-wide toggle, unaffected by `/oc_go`/`/oc_openrouter` |

On a Go usage-limit error (`opencode-ladder.js`'s `classifyError` catching e.g. "Go usage limit
exceeded") while running on `opencode-go/*` under the `deepseek` profile, the toggle **auto**-flips
to `openrouter` and the task retries immediately; an auto-flip reverts to `go` on its own after
~5h (the Go console's reported reset window) unless a human already flipped it manually in the
meantime. A manual `/oc_go`/`/oc_openrouter` never auto-reverts.

## OpenCode Go credential (max profile)

`opencode/*` (Zen) and `opencode-go/*` (Go) are separate providers with separate billing —
a Zen API key does NOT unlock Go models and vice versa. `max.json`'s top rungs use
`opencode-go/*`, which needs a Go subscription service-account key.

OpenCode has no env-var auth for either of these providers — only `opencode auth login`
(interactive, browser OAuth) writes `~/.local/share/opencode/auth.json`, which doesn't work
on a headless VM. Instead, `infra/opencode-switch-profile.sh` writes that file directly from
the `OPENCODE_GO_API_KEY` secret (see `infra/env-manifest.json`) on every deploy, merging it
with whatever auth.json already has so other providers' credentials survive.

Get the key from opencode.ai → Go-Subscription → create a service account (not the personal
OAuth key — that one is tied to interactive login and isn't meant for automation).

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
