# MCP Skills Extraction + Generic Cron — PR 1, contracts

Owner request: 2026-09-23. Tracking: #1209; related #942, #954, #1201.
This is a versioned contract and inventory, **not an enabled scheduler**.
No existing jobs, credentials, routes, timers or tool names change in this PR.

## Evidence and reuse

Baseline core: e99c730. Existing domain repo: `trained-assist/trained-assist-hh-skill`
at f38a12fc098a7f7aba4e24c90d79287eadaec629. The proposed umbrella repo is an example,
not a reason to duplicate a deployed provider. Preserve that repo and its MCP
transport; naming/packaging can change independently after compatibility tests.

- `src/browser.js:writeMcpConfig` already adds the sibling `hh-skills` server.
- `src/mcp-action.js:runMcpTool` routes local/external tools and launches one child
  per call. Retain isolation: current tools capture USER_ID at module load and
  use cwd for context. Never execute these handlers inside the shared server.
- Local MCP tools no longer include 90/91/91b/92 HH files. The external provider
  exports **37 tools**, including two without an `hh_` prefix. The snapshot at
  `contracts/action-v1/hh-tools.snapshot.json` includes each original input schema.
  It records exports, not readiness-filtered tools for a particular profile.
- `src/server.js` still calls `scheduleHhBackgroundScoring` and
  `scheduleProactiveSearchRuns`. `src/hh-negotiations.js` owns 5-minute scoring
  and 30-minute proactive polling (first runs after 3 and 10 minutes).
- The external repo also has a copy of `hh-negotiations.js` with timer factories:
  moving a directory did not establish the desired boundary. Remove scheduling
  responsibility there as well; action-internal HTTP timeouts are not schedulers.
- `src/mcp-skills/tools/04-cron.js` creates GCP jobs posting text prompts to `/run`
  and local cwd-based JSON records. `cron_hh_digest` embeds recruiting behavior.
  `cron_get` and `cron_update` do not exist; `cron_run_now` invokes GCP directly.
- `hh_sync_messages` is **not an existing MCP tool**. The implementation
  `syncHhMessagesToHistory` is called from scoring/browser routes. PR 2 must expose
  a single action around it, with explicit vacancy and scoped context arguments.

## Inventory and boundary

`core-tool-inventory.json` classifies all current tool files, with an executable
coverage check so a new file must receive a destination. This is ownership intent,
not a claim that extraction is finished:

- Core: sessions/projects, context/artifact primitives, durable tasks, execution,
  browser runtime, auth/credential plumbing, MCP discovery/meta.
- Mixed: 04-cron (generic scheduling plus HH wrapper); 98-api-from-website
  (API discovery/runtime plumbing intertwined with service-specific operations).
- Domain: tax, Tilda, Weeek, company/enrichment, recruiting/ApplyLink/interviews,
  Drive, GitHub/dev/CI/business analyst workflows, GetCourse, Expo/Flexi, content,
  publishing, communication and other business tools. Workflow features can use
  core executors without making the workflow a core primitive.

HH export partition (all other snapshot entries are domain actions):

| Kind | Current names | Destination |
| --- | --- | --- |
| Auth/setup | hh_connect, hh_status, hh_set_token | Domain OAuth adapter + scoped core credential plumbing; never cron-eligible |
| Scheduling | hh_proactive_schedule | Compatibility wrapper over generic cron; status/enable/disable preserved |
| Domain state | hh_set_active_vacancy, hh_deactivate_vacancy, hh_set_rejection_template, hh_proactive_scoring_prompt, hh_proactive_queries | Domain actions using scoped context capability |
| Discovery/escape hatch | hh_discover, hh_api_call | Retain discovery; raw API calls require explicit policy, never implicitly approved for cron |
| Actions | Remaining exports, including cold_message_generate/rejection_with_feedback | External provider, one implementation per action |

Existing schemas are compatibility snapshots, not scheduling permission grants.
Outgoing messages, invitations, rejection and raw API calls need explicit effect
and approval policy. Reading data and drafting text do not authorize sending it.

## Invocation v1

`invokeAction({version: 1, profileId, projectId, action, arguments, trigger,
idempotencyKey, traceId?}) -> Promise<ActionResult>`.
JSON definitions: `contracts/action-v1/contract.schema.json`.

The envelope is internal. Core derives profile/project from authenticated caller
context, durable task ownership or the stored cron; tool input cannot supply or
change them. `projectId: null` means profile scope, never a wildcard. Project IDs
preserve existing Cyrillic slugs. Core validates project ownership, registered
provider, declared JSON input schema, action permission, allowed trigger, consent
and resource access before effects. Caller-supplied vacancy IDs still require
provider-side access checks. Unknown actions/providers fail closed.

Triggers: user, cron, durable_task, webhook, system. Every trigger uses the same
registration, validation, authorization, history and implementation. Cron run-now
is a cron execution requested by a user, not a way around cron permissions.
No inference from name prefixes or free-text prompts. Missing provider returns
PROVIDER_UNAVAILABLE; a business `{error: ...}` / MCP isError becomes a failed
result rather than a transport success. Error codes/retryability are stable;
messages are sanitized and credentials never enter results or journals.

Idempotency keys identify one logical invocation within profile/project across
triggers. Reuse returns the original execution; a changed action/arguments under
the same key returns CONFLICT. Cron occurrence key: `cron:<jobId>:<scheduledUtcMs>`.
Manual run-now requires a client key (a retry reuses it). A provider timeout after
an external effect may mean OUTCOME_UNKNOWN, not a retryable failure. Never claim
exactly-once remote side effects: retry read-only/idempotent actions, reconcile or
ask for approval before replaying unsafe writes. Lease ownership is checked when
completing executions so late workers cannot overwrite a recovered attempt.

## Provider contract

Manifest v1: providerId + actions[] (name, JSON inputSchema, allowedTriggers,
effect, requiresApproval, retrySafety). Reject duplicate action names, invalid
schemas, unsupported versions and unsafe combinations during registration;
requiresApproval must be true for external_message/destructive actions. No
implicit local-first shadowing in the final registry. JSON validates the shape;
these cross-field/policy rules are registration checks in PR 2/3.

Core adapter invokes MCP tools in a scope-bound child/transport using trusted
cwd and a minimal environment. A provider gets only scoped context/artifact,
credentials and journal capabilities, never a core DB handle, core module import,
unrestricted USER_ID switch or a scheduler. Credential capability only exposes
the requested service for the bound profile. Existing filesystem/env coupling is
migration debt; PR 1 does not pretend it has disappeared.

### Schedule declaration (#1489 S3.1–3.3)

An action may carry an optional `schedule` block: `label`, `minIntervalMinutes`,
`delivery` (`silent|on_change|on_error|always`), `costClass`
(`free|cheap_llm|llm|paid_api`), optional `defaultCron` and `settingsSchema`.
Registration rejects it unless `'cron'` is in allowedTriggers; a `defaultCron`
must parse and be no tighter than `minIntervalMinutes`, and approval-gated
actions get no default (a grant is always explicit). Job creation/update
validates arguments against `settingsSchema` and refuses a schedule tighter than
`minIntervalMinutes`. deploy.sh runs `scripts/check-skill-schedule.js` on a
sibling's new revision and keeps the old one if the core registry rejects it.

## Generic cron API / canonical storage

The six input schemas define cron_create/list/get/update/delete/run_now. Scope
comes only from trusted context. Every select/update/delete/claim includes
profile_id AND project_id (NULL via IS NULL, no wildcard). Not found and inaccessible
return the same NOT_FOUND service error. Lists return jobs only in current scope.

- create -> `{job}`; get/update -> `{job}`; list -> `{jobs}`;
- delete -> `{deleted: true, id}`; run_now -> `{executionId, status}` (accepted,
  current or terminal status), with result/history through the shared history API.
- job fields are those in cron_jobs in cron.sql; JSON API exposes `arguments`
  parsed from arguments_json. Public API never allows setting last_* or timestamps.
- Service errors: INVALID_ARGUMENTS, NOT_FOUND, FORBIDDEN, ACTION_NOT_FOUND,
  APPROVAL_REQUIRED, PROVIDER_UNAVAILABLE, CONFLICT; action result errors are in schema.

`cron.sql` is an executable SQLite DDL contract fixture, not a startup migration.
It contains jobs and shared action_executions history, timestamps in UTC ms,
IANA timezone, indexes, leases and occurrence uniqueness. cron deletion retains
history. Authorization remains a service responsibility, not an SQLite constraint.
DurableTaskStore stays in core; it references action execution IDs instead of
maintaining a second action dispatcher. Canonical DB ownership/location and
migration wiring are implemented with cron-service in PR 3.

Schedule uses five numeric POSIX fields, including lists/ranges/steps. JSON only
checks field count; cron-service must validate ranges, IANA timezone and compute
next occurrence (a dedicated tested parser, not an improvised regex). DOM/DOW
follow POSIX OR semantics when both restricted. Store UTC instants; skip nonexistent
DST local times, use the first occurrence of an ambiguous local time. Timezone
is explicit at the API boundary; conversational wrappers may supply Europe/Moscow.

On restart, coalesce missed occurrences to one most-recent due occurrence and
advance next_run_at atomically with claiming it. Never replay an unbounded backlog.
Use BEGIN IMMEDIATE + unique occurrence + leases; no overlapping execution for
the same job. Failure of one action must not stop claiming other jobs. Updating a
schedule recalculates next_run_at, disabling stops new claims, deleting stops new
claims but does not kill an already running effect. Retry bounds/timeouts and
backpressure are core policy, explicit in execution records and operational docs.
Cloud Scheduler may wake core but holds no canonical action/job state.

Provider jobs API (#1514): a skill's compatibility wrapper (e.g. `hh_proactive_schedule`)
manages its own jobs through `POST /internal/cron/jobs` (`op: upsert|list|delete`,
Bearer AGENT_SECRET) and never reads cron tables. Jobs are addressed by
(profile, project, action, name); upsert is idempotent and patches only changed
fields, so a repeated enable never postpones next_run_at. Creation policy is the
engine's (cron trigger, settingsSchema, minIntervalMinutes, approval gate). Every
answer carries `scheduler_role`; a wrapper must not report a job as running on a
host whose role is not `primary`.

## Delivery sequence and acceptance gates

1. This PR: contracts, export snapshots, inventory and executable schema/SQL tests.
2. HH extraction completion: adapt existing provider, scoped capabilities, expose
   sync action, reject unsafe/duplicate registrations, parity tests. Do not rename
   or silently drop existing public tools.
3. Generic cron + invokeAction: service, migration, CRUD, history, scoped adapters,
   durable-task executor; service isolation, authorization, competing workers,
   restart/catch-up, leases, failure, schema validation and DST tests.
4. HH migration: dry-run old JSON/GCP/proactive/ATS schedules, explicit mapping of
   all enabled jobs, durable migration ledger, cutover disables old timer before
   enabling new job. Canary one opted-in profile/project, rollback disables new
   job and restores old configuration without overlapping execution.
5. Other domains separately with contract parity tests.

Release each PR only with green CI and staging on the current head, then verify
the deployed revision. Final acceptance: hourly external hh_sync_messages survives
restart, records history, isolates profiles/projects, tolerates HH errors, and
manual MCP/durable task/cron all hit one implementation. No live candidate messages
or paid scoring probes without task authorization; use fixtures for destructive
and paid paths. PR 1 tests establish structural contracts and DB constraints;
they do **not** establish runtime authorization, concurrency or recovery correctness.

Cost/rollback: PR 1 adds a small dev-only AJV dependency and schemas maintained
with provider API changes; zero runtime/background cost. Revert removes artifacts.
Later cron jobs may call paid domain actions: preserve enabled schedules only and
surface action cost/approval policy during creation, with no silent new schedules.

Snapshot refresh (review changes before committing):
`node scripts/contracts/snapshot-hh.cjs /path/to/reviewed/trained-assist-hh-skill`.
This imports metadata in a throwaway profile and invokes no handlers. It records
all exports, including setup/unready tools, so credential availability cannot
silently truncate the compatibility inventory.
