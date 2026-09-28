# Agent process isolation — stage T0 (issue #1649)

Cheap hardening of how engine CLIs (claude / codex / opencode) are run, while
the full move to isolated execution is in progress. Everything here is **off
by default** and is switched on by the owner on the host with
`scripts/ops/agent-isolation-setup.sh` (dry run by default).

## What changes when it is on

| Before | With T0 |
|---|---|
| Engine runs as the service user | Engine runs as a leased, unprivileged **slot user** (`ta-agent-N`) via `sudo -n -u` |
| Engine env = the whole service env | Engine env = explicit allowlist: engine vars, run identity, the current profile's tokens |
| MCP servers are children of the engine | MCP servers run as the service user, reached through a run-token **MCP bridge** |
| `.mcp.json` in the profile dir holds server-side env | `.mcp.json` only names the bridge client — no env, no secrets |
| Callbacks use the server secret | Callbacks from the run use a **run-scoped token** (`AGENT_RUN_TOKEN`) |
| Any run can read every profile | A slot can only reach the profile(s) of its own run, and only while it runs |
| Engine can reach the metadata endpoint / local service ports | Blocked for the slot group by an owner-matched firewall chain |

## Switches (env of the agent service)

| Var | Effect |
|---|---|
| `AGENT_ENV_ALLOWLIST=1` | Env allowlist + MCP bridge + run tokens, same unix user. A safe first step. |
| `AGENT_RUN_AS_USERS=ta-agent-1,…` | Run-as slots (implies the allowlist). Size ≥ `MAX_CONCURRENT_TASKS` + nested (Hermes) runs. |
| `AGENT_RUN_AS_GROUP` | Slot group (default `ta-agents`). |
| `AGENT_SERVICE_USER` / `AGENT_SERVICE_HOME` | Service user / its home (default: current user / `os.homedir()`). |
| `AGENT_MCP_BRIDGE_DIR` | Bridge socket dir (default `$AGENT_DATA_DIR/agent-bridge`, mode 0711). |
| `AGENT_MCP_BRIDGE_CLIENT` | Path of the bridge client the slot executes (default: in the release dir). |
| `AGENT_SLOT_LOCK_DIR` | Slot lease locks + ACL journals (default `$AGENT_DATA_DIR/agent-slots`). |
| `AGENT_SLOT_WAIT_MS` | How long a run waits for a free slot before failing (default 60 s). |

A run that is configured for isolation but cannot set it up **fails**; it never
falls back to running as the service user.

## Pieces

- `src/agent-isolation.js` — config, env allowlist (`buildAgentEnv`), slot leases
  (lock files, cross-process: nested Hermes runs live in an MCP server process),
  profile gates (ACLs), per-profile engine home, sudo argv.
- `src/agent-run-tokens.js` — in-memory run tokens `{taskId, username}`, revoked when the run ends.
- `src/agent-mcp-bridge.js` / `src/agent-mcp-bridge-client.js` — per-process unix
  socket. The client (as the slot) sends `{token, server}`; the bridge spawns that
  run's MCP server as the service user with the env it always had and pipes stdio.
- `src/runner/engine-isolation.js` — glue used by `runEngineProcess`, so every
  spawn path that goes through it is covered: normal runs, durable steps,
  restart resume, Hermes tool runs.
- `POST /tasks/:taskId/extend-timeout` accepts a run token for its own task only.

### Profile gates

A gate is the top-level directory a run needs: the profile workspace, plus the
code cwd when it lives outside it (engineering worktrees). The first isolated run
prepares a gate once (marker `.agent-acl-v1`): `o-rwx`, group ACLs + default ACLs
for the slot group and the service user on everything **inside**, and no group
entry on the gate itself. So the only thing that lets a slot in is a
`u:<slot>:rwx` entry on the gate — added for the run, removed after it. Ancestors
inside the service home get `u:<slot>:x` (traverse only) for the same duration.
Every entry is journaled before it is added; a slot whose previous run never
reached cleanup (restart, crash) has the journaled entries revoked before its
next lease. On release all processes of the slot are killed (`pkill -u`), which
also ends anything the agent left running in the background.

### Engine home and credentials

`HOME=<profile>/.agent-home` (persistent per profile, so CLI state and native
resume survive across slots), `TMPDIR=<profile>/.agent-home/tmp/<slot>`.

- `TMPDIR` is one of the names glibc strips from the environment of setuid
  programs (`unsecvars.h`), so it can never pass through sudo's environment,
  whatever sudoers says. The runner passes every allowlisted name from that list
  as a sudo `NAME=value` argv assignment (`sudoArgv`, issue #1791); a unit test
  keeps the list in sync with the allowlist and the host loader.
- The temp dir is per slot (overlapping runs of one profile never share it) and
  is emptied by the slot on every release; on lease, day-old dirs of other slots
  are swept too. `.agent-home/tmp` is excluded from profile migration/sync
  (`config/profile-clean-list.yaml`).
- `--verify` checks that `TMPDIR` reaches a slot and that every running slot
  process has one.

- claude: `CLAUDE_CODE_OAUTH_TOKEN` = the current short-lived access token. The
  refresh token never leaves the service home; the host refresh broker stays the
  only refresher.
- opencode: copies of its config and `auth.json` per run.
- codex: copies of `config.toml` / `auth.json`; a token codex rotated during the
  run is written back (last writer wins).

## Rollout (owner)

1. `scripts/ops/agent-isolation-setup.sh --service-user <user>` — read the dry run.
2. Optionally start with `--mode allowlist` (no user switch), restart, watch runs.
3. `--apply` as root (`--verify` runs negative checks as a slot), then restart the service.
4. Rollback: remove the systemd drop-in, `daemon-reload`, restart. Users, ACLs and
   firewall rules are inert without the switches.

The script never restarts the service and never changes IAM; its service-account
step only prints what the VM account can access.

## Tests

- `test/agent-isolation.test.cjs` — allowlist through the real `runEngineProcess`,
  bridge auth, token revocation, slot/gate lifecycle, journal recovery, script dry run.
- `test/agent-isolation-e2e.test.cjs` — with real unix users (CI step
  `AGENT_ISOLATION_E2E=1`): a run for profile A cannot read profile B, token
  files or the secrets file while B is open for another slot, sees no server-only
  env, MCP still gets the service env through the bridge, and no ACL entry
  remains after release.

## Known limits of T0 (follow-ups)

- The current profile's tokens are still in the engine env (by design for T0);
  credentials-by-reference is a later stage.
- The engine's own credentials (claude access token, opencode/codex auth copies)
  are readable by the run.
- MCP servers (incl. the Playwright browser) run as the service user; a tool that
  reads arbitrary paths does so with service permissions. Restricting the browser's
  file access is a follow-up.
- Loopback policy `blocklist` (default) only rejects listed local ports; `deny`
  rejects all loopback TCP but is untested with every engine.
- Process listings show other runs' argv; `/proc` `hidepid` is left to the owner.
- A file the service writes into a profile with mode 0600 is not readable by the run.
- The issue-fixer cron only gets the env allowlist (same user); durable validators
  still run on the host.
