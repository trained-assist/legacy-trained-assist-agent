# Playbooks

Versioned, machine-checkable process artifacts (issue #1372). A playbook compiles into a durable
plan; the plan executes step by step with a per-step executor contract. This file is the registry
overview; the schema is `contracts/playbook.schema.json`.

## Registry & resolution

`PlaybookStore` resolves a playbook id at the highest-precedence level that has it:

```
1. profile custom : ~/users/<profile>/playbooks/<id>.json   (scope "profile")
2. sibling repo   : <repo-parent>/<domain-skill-repo>/playbooks/<id>.json   (scope "system")
3. system repo    : <this repo>/playbooks/<id>.json          (scope "system")
```

- The file location — not the declared `scope` field — is authoritative; a mismatch is an error.
- Repo-owned levels (sibling/system) are immutable from chat: change them via PR. A profile
  override can shadow a repo playbook; `playbook_save` numbers it above what it overrides.
- A running plan pins `{playbook_id, playbook_version}`, so editing a playbook never mutates an
  already-started task.

Tools (`src/mcp-skills/tools/102-playbooks.js`):

| Tool | What |
|---|---|
| `playbook_list` | visible playbooks at their winning level |
| `playbook_get` | full playbook + prompt render (or a draft) |
| `playbook_suggest` | suggested default playbook for an audience (read-only) |
| `playbook_draft` / `playbook_edit` / `playbook_save` | authoring via Hermes (P1) |
| `playbook_run` | compile playbook + goal → **draft** durable plan (P2) |

## Step contract

Each agent step declares:

- `executor_role`: `researcher | developer | reviewer | verifier`
- `minimum_model_level`: `bachelor | master | doctor`
- `context_budget`: `small | medium | large`
- `validation`: a non-empty, machine-checkable object
- `max_attempts`, `execution_timeout_seconds`, `delay_after_sec` (optional; defaults apply)

Objective checks are `execution_kind: programmatic` (no engine). The runtime resolves role/level/
budget to a concrete `{engine, ocProfile, ocRole}` (`src/playbook-executor.js`): with the default
level map **bachelor and master both run opencode `service`** (owner 2026-09-27 — the old
`value`/`max` profiles led to paid OpenRouter), doctor → claude with a cross-engine fallback
(claude → codex → opencode `doctor`). `checklist.md` renders each item as
`[role/level/budget]` (or `[programmatic]`).

### Known contract gaps (as of 2026-09-30, audit #1914)

- **`context_budget` is currently a no-op** — `resolveStepExecution` always returns
  `skipModels: []`; the field is validated and rendered but does not yet select models
  (open question of executor P3b). Do not rely on it to shrink a step's context.
- **Level escalation needs a distinct rung.** `nextDistinctLevel` only bumps the level when the
  resolved engine/profile actually changes; with the default map bachelor = master = `service`
  and doctor resolves to Claude (never auto-spent, #1899), so quality escalation on the default
  map retries at the same rung. Plans that want a real bump override `execution_policy.level_map`.
- **OpenCode ignores the role as an agent selector.** `researcher→explore` / `reviewer|verifier→review`
  map to OpenCode *subagents*, which fall back to the default agent (`--agent` is not a primary
  selector); the role still picks the ladder model. Track before relying on role-based routing.

## Lifecycle

```
playbook_run → draft plan → task_update status=active → tick claims items →
(programmatic: registry validation; agent: engine run) → validation/evidence rows →
finalizePlan (only when every acceptance validation passes)
```

- **Activation is explicit.** A draft plan is not claimable; the user says "запускай".
- **Validation modes** (`validation_mode`): `programmatic` (deterministic only),
  `programmatic+llm` (default; cheap LLM judge where no deterministic validator exists),
  `programmatic+llm-fastpass` (loosest; a recorded escape hatch). Resolution: per-step > per-plan
  (`execution_policy_json`) > env `PLAYBOOK_VALIDATION_MODE` > default.
- **Recovery** (P3c): a failing step is classified and recovered via the fixed table in
  `src/recovery-policy.js` (ladder advance / provider switch / backoff), bounded.
- **Hooks** (P4): `notify | check | create_issue | publish` fire at stage/step boundaries;
  external side effects require consent, otherwise the hook is logged as skipped.

## Audience default

`AUDIENCE_DEFAULT_PLAYBOOK` pre-selects a playbook per bot surface (suggestion only — never
auto-runs). Precedence: env `AUDIENCE_DEFAULT_PLAYBOOK` (JSON) → `config/audience-default-playbooks.json`
→ built-ins. Built-ins:

```json
{ "freelance": "freelance-project-spec",
  "exhibition": "exhibition-catalog-to-sales-site",
  "development": "feature",
  "default": "feature" }
```

## Adding a system playbook

1. Author a draft: `playbook_draft` → `playbook_edit` (drafts are profile-scope).
2. For a repo/system playbook, open a PR adding `playbooks/<id>.json` (`scope: "system"`), validated
   by the schema and compiling cleanly (`compilePlaybook`).
3. Update the audience map in `config/audience-default-playbooks.json` if it should be a default.
4. Make it reachable and prove it: a prompt domain of the owning repo must lead the agent to
   `playbook_run(playbook_id: "<id>", …)` (route A1), then run
   `npm run check:playbooks -- <id> [--profile <name>] [--audience <a>]` (see below).

Domain playbook content lives in the owning sibling repo, not in core `playbooks/`: a core copy
of a sibling id is shadowed at resolve time and silently never applies.

## Reachability check

`scripts/check-playbook-reachability.mjs` (`src/playbook-reachability.js`, issue #1756) answers
«доехал ли плейбук» in one run, offline, no LLM. Schema/compile/conformance can each pass while the
chain still breaks — 2026-09-28 the exhibition playbook was valid and its sibling mounted, but no
prompt route led to it. Gates: `resolve`, `schema-scope`, `compile`, `sibling-registration`
(skill-catalog + `DEFAULT_SIBLING_REPOS`), `dispatch`, `no-shadow`; with `--profile` also
`sections`, `sibling-mounted`, `section-enabled`, `tools-visible`, `pointer-in-prompt`
(`skills.resolve()` for that profile); with `--audience` also `audience-map`. `--all` checks every
visible id. Exit 1 on any FAIL.

In a domain repo's CI (core checked out inside it as `.core`, as the sibling CIs already do):

```bash
node .core/scripts/check-playbook-reachability.mjs --repo . --all --strict
```

`--repo` reads the repo's own playbooks, prompt domains and tools from its checkout (core's
`<core>/../<repo>` sibling lookup misses that layout). `--strict` accepts only a direct A1
pointer, so deleting the pointer turns the repo's CI red.

### `requires` and `playbook_health`

A playbook may declare what it needs from a profile (optional, additive):

```json
"requires": { "sections": ["flexi-expo"], "tools": ["expo_find_participants", "playbook_run"] }
```

The `requires` gate checks that every section exists in `config/skill-catalog.json` and every
tool is defined by some tools module (`<name>: {` in core or a sibling `src/mcp-skills/tools/*.js`).
With a profile, `section-enabled` / `tools-visible` then key on exactly these sections and the
modules defining these tools (hard FAIL). Without `requires` they guess from the section carrying
the A1 pointer. **Order matters:** the schema has `additionalProperties: false`, so a sibling
playbook may use `requires` only after the core that accepts it is deployed. Otherwise the
live agent refuses the file.

`playbook_health(id?, audience?)` (MCP, `102-playbooks.js`) runs the same check for the calling
profile inside the agent. Exposure comes from the run record `.skills-resolved.json` (real probed
readiness) when present. Omit `id` to check every visible playbook.

`dispatch` routes: **A1** prompt domain names `playbook_run` + `"<id>"` (strong); **A2** id next to
"playbook/плейбук" in a prompt domain; **B** audience map; **E** dev-task auto-offer
(`ENGINEERING_FAMILY`, only when `DEV_TASK_RE` matches); **C** a tools module names it (list_skills);
**F** the owning repo's code launches it (a UI button, e.g. the hh recruiting hub — reachable, but not
from chat). A2/B/E/C/F pass with a warning; none of them → FAIL.

## Current playbooks

Core `playbooks/` holds none; playbooks live in the domain sibling that owns their tools.

| id | repo | purpose |
|---|---|---|
| `feature`, `debugging`, `new-software` | software-engineering-playbooks (checked out as `trained-assist-engineering`) | engineering delivery; offered by `src/dev-task-playbook-suggestion.js` |
| `exhibition-catalog-to-sales-site` | trained-assist-sales-skill | exhibition catalog → registry check → sales site |
| `recruiting-vacancy-launch` | trained-assist-hh-skill | vacancy launch; started by the recruiting hub «▶ Собрать» button |
| `freelance-project-spec`, `presentation-creation` | trained-assist-documents-skill | freelance intake → GO/NO-GO; presentation |
