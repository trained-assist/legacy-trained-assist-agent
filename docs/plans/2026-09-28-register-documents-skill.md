# Plan: Register documents-skill + move gdrive out of core

## Context

`trained-assist-documents-skill` was built and green (deck, doc-export, gdrive, prompt
domains, playbooks) but core never loaded it: no entry in `skill-siblings.js`, no catalog
server, no `ensure_sibling` call, no CI clone, no checkout on the host. Everything
document-related was still served by core's `50-gdrive.js`.

The recipe this follows is `docs/how-to-move-a-tool-to-a-domain-repo.md`. The domain half
of the migration was already merged on 2026-09-27 (deck + doc-export + gdrive live in the
sibling); this PR is the core half.

## Load points (all six, not four)

Wiring a sibling means satisfying every point that decides whether core reaches it:

| # | File | What it gates |
|---|------|---------------|
| 1 | `src/skill-siblings.js` | `presentSiblings()` → browser.js MCP mount, mcp-action headless transport, cron registry |
| 2 | `config/skill-catalog.json` | `servers` entry + which sections own the modules and prompt domains |
| 3 | `scripts/deploy.sh` | `ensure_sibling` — clone/sync + link the checkout into `<releases>/` |
| 4 | `.github/workflows/ci.yml` | sibling clone so CI can resolve the domains it declares |
| 5 | `src/prompt-domains/*.md` | `loadDomains()` reads core first and skips same-named files, so a stale core copy silently wins |
| 6 | `src/playbook-store.js` | `DEFAULT_SIBLING_REPOS` — domain playbooks (`presentation-creation`, `freelance-project-spec`) |

Point 4 is not optional here: `test/skills-resolve.test.cjs` requires every prompt domain
a section declares to be resolvable and owned, and `gdrive`/`presentations` ship only in
the sibling once the core copy is deleted.

## What changes

**Register**
- `src/skill-siblings.js` — `documents` → `trained-assist-documents-skill` / `documents-skills`.
- `config/skill-catalog.json` — `documents-skills` server; `gdrive` section points at
  `documents-skills/50-gdrive.js`; new `documents` section owns `10-deck.js`,
  `20-doc-export.js` and the `presentations` prompt domain.
- `scripts/deploy.sh` — `DOCUMENTS_SKILL_DIR` + `ensure_sibling trained-assist-documents-skill`,
  followed by a hard check on the checkout. `ensure_sibling` only warns on a failed clone,
  and core no longer ships these tools, so a silent miss would drop the whole Google Drive
  domain from prod. The check sits before `trap on_deploy_error ERR` and before the release
  is activated — exiting there leaves the previous release serving.
- `.github/workflows/ci.yml` — clone `trained-assist-documents-skill` in both jobs.
- `src/playbook-store.js` — `trained-assist-documents-skill` in `DEFAULT_SIBLING_REPOS`.

**Move** (per the recipe)
- delete `src/mcp-skills/tools/50-gdrive.js`
- delete `src/prompt-domains/gdrive.md` (its `server: trained-skills` front matter would
  otherwise shadow the sibling's and hide the domain from the system prompt)
- drop `"50-gdrive.js"` from `contracts/action-v1/core-tool-inventory.json`
- `src/runner/quick/secrets.js` — `deleteServiceAccount` now comes from
  `siblingLib('documents', 'src/gdrive/google-auth')`, resolved per call so a missing
  checkout skips the GCP delete instead of breaking the revoke reply
- delete `playbooks/freelance-project-spec.json` (now owned by the sibling)

**Deliberately not touched**
- `src/mcp-skills/tools/62-business-analyst.js` stays whole. It carries five `ba_*` tools
  of which only `ba_client_spec_template` and `ba_export_client_doc` are document-export;
  the other three (`ba_clarify_requirements`, `ba_write_spec`, `ba_development_playbook`)
  are spec/task-setting, not documents. Cutting them is a product decision, not part of a
  migration, and belongs in its own PR after `doc_export` is verified as a real replacement.

## Regression guard

`test/sibling-wiring.test.cjs` pins the four places a sibling can be written but never
reachable — the state documents-skill sat in until this PR:

1. `SKILL_SIBLINGS` ↔ `catalog.servers` agree on ids and repos;
2. every sibling has a real (uncommented) `ensure_sibling <repo>` in `scripts/deploy.sh`;
3. `DEFAULT_SIBLING_REPOS` covers every sibling's playbooks;
4. a prompt domain core does not ship itself requires that sibling cloned in CI.

A commented-out `ensure_sibling` is not a call — the check strips shell comments first.

## Verification

- `npm run check`, `npm run lint` clean.
- `npm run test:cjs`: 122/124 files pass; the two failures are host artifacts
  (`agent-isolation` expects `ta-agent-N` to *not* pre-exist, `hermes-research-longrun`
  hits a stale `/tmp/agent-keepalive` file owned by another slot).
- `test/skills-resolve.test.cjs`, `test/skills-enforce.test.cjs`,
  `test/system-prompt-diet.test.cjs`, `test/sibling-wiring.test.cjs` all pass with the
  five-sibling catalog.
- Authoritative run is CI: `ci` + `staging-gate` both clone the new sibling.

## Superseded

Replaces #1727, which was branched off a stale `fix/cross-slot-acl-mask`, carried an
already-merged ACL fix, never triggered CI, and lacked load points 3, 4 and 5 — merging it
as-is would have deleted core `gdrive_*` without planting the checkout.
