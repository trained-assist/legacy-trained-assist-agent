# Domain-skill migration control plane

Human checklist for where each domain skill is served. The machine-readable
source of truth is [`domain-skill-migration.json`](./domain-skill-migration.json);
this file is derived from it and states, per domain, whether the skill is
`planned` / `core-only` / `dual` / `domain-only` / `retired`.
Tracked by epic [#1511](https://github.com/trained-assist/trained-assist-agent/issues/1511);
execution inventory in [#1470](https://github.com/trained-assist/trained-assist-agent/issues/1470).

> **Field naming:** `domainName` is the human domain label; `domain`
> (`yes` / `unverified` / `no`) is the tri-state "mounted through the sealed
> control plane + live canary green" flag. They are different fields on purpose
> (the status model names the capability flag `domain`).

## Status model

Two orthogonal capability axes plus one switch:

| Field | Values | Meaning |
|-------|--------|---------|
| `plan` | `planned` / `in-progress` / `done` / `dropped` | is the extraction planned? |
| `core` | `yes` / `no` | implemented and mounted in this repo |
| `domain` | `yes` / `unverified` / `no` | mounted via `MCP_SKILL_SOURCES_CONFIG` **and** live canary green |
| `serving` | `core` / `domain` | **the switch**: which path actually serves users |

Derived human state:

| State | Condition |
|-------|-----------|
| `planned` | neither `core` nor `domain` |
| `core-only` | `core=yes`, `domain!=yes` |
| `dual` | `core=yes`, `domain=yes`, `serving=core` (strangler/canary phase) |
| `domain-only` | `serving=domain` (cutover done) |
| `retired` | `plan=dropped` / removed from core |

**Why `dual` is allowlist-only.** `src/mcp-skill-source-registry.js` rejects
ALL members of an id/provider/server/action-name collision and core providers
win over external sources. So "both for everyone at once" is impossible; `dual`
is only valid with the domain source mounted to a sandbox profile via the
`profiles` allowlist, while core serves everyone. That is a model constraint,
not a bug — the `serving` switch captures it.

**Sandbox profile.** Canaries use one shared all-integrations sandbox profile,
`trained-assist-product-owner` (`defaultCanaryProfile`), matching
`scripts/staging/canaries/hh.json` and `OWNER_USERNAME`. Per-skill
`canaryProfile` records which profile a source is mounted to. Add a second
profile only if a genuinely clean sandbox is ever needed.

## Current matrix

| Skill | Domain | Repo | core | domain | serving | State |
|-------|--------|------|:----:|:------:|:-------:|-------|
| `hh` | recruiting | `trained-assist/trained-assist-hh-skill` | yes | yes | core | **dual** |
| `expo` | sales-crm | `trained-assist/trained-assist-sales-skill` | yes | no | core | core-only |
| `outsource` | freelance | `trained-assist/trained-assist-freelance-skill` | yes | unverified | core | core-only |
| `engineering` | engineering | `trained-assist/trained-assist-engineering` | yes | unverified | core | core-only |
| `getcourse` | edu | `trained-assist/trained-assist-edu-skill` | yes | no | core | core-only |
| `nalog` | finance | `trained-assist/trained-assist-finance-skill` | yes | no | core | core-only |
| `marketing` | marketing | `trained-assist/trained-assist-marketing-skill` | yes | no | core | core-only |

## Per-domain checklist

### recruiting — `hh`

- [x] core implementation mounted (`93-calltips`, `96-recruiter-tools`, `99-interview-analysis`, `97b-candidate-client-report`, `41-applylink`, `98-demo`)
- [x] sealed domain source mounted on `trained-assist-product-owner` (`scripts/staging/canaries/hh.json`, pinned `2d194cd4a65f9ff3888aacdeea87afc33b0971b4`)
- [x] live canary green (#1463/#1466)
- [ ] cutover `serving: core -> domain` for real profiles (P0.1/#1470)
- [ ] remove duplicated `src/hh-*.js` once core consumers go shim (#1470 P1.3)

State: **dual** (domain canary-mounted to sandbox, core serves everyone).

### sales-crm — `expo`

- [x] core implementation mounted (`30-weeek`, `85-expo`…`89-expo-pipeline-run`, `92-flexi-sales`, `40-company`, `70-inn-enrichment`, `71-dadata`, `72-checko`)
- [ ] characterisation L2 tests in core first (#1470 P2.1)
- [ ] `trained-assist-sales-skill` repo + manifest + canary spec
- [ ] cutover `serving -> domain`

State: **core-only**.

### freelance — `outsource`

- [x] core implementation mounted (`94-outsource-project`)
- [x] `trained-assist-freelance-skill` repo exists (sibling mount)
- [ ] sealed source + canary spec (`scripts/staging/canaries/outsource.json`)
- [ ] cutover `serving -> domain`

State: **core-only** (`domain: unverified` — repo mounted by sibling checkout, not yet by the sealed control plane).

### engineering — `engineering`

- [x] core implementation mounted (`60-github`, `61-dev`, `62-business-analyst`, `63-ci-cd`)
- [x] `trained-assist-engineering` repo exists (#1418, sibling mount)
- [ ] sealed source + canary spec (`scripts/staging/canaries/engineering.json`)
- [ ] cutover `serving -> domain`

State: **core-only** (`domain: unverified`).

### edu — `getcourse` (optional)

- [x] core implementation mounted (`80-getcourse`, `81-gc-discovery`)
- [ ] repo + canary when there is demand (#1470 P4)

State: **core-only** (planned, low priority).

### finance — `nalog` (optional)

- [x] core implementation mounted (`10-nalog`)
- [ ] repo + canary when there is demand (#1470 P4)

State: **core-only** (planned, low priority).

### marketing — `tilda` / `illustrate` / `label` (optional)

- [x] core implementation mounted (`20-tilda`, `95-illustrate`, `96-label`)
- [ ] repo + canary when there is demand (#1470 P4)

State: **core-only** (planned, low priority).

## The switch: prepare → activate → rollback

`serving` is changed **without code**, by editing the admin config. The full
runbook lives in
[`docs/architecture/mcp-skill-sources.md`](../architecture/mcp-skill-sources.md);
the short version:

```sh
# 1. prepare: build immutable release from a clean checkout at the pinned SHA
node scripts/prepare-mcp-skill-artifact.js prepare options.json > approved-source.json

# 2. activate: publish a whole config {version:1, sources:[...]} including
#    the new source with enabled:true and an explicit profiles allowlist.
#    activate validates, fsyncs and atomically renames; the previous config is
#    retained as <configPath>.<sha256>.previous.
node scripts/prepare-mcp-skill-artifact.js activate activation.json
```

Flipping a skill **core → domain** (cutover):

1. Set the matrix entry `serving: "domain"` in `domain-skill-migration.json`.
2. Add the source to the active config with `enabled: true` and
   `profiles: ["<canaryProfile>"]` (starts with the sandbox profile only).
3. `scripts/check-migration-matrix.mjs` now requires both to agree.
4. Widen `profiles` as confidence grows.

Flipping **domain → core** (rollback):

1. Re-activate the retained previous whole config
   (`<configPath>.<sha256>.previous`), or publish an empty `sources: []`.
2. Set the matrix entry `serving: "core"`.
3. Run `node scripts/check-migration-matrix.mjs` — must be green.

The checked-in `config/mcp-skill-sources.json` ships empty (`sources: []`), so
production keeps using the core path until an admin activates a source. A
config path that is set but unreachable is an error — the runtime does not
silently fall back to sibling mounts for a source that is declared in the
admin config.

## CI gate

`scripts/check-migration-matrix.mjs` (wired into `.github/workflows/ci.yml`) is
dependency-free and offline. It fails on drift:

- `core: yes` → every `coreTools[]` file exists under `src/mcp-skills/tools/`;
- `domain: yes` → `scripts/staging/canaries/<skill>.json` exists;
- `serving: domain` → `config/mcp-skill-sources.json` has the source with
  `enabled: true` and a non-empty `profiles` allowlist containing `canaryProfile`;
- basic invariants: valid enums, no duplicate skills, `serving: core` needs
  `core: yes`, explicit non-`*` `canaryProfile`.

Run locally: `node scripts/check-migration-matrix.mjs`
(tests: `node --test test/check-migration-matrix.test.cjs`).
