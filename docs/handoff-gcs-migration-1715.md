# Handoff: GCS Migration — What's Done, What's Next

## Context
Epic #1735 (prep) is complete. Epic #1715 (GCS migration itself) is ready to start.
The codebase is now clean: atomic writes, centralized paths, listing primitive, mode guards.

## Merged
- Step 2: atomic writes (#1765) — merged to main

## PRs waiting (rebase needed, all touch data-paths.js)
1. #1748 — centralize path resolution (workspacePath helper)
2. #1740 — listing primitive (listProfiles)
3. #1750 — mode bits guards (writeMode)
4. #1749 — batched flush (jsonl-batched-flush.js)

## Merge order
#1748 → #1740 → #1750 → #1749

## What's ready for #1715
After merging the 4 PRs above, the codebase supports:
- All workspace writes go through atomicJson/atomicText (tmp+fsync+rename)
- Cross-profile scans use listProfiles() (not raw readdirSync)
- All path construction via data-paths.js (workspacePath, userWorkDir)
- Mode bits guarded by GCS_WORKSPACE_SYNC env var

## What #1715 needs to implement
1. GCS client setup (infra + src/gcs-workspace-sync.js)
2. Download profile to ephemeral /tmp dir before run
3. Upload profile back after run
4. Feature flag GCS_WORKSPACE_SYNC=off by default
5. One-time migration script
6. Smoke tests

## Key files (post-merge)
- src/data-paths.js — workspacePath, listProfiles, writeMode, userWorkDir
- src/atomic-json.js — atomicJson, atomicText (with space/mode opts)
- src/jsonl-batched-flush.js — batched append for JSONL files
- src/session-store.js — uses atomicWrite (now via atomicJson)
- src/runner/engine-isolation.js — GCS guard on shareEngineInputs
- src/runner/claude-runner.js — where to hook download/upload around spawn

## Excluded from GCS sync
- engineering-workspaces/, engineering-mirrors/ — git repos
- vacancy-drafts/ — RU-VM, tracked in #1733
- media/intake/, illustrations/, interviews/ — binary
- .agent-home/ — per-run POSIX ACL
- SQLite DBs (SYSTEM_ROOT) — WAL + BEGIN EXCLUSIVE
