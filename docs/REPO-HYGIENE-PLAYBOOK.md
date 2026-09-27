# Repo Hygiene Playbook

Accumulated knowledge from wiring branch-per-session + immutable-PR discipline
into `trained-assist-agent`, `trained-assist-web`, `trained-assist-tg-bot`
(2026-09-15, issues/PRs: agent#624/#625/#627, web#18, tg-bot#95, tracking
issue #628). Written down once so it isn't re-discovered on every new repo.

## What "clean" means here

1. No direct commits to `main`/`master` — every change lands on a branch.
2. A branch that already has an open (or merged) PR is immutable — new work
   goes to a *new* branch, not another push to the old one. PRs are a
   one-shot artifact, not a running draft.

## How it's enforced

`.githooks/pre-commit` + `.githooks/pre-push` at the repo root, activated via
`git config core.hooksPath .githooks` (committed as part of the repo, so it
applies to every clone without per-machine setup):

- `pre-commit` — refuses a commit if `HEAD` is `main`/`master`.
- `pre-push` — refuses a push to a branch name that already has a PR in the
  `MERGED` or (already-pushed-once) `OPEN` state on GitHub, forcing a fresh
  branch instead of amending a submitted PR.

`dev_workspace_setup` (`trained-assist/software-engineering-playbooks` `src/mcp-skills/tools/61-dev.js`, served by the `engineering-skills` sibling since #1631) already installs
these hooks into **any** repo it clones or updates via `installGitHooks()` —
this is not limited to repos created through `dev_new_repo`. Practical
implication: the fix for an existing, already-cloned dev workspace lands the
next time the agent touches that repo (clone-or-update path both call
`installGitHooks`). If a workspace was cloned *before* this feature existed,
it won't have the hooks until it's touched again — worth a one-time retrofit
pass over `agent-data/dev/*` rather than assuming "already covered".

## GitHub API gotchas learned the hard way

- **Combined status vs check-runs**: `GET /repos/:o/:r/commits/:sha/status`
  only reflects legacy commit-status *contexts*. A `ci.yml` that reports via
  the Checks API (`check-runs`, what `actions/checkout` + most modern
  workflows use) never touches that endpoint — the combined status sits at
  `pending` forever even after CI passes. Always read
  `GET /repos/:o/:r/commits/:sha/check-runs` for real CI state, not
  `/status`.
- **Native auto-merge needs branch protection, and branch protection needs
  GitHub Pro on private repos.** A private repo without Pro gets `403` on
  the protection API, so GitHub's built-in "auto-merge when checks pass"
  is unavailable there. Workaround: a workflow triggered on
  `workflow_run` (for the CI workflow) that merges any PR carrying an
  `automerge` label — works on private free-tier repos because it doesn't
  depend on branch protection at all.
- **No auto-fix loop exists by default.** A red CI run does not by itself
  spawn a fix PR — that only happens when someone (or some other automation)
  explicitly asks the agent to look at the failure. If you want failures to
  self-heal, that has to be its own `workflow_run: failure` trigger; it
  isn't a side effect of anything above.
- **Token extraction from an `x-access-token` remote URL.** Repos cloned by
  this agent store the token embedded as
  `https://x-access-token:<token>@github.com/owner/repo.git`. Naive
  `${url#*:}` splitting breaks because of the `https://` scheme colon — use
  `sed -E 's#https://x-access-token:([^@]+)@.*#\1#'` (or equivalent) to pull
  just the token back out for a `curl -H "Authorization: Bearer $token"`
  call.

## Rolling this out to a new/existing repo

There is no separate "hygiene setup" tool yet — `dev_workspace_setup(repo)`
already does it as a side effect of cloning/updating. Tracking issue #628
proposes a dedicated `dev_repo_hygiene_setup(repo)` entry point (hooks-only,
no dependency install) for repos a user wants hardened without a full dev
clone, plus folding this doc's gotchas into it. Still open, pending a
reference repo link from the user for extra patterns to fold in.
