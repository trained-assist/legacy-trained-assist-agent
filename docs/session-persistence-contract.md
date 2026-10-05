# Session and profile persistence contract

This documents the new architecture only. Legacy agent storage paths are retired.

## Durable placement

| Data | Stable identity and path | Durable store | Git inclusion |
|---|---|---|---|
| Profile workspace | `profileId` → `$USERS_DIR/<profileId>/` | Private repo `profiles-artifacts/profile-<normalized-profileId>`; the profile root is the repo root | Only `KEEP` files from `config/profile-clean-list.yaml`; generated `.gitignore` applies the same classification. Tokens, auth state, runtime homes, caches and temporary files are excluded. |
| Session index and pointers | `<profileId>/sessions.json`, `<profileId>/sessions/current-session*.json` | Profile repo; pointers identify the chat's recent session | Index, summaries and pointers are kept; full session bodies are archived separately. |
| Session body | `<profileId>/sessions/<sessionId>.json` | GCS bucket `trained-assist-workspaces`, key `profiles/<profileId>/sessions/<sessionId>.json.gz`; materialized before a reader uses an archived session | Not kept in the profile Git image after a verified archive. |
| Claude transcript | `<profileId>/.agent-home/.claude/projects/<claude-cwd-slug>/<engineSessionId>.jsonl` | GCS bucket `trained-assist-workspaces`, key `profiles/<profileId>/transcripts/<cwd-slug>/<engineSessionId>.jsonl.gz` | Not kept in the profile Git image after a verified archive. |
| Profile project data | `projectId` → `<profileId>/projects/<projectId>/` | The profile repository above | Persistent project documents follow the clean-list. A nested project Git repository is its own source of truth and is excluded from the profile image. |
| Engineering source code | Repository URL plus workspace/task identity → `<profileId>/engineering-mirrors/...` and `engineering-workspaces/<profileId>/.../code` | The selected source repository and its run/task branch | Kept in that source repository, not copied into the profile repository. |
| In-flight execution | `taskId`, `profileId`, `sessionId`, `projectId` in `$AGENT_DATA_DIR/pending-tasks/<taskId>.json` | Host operational state; absolute paths are derived at resume time | Never committed to profile Git. This journal is the source for process-restart continuation. |
| Credentials and execution scratch | `$AGENT_TOKENS_DIR/<profileId>/`, engine homes, temp dirs and logs | Local secret/runtime stores | Never committed. The clean-list `EXCLUDE` and `DELETE` rules are authoritative. |

Profile repository naming is defined by `scripts/profile-repo.mjs` and mirrored by `src/profile-save.js`: org `profiles-artifacts`, repo `profile-<normalized profileId>` (with a stable hash suffix when normalization could collide). The profile-save path sets the Git remote to this mapping.

## Session selection and restore

- An explicit `sessionId` continues that conversation after ownership checks. Before reading it, `src/session-materialize.js` restores an archived body from GCS; native Claude `--resume` similarly restores its transcript.
- Without an explicit id, the runner resolves the chat's recent `current-session` pointer. `forceNew` creates a distinct session and does not adopt that current session as its body/context. Recent chat history can still be added as a compact reference; this is not native session continuation.
- A process restart resumes accepted unfinished work from the pending-task journal (`taskId` plus stable profile/session/project ids). Completed session data is in the profile index and GCS even before any profile Git branch is integrated.
- The full bodies and transcript remain local if a GCS upload or verification fails. The current sweep retries later; until the pending-run contract is tightened, the runner must not report that archival succeeded.

## Run branches: target, not current behavior

Current `src/profile-save.js` commits the profile root's current `HEAD` and pushes it at the successful end-of-run path. It does not create an execution branch, checkpoint while the agent is running, or serialize completion merges. Current session archive work is separate: it stores session bodies/transcripts but does not create an artifact archive manifest. These are open implementation requirements tracked in issue [#1916](https://github.com/trained-assist/trained-assist-agent/issues/1916), with VM2 GCS credentials tracked in [#2114](https://github.com/trained-assist/trained-assist-agent/issues/2114).

The intended follow-up contract is one stable branch per execution id, incremental commits/pushes on checkpoints, retryable status for each external step, a GCS object with deterministic identity and a repository manifest, then explicit serialized integration into profile `main`. An unfinished execution resumes its own branch; a new session starts from profile `main`. Merge conflicts must stop for an explicit resolution.
