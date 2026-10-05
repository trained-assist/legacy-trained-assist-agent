# The MCP HTTP door (`POST /mcp`) — contract for an engine on another host

Issue #2106 built it, issue #2114 puts it on the host that outlives GCP. This
file is the contract a **consumer** (GitHub Actions, `ai-agent-runner`, any engine
that is not on the MCP host) codes against. It is not a plan — the migration order
lives in issue #2114.

## The two calls

### 1. Mint a run token — `POST <base>/mcp/token`

```bash
curl -sS -X POST "https://<mcp-host>/mcp/token" \
  -H "Authorization: Bearer $MCP_HOST_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"username":"<profile>"}'
# → {"token":"rt_<64 hex>","url":"/mcp","username":"<profile>"}
```

Two callers are accepted, and only for this route:

| Credential | Who | Power |
|---|---|---|
| `AGENT_SECRET` | the operator of the MCP host | full server access |
| `MCP_HOST_TOKEN` | a remote engine **host** | mint a run token for any profile |

`MCP_HOST_TOKEN` exists because a remote host must never hold `AGENT_SECRET`
(that is `/run`, `/internal/*`, everything), and because handing out a run token
by hand does not work: **run tokens live in the MCP host's process memory, so
every restart of the agent invalidates all of them.** Mint per run, at the start
of the run, from the host that drives the door.

Requirements for the value: prefix `mcp_`, at least 32 characters, from
`secrets.env` on the MCP host (comma-separated for more than one host). It is
never placed in an engine's environment and never committed.

### 2. Use the door — `POST <base>/mcp`

One JSON-RPC 2.0 message per POST. No session id, no `mcp-session-id`, no
batching, no SSE — a notification (a message without `id`) is answered `202` with
an empty body.

```bash
curl -sS -X POST "https://<mcp-host>/mcp" \
  -H "Authorization: Bearer $RUN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

| Method | Result |
|---|---|
| `initialize` | `protocolVersion: 2024-11-05`, `capabilities: {tools:{}}`, `serverInfo` |
| `ping` | `{}` |
| `tools/list` | the action catalog of the profile named by the token |
| `tools/call` | `{content:[{type:'text',text}], isError?}` |

A failing tool is `isError: true` **inside a result**, never a JSON-RPC error —
clients treat a JSON-RPC error as a broken server and drop the session.

## What the door serves, and what it does not

`tools/list` returns the action catalog of core `src/mcp-skills/` **plus every
sibling repo present on that host** (hh, sales, engineering, documents, speech,
search, marketing — one checkout each under `~/trained-assist-*`). So the catalog
is a property of the host, not of the code: a missing sibling checkout silently
removes that whole domain. `scripts/mcp-door-smoke.js --expect-tools N` is the
guard.

Not on this door:

| Missing | Why | Who has it instead |
|---|---|---|
| `playwright` | a browser session is host state (chrome on `:99`, CDP `:9224`, noVNC `:6080`); a remote engine has no such thing | an engine on the MCP host, or the MCP host's own browser tool |
| `capability-relay` | host-only plumbing | the host |
| every `/internal/*` route | machine-to-machine, host-local | the host |

Request size: 4 MB (`tools/call` arguments carry transcripts and page HTML).
Through the nginx front the read timeout is **300 s** — a long `tools/call`
(`video_analyze_batch`, an LLM round-trip) must not be cut into an empty 504.

## Checking a host

```bash
MCP_HOST_TOKEN=… node scripts/mcp-door-smoke.js \
  --base https://<mcp-host> --profile <profile> --expect-tools 300
```

with a second host it diffs the two catalogs by name and exits 3 when they
differ — run it before moving a consumer, not after.

## Hosts

| Host | Origin | Role |
|---|---|---|
| `gcp-main` | `https://136-65-7-197.sslip.io/agent` | legacy; hosts 39 profiles today |
| `contabo-vm2` (Contabo, France) | `https://169-58-15-230.sslip.io/agent` | the MCP host; takes consumers one at a time (issue #2114 P2) |

`AGENT_PUBLIC_URL` on each box is its **own** origin, so a link minted on VM2
never points at the machine being switched off. The branded
`agent.trainedassist.store` stays on GCP until that cutover is decided — moving it
is a consumer switch, not a deploy.

## Gaps on VM2, stated plainly

- **Session archive (GCS `trained-assist-workspaces`)** — unreachable from
  Contabo (no ADC, and the project grants no bucket credential to it yet).
  Archiving degrades to local-only: the post-run sweep keeps bodies on disk and
  reports the failure, nothing is deleted. Reading GCP-era archives does not work
  from VM2. Needs a bucket-scoped service-account key — see the manifest
  (`vms.contabo-vm2`) for the exact step; it needs an owner credential.
- **Browser session** — not provisioned on VM2 (no chrome/xvfb/noVNC). Nothing on
  the door needs it, but a manual-login skill would have to run on GCP or the RU
  edge until it is raised.
- **Bot identities** — VM2 keeps its sandbox `TELEGRAM_BOT_TOKEN`; no production
  bot token is on the box until routing moves.