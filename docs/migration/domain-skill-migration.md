# Domain-skill migration

Where each domain's code lives. Tracked by epic
[#1470](https://github.com/trained-assist/trained-assist-agent/issues/1470).

## Model (since 2026-09-27)

One copy of a domain's code, in its own repo (`trained-assist-<domain>-skill`,
or `trained-assist-engineering`). The repo is checked out next to core;
`scripts/deploy.sh` syncs it to `main` (after the MCP contract check) and links it
next to every release. Core uses it in four ways — the **domain module contract**:

| Part | Where in the domain repo | How core uses it |
|------|--------------------------|------------------|
| MCP tools | `src/mcp-skills/tools/*.js` | `src/browser.js` mounts the sibling MCP server in each session's `.mcp.json`; `src/mcp-action.js` spawns it for `/action`, cron and host-only actions |
| HTTP routes | e.g. `src/hh-routes.js` | `server.js` mounts them for the domain's path prefix via the bridge (`hhLib('hh-routes')`) |
| Quick-answer intents / hooks | e.g. `src/hh-intents.js`, `src/hh-vacancy-quick.js` | `runner/intent-engine.js` keeps only the order of checks and calls the hooks |
| Prompt rules | `src/prompt-domains/*.md` | `src/prompt-domains/index.js` reads them from every sibling repo in `config/skill-catalog.json` |

Missing/broken checkout → only that domain fails; core starts and serves everything
else (`test/hh-lib-bridge.test.cjs`).

There is no second serving path any more: the sealed-source / dual-serving
machinery (per-profile allowlists, pinned artifacts, canaries, the migration
matrix) was removed — it pinned the owner's working profile to a month-old HH
revision and hid current tools from it.

## Status

### recruiting — `trained-assist-hh-skill`

- [x] all `src/hh-*.js` domain code (single copy; core reaches it via `src/domains/hh/lib.js` `hhLib()`)
- [x] HH MCP tools (`90`–`95`), incl. `calltips_*` and recruiter text tools
- [x] HTTP routes `/hh/*`, `/api/hh/*`, `/calltips-*` (`hh-routes.js`)
- [x] quick-answer intents (`hh-intents.js`) and the vacancy-creation flow (`hh-vacancy-quick.js`)
- [x] prompt domains `hh`, `hh.setup`, `hh-notify`
- [ ] `97b-candidate-client-report` + `src/candidate-report.js`, `99-interview-analysis` (used by `95-video-analysis`), `41-applylink`, `98-demo` — each is its own section in `config/skill-catalog.json`, so moving them needs per-module gating inside the sibling first
- Stays in core on purpose: HH OAuth (`/connect/hh/*`, `/hh-callback`, `connect-forms/hh.js`) — platform credential collection shared with other services

### sales-crm — planned `trained-assist-sales-skill`

- [ ] `30-weeek`, `85-expo`…`89-expo-pipeline-run`, `92-flexi-sales`, `40-company`, `70-inn-enrichment`, `71-dadata`, `72-checko` (+ `src/inn-pipeline/`)

### freelance — `trained-assist-freelance-skill` (repo exists)

- [x] `94-outsource-project` removed from core — its successor `freelance_*` tools live in freelance-skill; the only profile with legacy `outsource-projects/` data was migrated by `scripts/migrate-outsource.js` (dry-run on prod: 3/3 already in index)
- stays in core: `62-business-analyst` (depends on the platform `playbook-store`)

### engineering — `trained-assist-engineering` (repo exists)

- [ ] `60-github`, `61-dev`, `63-ci-cd`

### optional, by demand

- [ ] edu (`80-getcourse`, `81-gc-discovery`), finance (`10-nalog`), marketing (`20-tilda`, `95-illustrate`, `96-label`)
