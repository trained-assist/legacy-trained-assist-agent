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
| Quick-answer intents / hooks | e.g. `src/hh-intents.js`, `src/hh-vacancy-quick.js` | `runner/intent-engine.js` keeps only the order of checks and calls the hooks (`hhLib`, `siblingLib`) |
| Profile skill gating | catalog `modules: ["<server>/<file>"]` | `src/skills/{resolve,enforce}.js` mount the sibling if any enabled section needs one of its modules; the sibling registry skips `SKILLS_RESOLVED` hidden modules |
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
- [x] ApplyLink tools `applylink_*` (`96-applylink.js`)
- [x] quick-answer intents (`hh-intents.js`) and the vacancy-creation flow (`hh-vacancy-quick.js`)
- [x] prompt domains `hh`, `hh.setup`, `hh-notify`
- [ ] `97b-candidate-client-report` + `src/candidate-report.js`, `99-interview-analysis` + `95-video-analysis` (in-process coupling), `97b` also needs a publish API for domain repos; `98-demo` stays in core — its own catalog section, enabled per profile (vova, vova-recruiter) independently of recruiting
- Stays in core on purpose: HH OAuth (`/connect/hh/*`, `/hh-callback`, `connect-forms/hh.js`) — platform credential collection shared with other services

### sales-crm — `trained-assist-sales-skill`

- [x] repo created (lightweight CI: tools load, unit tests, core MCP-contract deploy gate); mounted as the `sales-skills` sibling (`src/skill-siblings.js`, `deploy.sh ensure_sibling`)
- [x] Weeek CRM `30-weeek` + prompt domains `weeek`, `weeek.setup` (catalog section `crm-weeek` mounts `sales-skills`)
- [x] expo / Flexi: `85-expo`…`89-expo-pipeline-run`, `92-flexi-sales` (+ `expo-paths`, `catalog-template`); `89` auto_cron reports schedules unavailable (#1489) instead of calling core's in-process `04-cron` (it was a no-op in prod)
- [x] company / INN: `40-company`, `70-inn-enrichment` (+ `inn-pipeline`), `71-dadata`, `72-checko`
- Catalog sections address these as `sales-skills/<file>`: `recruiting/company` mounts the sibling for company/INN only; the sibling registry hides modules of switched-off sections (`SKILLS_RESOLVED`)

### freelance — `trained-assist-freelance-skill` (repo exists)

- [ ] `94-outsource-project`, `62-business-analyst`

### engineering — `trained-assist-engineering` (repo exists)

- [ ] `60-github`, `61-dev`, `63-ci-cd`

### optional, by demand

- [ ] edu (`80-getcourse`, `81-gc-discovery`), finance (`10-nalog`), marketing (`20-tilda`, `95-illustrate`, `96-label`)
