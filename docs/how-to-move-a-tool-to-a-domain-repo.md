# How to move a tool from core to a domain repo

The whole recipe for extracting an MCP tool (or a quick-answer/route/prompt) from
`trained-assist-agent` into its domain repo (`trained-assist-hh-skill`,
`trained-assist-sales-skill`, `software-engineering-playbooks`, …). Epic #1470.

## The rule that makes it one step

A tool name served by **both** core and a sibling resolves to the **sibling**
(`src/action-tool-catalog.js`, #1648; logged once as
`core tool X is also served by the Y sibling`). So the two PRs are **independent**:

1. **Domain repo PR** — add the tool, merge whenever it is green. Prod picks it up on
   the next core deploy (`deploy.sh ensure_sibling` syncs every sibling to `main`).
2. **Core PR** — delete the core copy, merge whenever it is green.

No pairing, no "merge them within minutes", no duplicate window. Two **siblings** with
the same name are still a hard `CONFLICT` (#1533) — don't move a tool into two repos.

## Domain repo PR

- Copy the tool file; keep the **tool names** (prompts, quick answers and users refer to them).
- Replace core requires with the repo's own helpers:
  - paths → the repo's `src/data-paths.js` (no `os.homedir()` outside it);
  - talking to core → HTTP with `AGENT_SECRET` (`POST /internal/publish`, `POST /internal/cron/jobs`), never `require` of core code.
- Every outbound HTTP call has a timeout; token files are written with mode `0o600`.
- Move the tool's tests with it.
- Prompt rules for the tool go to the repo's `src/prompt-domains/<name>.md` with
  `server: <mcpServerId>` — core reads prompt domains from every sibling.
- Repo-specific CI chores (hh-skill: action policy in `scripts/build-manifest.cjs`,
  L2 fixture in `fixtures/tools.json`, `npm run build:manifest` + `build-mcp-manifest`).

## Core PR

- Delete the tool file (and its prompt-domain file); remove it from
  `contracts/action-v1/core-tool-inventory.json`.
- `config/skill-catalog.json`: the section that listed `NN-tool.js` now lists
  `<mcpServerId>/<file>` (per-module gating) — or, if the section maps 1:1 to the sibling,
  just `siblings: [...]`. Once a sibling's modules are addressed, **all** of them must be
  listed (`test/skills-resolve.test.cjs` enforces it).
- Core code that used the module in-process (quick answers, routes) goes through the
  bridges: `hhLib('hh-…')` (`src/domains/hh/lib.js`) or `siblingLib(id, path)`
  (`src/domains/sibling-lib.js`) — guard per-message paths with `hhAvailable()` so a
  missing checkout only disables that domain.
- Tests that exercised the moved code in core: move them to the domain repo, or load
  the module through the bridge.

## A new domain repo

Start from `trained-assist-sales-skill` (lightweight: `npm run check` loads every tool,
`node --test`, and CI runs core's `scripts/check-mcp-conformance.js` — the gate
`deploy.sh` applies before moving a sibling in prod). Then in core: add it to
`SKILL_SIBLINGS` (`src/skill-siblings.js`), `ensure_sibling` in `scripts/deploy.sh`,
the CI sibling clone step, and a `servers` entry in `config/skill-catalog.json`.

## Before opening either PR

`gh pr list -R trained-assist/<repo> --state all --limit 15` — other sessions work on
this epic too; skip items already open or merged.
