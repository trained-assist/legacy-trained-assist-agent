# Core 04 — Durable plan artifacts (one artifact root)

Issue #1861. A durable plan (GTD/playbook task) must have ONE place where its
steps put artifacts and where its deterministic checks look for them. Before this
scenario an agent step spawned an engineering git-workspace and committed the
artifact there, while `file_exists` / `command_exit_zero` resolved relative paths
from the plan's project folder — the next step read a file that was not there and
the plan parked forever. The same root had two more holes: a failed deterministic
check on an agent step was swallowed (`DURABLE: done` completed the step anyway),
and a terminally failed step could not be restarted after the cause was fixed.

Status legend: `implemented` = runtime behaviour, covered by the automated test
named in Validation.

## Context

- A contract plan is bound to a project folder (`durable_tasks.project_id` →
  `projects/<id>/`); a project-less plan falls back to the profile workspace.
- An agent step may spawn an engineering git-workspace for REPO code. That
  workspace is not the plan's artifact folder.
- Deterministic validators (`file_exists`, `command_exit_zero`, …) resolve
  relative subjects from the plan's project folder.

## Rules

| ID | Story → value | Validation (machine-checkable) | Does NOT forbid | Status |
| --- | --- | --- | --- | --- |
| DP-01 | Agent step knows the absolute artifact root → artifacts and checks agree | The fired step prompt contains the ABSOLUTE plan project folder (`<users>/<profile>/projects/<project>`); checks resolve relative subjects from it | a step `cd`-ing into its git-workspace for repo code (as long as plan artifacts go to the named root) | implemented (`tests/unit/durable-artifact-root.test.js` test A) |
| DP-02 | A failed registered (deterministic) check is not masked by `DURABLE: done` | After a step whose `file_exists` fails, the item status is not `done` and `last_error` names the failed check; the step goes through bounded recovery with the check's key/path | semantic / `inconclusive` verdicts staying soft; `task_item_exception` and fast-pass-skip keeping priority | implemented (test B) |
| DP-03 | A terminally failed step can be restarted after the cause is fixed | `task_item_retry(item_id)` on a `failed` item re-pends it (status ∈ pending/running/waiting) with a fresh attempt budget; a plan parked by the failure returns to `active` | other tools unchanged; the retry is manual (bounded by the operator, not a new auto-loop) | implemented (test C) |

## Edge cases

- A step with `DURABLE: done` and a passing / semantically-inconclusive check
  completes exactly as before — DP-02 only gates registered `fail`.
- `task_item_retry` on a non-`failed` item returns a clear error and changes
  nothing (no silent re-pend of a running/waiting/done step).
- A `programmatic` step already failed hard on a failed check before this
  scenario; DP-02 brings the agent path in line with it.

## Validation

`npx vitest run tests/unit/durable-artifact-root.test.js` — three assertions
(DP-01/DP-02/DP-03). Neighbouring `tests/unit/durable-*.test.js` and
`playbook-validators*` must stay green.
