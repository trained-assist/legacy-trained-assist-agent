# Testing playbooks

How to prove a playbook works — before it ships, and again after it changes.

What a playbook *is* (registry, schema, step contract, lifecycle, reachability): [`docs/playbooks.md`](playbooks.md).
This file is the **test** side of the same subject.

The standing assumption is the one the 2026-09-26 production-readiness audit ended with:
**"merged" ≠ "works in prod"**. Every local suite can be green while a promise is still
undelivered — that audit found registered validation keys that fell through to the LLM judge
and a role that was computed and then dropped, with no test noticing. Use the layers below in
order; each one catches a class the previous one cannot.

## Four layers

| # | Layer | Command | Proves | Cost |
|---|---|---|---|---|
| 1 | Unit + offline e2e | `npx vitest run tests/unit/playbook-*.test.js tests/unit/durable-*.test.js` | store, compiler, executor, validators, waits, finalization gate, restart re-queue | seconds, no network |
| 1b | Wiring suite | `node test/gtd-durable-wiring.test.cjs` | the real fire pipeline: draft gating, escalation, attempt budget, evidence, finalization | seconds, no network |
| 2 | Reachability | `npm run check:playbooks -- <id> [--all] [--strict]` | the chain that makes a playbook usable at all: resolve → schema → compile → sibling registration → dispatch → no-shadow (plus profile/audience gates) | offline, no LLM |
| 3 | Prod-readiness sim | `node docs/audits/playbook-prod-readiness-sim.cjs` | the whole pipeline on **real** modules (MCP registry, store, compiler, `runDueDurable`) with only network/LLM/engine boundaries faked | seconds, no network |
| 4 | Live e2e | `node scripts/e2e/playbooks-e2e.js …` | the process end to end **on real engines**, real GitHub, real PRs | minutes, spends models |

Run **1 → 2** on every change. Run **3** when the change touches execution
(`src/playbook-*.js`, `src/gtd-controller.js`, `src/durable-*.js`, validation keys). Run **4**
before calling a playbook finished — it is the only layer that executes real agent steps.

Layers **2 and 3 need the domain sibling checkouts to exist next to core**
(`<core>/../trained-assist-engineering`, `…-hh-skill`, `…-sales-skill`, `…-documents-skill`) —
core itself holds no playbooks, so a run from a bare checkout reports
`playbook "<id>" не найден` / `PLAYBOOK_NOT_FOUND` for reasons that have nothing to do with your
change. CI clones them next to core for exactly this reason; locally, either run from a checkout
that has its siblings or set `PLAYBOOK_SIBLING_ROOTS` to a directory holding them.

### Layer 1 — unit and offline end-to-end

```bash
npx vitest run tests/unit/playbook-*.test.js tests/unit/durable-*.test.js
node test/gtd-durable-wiring.test.cjs
```

`tests/unit/playbooks-offline-e2e.test.js` is the important one: it runs the three
engineering playbooks on the **real durable executor** — real compiler, store,
`runDueDurable`, durable waits and restart re-queue — with only the engines scripted and
GitHub faked. It is the regression net for everything the live e2e found (level → engine
routing, restart re-queue, one workspace per plan, `ci_green` through Actions runs,
`task_item_wait`). It reads the playbooks from the sibling
`software-engineering-playbooks` checkout — CI clones it next to core; locally it is picked
up automatically if the sibling is present, or set `PLAYBOOK_SIBLING_ROOTS=<dir>`.

### Layer 2 — reachability («доехал ли плейбук»)

```bash
npm run check:playbooks -- <id>          # one playbook (resolved across profile/sibling/system)
npm run check:playbooks -- --all         # every playbook visible to the store
npm run check:playbooks -- --all --strict --profile <name>   # + profile gates
npm run check:playbooks -- --repo <dir> --all --strict        # a domain repo, from its own CI
```

Schema, compile and conformance can each pass while the chain still breaks — 2026-09-28
the exhibition playbook was valid and its sibling mounted, but no prompt route led to it.
`--strict` accepts only a direct `playbook_run` pointer (route A1), so deleting the pointer
turns CI red. `--profile` adds `sections` / `sibling-mounted` / `section-enabled` /
`tools-visible` / `pointer-in-prompt`; `--audience` adds `audience-map`.

In a **domain repo's** CI (core checked out inside it as `.core`, which the sibling CIs do):

```bash
node .core/scripts/check-playbook-reachability.mjs --repo . --all --strict
```

The same logic is available as the `playbook_health(id?, audience?)` MCP tool inside a
running agent.

### Layer 3 — production-readiness simulation

```bash
node docs/audits/playbook-prod-readiness-sim.cjs
```

No HTTP, no LLM, no engine: temp SQLite, injected `runTask` / registry / `llmValidate`.
It prints the plan's status transition, item states, engine fires (programmatic steps must
**not** spawn one) and the validation rows. Keep it as the check when touching execution
semantics — it is what caught the delay-gating and injected-`now` ordering bugs.

### Layer 4 — live end-to-end

```bash
# on the VM that hosts the server (local backend; AGENT_SECRET from env or ~/secrets.env)
node scripts/e2e/playbooks-e2e.js start --playbook feature --goal "…" --repo owner/name
node scripts/e2e/playbooks-e2e.js run <plan> --every 20 --stall-min 15
node scripts/e2e/playbooks-e2e.js report <plan> --json --verbose

# from anywhere (a laptop, CI) over the /internal/e2e/* API — no SSH
node scripts/e2e/playbooks-e2e.js --remote https://host/agent status <plan>
```

Verbs: `start | status | report | list | cancel | kick | wake | run`.
`run` drives the plan in a loop and acts where a human normally would — answers
`awaiting_user` steps (`--auto-answer`), merges the green PR the plan waits on (`--auto-merge`),
stops on `done` / `failed` / stall, prints the report, and can `--record out.json` for replay.
`wake <step-id> --message "…"` answers a single waiting step by hand. The local backend
**ticks inside the server process** (`/internal/gtd/tick`), so a local run needs the server
running; `kick` forces a tick.

**Default level map is deliberately the cheap one:** `doctor → opencode service`,
`master → opencode free`, `bachelor → opencode free`. The e2e goal is that the *process* runs
end to end and every failure is visible — the quality of what the agents build is not the
point. Override per run with `--level-map '{…}'` or profile-wide with `PLAYBOOK_LEVEL_MAP`.

Every e2e plan runs in one workspace, branch `eng/<profile>-plan-<id8>` — that is how the
driver finds the open PR when a step's summary truncated its URL.

## CI and the merge gate

`.github/workflows/ci.yml` (this repo):

| Job | What | Role |
|---|---|---|
| `ci` | `npm ci` (siblings cloned next to core), `npm run check`, `npm run check:testkit`, `npm run lint`, `npm test`, agent-isolation e2e, env-sync + domain guard greps | blocks |
| `staging-gate` | `npm run test:staging` (replays mandatory user scenarios with Chromium) + `scripts/test-recruiter-nginx.py` | **blocks** — a red, missing, cancelled or skipped staging run blocks the merge |
| `merge` | auto-merges a non-draft PR whose `ci` **and** `staging-gate` are green | merge, no manual step |
| `autofix` | opens a fix PR when either gate fails | recovery |
| `deploy-gcp` / `deploy-ru` | on push to `main` | release |

Domain sibling repos run their own suites (unit / contract / behavior / guards / browser /
conformance) and gate a `staging-gate` job on all of them being green.

**Reachability is not in core CI.** `npm run check:playbooks` exists as a script and
`docs/playbooks.md` describes it as a gate, but no workflow in this repo invokes it; today
only `trained-assist-sales-skill` runs it (`node .core/scripts/check-playbook-reachability.mjs
--repo . --all --strict`). Until it is wired into core CI, **run layer 2 by hand** as part of
the loop below — it is the one gate that catches a playbook nobody can start.

## Standard loop

1. Edit the playbook JSON (or the executor/validator code).
2. Layer 1 (+1b) — if a step's `validation` is new, add its case to the wiring suite.
3. Layer 2 — `npm run check:playbooks -- <id>`, and `--strict` if the repo requires an A1 pointer.
4. Layer 3 — only when execution semantics changed.
5. Layer 4 — live run to `done`, or an explicit reason why the step is deliberately not green.
6. PR → `ci` + `staging-gate` green → auto-merge → deploy → (sibling repos) the live
   checkout of a domain repo is `fetch + reset --hard origin/main` on the next deploy.

## Pitfalls worth knowing

1. **A free model failing a step is an instruction bug, not a model bug.** Recorded decision:
   if the e2e level map's free agent can't complete a step, fix the playbook's wording —
   do not raise the model level to make the test pass. Raising the level hides the defect
   the cheap map exists to expose.
2. **Valid ≠ reachable.** Schema, compile and conformance say nothing about whether any
   prompt or button can start the playbook. Layer 2 is the only thing that checks it.
3. **`requires` is gated by `additionalProperties: false`.** A sibling playbook may use
   `requires` only after the core that accepts it is deployed — otherwise the live agent
   refuses the file outright. Deploy core first, sibling second.
4. **A stale `node_modules` fakes a red test.** The domain-repo contract suite validates the
   manifest against a JSON schema and needs `ajv`; on a checkout whose `node_modules` is
   shared or predates `npm install` it dies with `Cannot find module 'ajv'` **independently
   of your change** — it fails the same way on an untouched `main`. `npm ci` before trusting
   a local red; CI is the authority.
5. **The e2e level map is not the production one.** Production resolves `minimum_model_level`
   through `PLAYBOOK_LEVEL_MAP` / the plan's `execution_policy_json`; the e2e overrides both.
   A step that passes in layer 4 can still be routed differently in prod — check the report's
   `ran on` column against what you expect.
6. **Finalization is a gate, not a verdict.** A plan reaches `done` only when every
   acceptance validation passes. Don't write a validator that returns `pass` to make a run
   end; if a step legitimately can't check something yet, model it as `task_item_wait` (or a
   recorded fastpass) so the inconclusive state stays visible.
7. **Live sibling checkouts have no durable local work.** A deploy resets the domain repo
   checkout (e.g. `/home/vova/trained-assist-hh-skill`) to `origin/main`. Uncommitted changes
   there are destroyed on the next deploy — work in a branch and push, never in the live
   checkout.

## Related

- [`docs/playbooks.md`](playbooks.md) — registry, step contract, lifecycle, reachability gates
- [`docs/engineering-playbook-persistence.md`](engineering-playbook-persistence.md) — durable plans, waits, restart
- epic `#1372` (playbooks) + sub-issue `#1573` — the phased plan this test strategy serves
