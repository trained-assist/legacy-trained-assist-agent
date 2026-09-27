# trained-assist-agent

HTTP API server running on GCP VM — receives tasks from the Telegram bot and runs Claude Code.

## Architecture

**All Claude Code sessions run on GCP** (issue #1288). The RU VM is a thin
**RU-IP edge** only — it holds no Claude, no runner, no task-queue, no MCP —
used for the handful of things that need a Russian IP: nalog.ru/Госуслуги
(ESIA) login, RU-geo-blocked page fetches, and the vacancy landing pages
hosted on `platform.recruiter-assistant.ru`. GCP calls the RU edge over HTTP
(Bearer `AGENT_SECRET`) whenever it needs one of those.

```
User (Telegram)
      │
      ▼
trained-assist-tg-bot  (Cloudflare Worker — stateless)
      │
      ├── simple commands handled locally
      ├── voice → Deepgram STR → text
      │
      └── task ──────────────────────────────────────────► GCP VM (136.65.7.197)
                         │
                         ▼
               POST /run  (Bearer AGENT_SECRET)
                         │
                         ▼
              trained-assist-agent  (this repo, src/server.js)
                         │
                ┌────────┴────────┐
                │                 │
          quick answer?      spawn Claude Code
          (deterministic)    --dangerously-skip-permissions
                │            --print "<task>"
                │                 │
                └────────┬────────┘
                         │
                         ▼
              stream output → Telegram API directly

  GCP → RU-IP edge (RU VM, 178.212.14.192, src/ru-edge.js), on demand:
    POST /nalog/start-login   — nalog.ru/ESIA login via Playwright
    POST /nalog-api-relay     — lknpd.nalog.ru API calls (geo-blocked from GCP)
    POST /playwright-fetch    — any other RU-geo-blocked page
    POST /vacancy/store       — publish a vacancy landing page

  RU-IP edge → GCP, after a nalog.ru login completes:
    POST /nalog/token-store   — hand the token back (GCP is where it's read from)
```

> **Bot routing note (follow-up, separate repo):** `trained-assist-tg-bot`'s
> smart routing still probes `/capabilities` to decide GCP vs RU VM per task.
> Since ALL Claude tasks now run on GCP regardless, that RU branch is dead —
> removing it from the bot's routing is tracked as a follow-up there, not in
> this repo.

**trained-assist-agent** (GCP) manages:
- Per-user working directories (`~/users/<username>/`)
- Session state and topics (in-memory + disk persistence)
- Claude Code process lifecycle
- MCP skills server (`trained-skills`) per session
- Quick answers — deterministic responses that bypass Claude entirely
- `/capabilities` endpoint — lists which services a user has tokens for (bot upsell/status use; no longer drives RU routing, see note above)
- `/classify` endpoint — Claude Haiku call to match an incoming message to an existing session

**RU-IP edge** (`src/ru-edge.js`, RU VM) manages:
- `GET/POST /connect/nalog`, `GET/POST /connect/nalog/code` — nalog.ru/ESIA Playwright login, including the interactive 2FA step (the Playwright browser session lives in this process's memory between the two steps, so both must run on the same host)
- `POST /nalog/start-login`, `POST /nalog-api-relay` — the GCP-facing delegation endpoints above
- `POST /playwright-fetch` — generic RU-geo-blocked page fetch (used by `ru_browser_fetch`/`ru_browser_screenshot` MCP skills)
- `GET /vacancy/:username/:id`, `POST /vacancy/store`, `POST /apply/:username/:id` — vacancy landing pages (kept on RU by design, not geo-blocked, just historically hosted there)
- `GET /health`, `GET /capabilities` (always empty — no per-user state lives on this box any more)

### Request flow (POST /run)

1. Auth check: `Authorization: Bearer AGENT_SECRET`
2. `getQuickAnswer()` — if the task matches a known intent (capability question, setup flow), return immediately without touching Claude
3. Resolve or create session directory for `username`
4. Spawn `claude --dangerously-skip-permissions --print "<task>"` in the session workDir
5. Stream stdout chunks → `editMessage` Telegram API calls on the placeholder message
6. On exit: update session metadata (topic, lastAt, lastUserMessage)

## Key Entities

Three distinct concepts — understanding them prevents confusion:

| Entity | Field | Type | Meaning |
|--------|-------|------|---------|
| **Profile** | `username` | `string` (alphanumeric) | The identity unit. Owns all state: tokens, files, sessions, MCP skills. One profile can be used by many people from many chats. Example: `"efi"`, `"recruiter-skillset"` |
| **Chat** | `userId` in `/run` | `number` (Telegram chat ID) | Where Claude's output streams to — a private chat or group. Many chats → one profile. The bot controls the mapping. |
| **Telegram User** | `telegramUserId` | `number` | The individual human who sent the message. Informational only — does not control routing or state. |

**Profile is the unit of isolation.** Tokens: `~/agent-tokens/{username}/`. Workspace (sessions, projects, per-profile data): `~/users/{username}/`. Claude sees `USER_ID={username}`.

**Many chats → one profile** is supported by design. A recruiter profile shared across 5 people and 2 groups all use the same HH token, same session history, same ATS configs. The bot implements this via `CHAT_MAPPINGS` env var (see [tg-bot#17](https://github.com/trained-assist/trained-assist-tg-bot/pull/17)).

> **Known naming inconsistency:** `userId` means different things across endpoints:
> - `/run` body: numeric **chat ID** (Telegram destination for output)
> - `/capabilities?userId=`, `/tokens` body: alphanumeric **profile name** (= `username`)
>
> Future cleanup: rename `/run`'s `userId` → `chatId`.

> **In-progress/TBD terms — do not copy further without checking the naming-conventions-refactoring plan first:**
> - `profileId` — emerging canonical name for the identity unit above (replacing `username` long-term). Partially introduced (`server.js`: `payload.profileId ?? username`); `username` is still the authoritative field everywhere else. Not yet a stable API — don't rely on `profileId` being present.
> - `audience` — scopes sessions/projects by bot surface (`session-store.js`, `server.js`, `projects.js`), default `'default'`. No canonical name has been agreed yet (candidates include `audience`, `botAudience`, `deliverySurface`). Keep using `audience` for now, but don't add new derived terms from it until a name is settled.

## Repos

Architecture: **Agent Control Plane** (this repo, `trained-assist-agent`) hosts
core/cross-domain MCP skills (`src/mcp-skills/`) plus the runtime (session
store, runner, web UI backend). Predetermined-domain functionality is meant to
live in a separate **Domain Skill Server** repo — a repeatable pattern, not a
one-off. Naming rule: `trained-assist-<domain>-skill`, where `<domain>` is the
business capability (e.g. `recruiting`), **not** the first external
platform/API it happens to integrate (e.g. not `hh` for HeadHunter) — a
domain server may grow to cover more than one platform under the same
capability. Inside a domain skill server, platform-specific tool files live
under `src/mcp-skills/tools/<platform>/`; domain-general tools stay at the
`tools/` root.

| Repo | Description |
|------|-------------|
| [trained-assist-agent](https://github.com/trained-assist/trained-assist-agent) | This repo — Agent Control Plane, GCP VM agent + core MCP skills |
| [trained-assist-tg-bot](https://github.com/trained-assist/trained-assist-tg-bot) | Cloudflare Worker — Telegram webhook |
| [trained-assist-hh-skill](https://github.com/trained-assist/trained-assist-hh-skill) | Domain Skill Server — HR/Recruiting (first pilot of the pattern). **Mid-migration**: rename to `trained-assist-recruiting-skill` pending, blocked on closing the fallback-registration cleanup (issue #942) — see naming-conventions-refactoring plan. Both names may appear until the rename PR lands. |
| [trained-assist-web](https://github.com/trained-assist/trained-assist-web) | Web UI (session manager) for the agent |
| [trained-assist-checklist](https://github.com/trained-assist/trained-assist-checklist) | Standalone D1-backed generic checklist worker (not the GTD `checklist.md` mechanism) |

## API

All endpoints (except `/health`, `/connect/*`) require `Authorization: Bearer <AGENT_SECRET>`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness check (no auth) |
| `GET` | `/readiness` | Can accept work? 200 ready / 503 not (no auth) |
| `GET` | `/health-full` | Health + Claude version |
| `GET` | `/capabilities` | List services this user has tokens for (`?userId=…`). No longer drives bot RU-routing — see Architecture note. |
| `GET` | `/skills` | List available MCP skills |
| `GET` | `/stats` | Session and task stats |
| `POST` | `/run` | Run a Claude Code task |
| `POST` | `/classify` | Classify a message to an existing session (Claude Haiku) |
| `GET` | `/sessions` | List recent sessions for a user |
| `GET` | `/sessions/:id` | Get session details |
| `POST` | `/tokens` | Store an auth token for a user (`userId`, `label`, `value`) |
| `GET` | `/files` | List files in a user's session dir |
| `GET` | `/files/read` | Read a file from a user's session dir |
| `GET` | `/connect/:service` | OAuth / login form for a service (getcourse, gdrive, hh, …) |
| `POST` | `/nalog/token-store` | Receive a nalog.ru token pushed from the RU edge after login (`AGENT_SECRET`) |

> nalog.ru's own login routes (`/connect/nalog`, `/connect/nalog/code`) run on
> the RU-IP edge now, not here — see `src/ru-edge.js` and "RU VM — nalog login
> setup" below.

### POST /run

```json
{
  "userId": 123456789,
  "username": "alice",
  "task": "Напиши скрипт для...",
  "context": "О пользователе: ...",
  "sessionId": "s-123456789-1234567890",
  "initialMsgId": 42,
  "pinnedMsgId": 42,
  "telegramUserId": 123456789
}
```

Returns `202 { "taskId": "alice-1234567890" }` immediately. Output streamed to Telegram via `editMessage`.

> `userId` = Telegram **chat ID** (numeric, where to send output). `username` = **profile** (alphanumeric, owns state). They are different things — the bot decides which profile maps to which chat.

### GET /capabilities

Returns which services this user has tokens for on GCP. Historically used by the bot to
decide GCP vs RU VM routing — since all Claude tasks run on GCP now (issue #1288), that
routing branch is dead; removing it from the bot is a follow-up in `trained-assist-tg-bot`.

```json
{ "capabilities": ["nalog"] }
```

### POST /classify

Asks Claude Haiku which existing session a new message belongs to.

```json
// request
{ "message": "что там с задачей по Weeek?", "sessions": [...] }
// response
{ "sessionId": "s-123-456", "confidence": "high" }
// or
{ "sessionId": null, "confidence": "low" }
```

## Infrastructure

### VM Inventory

| VM | IP | Domain | Purpose | systemd service |
|----|-----|--------|---------|------------------|
| `gcp-main` | `136.65.7.197` | `recruiter-assistant.ru` | Main VM — all Claude Code sessions, HH recruiting, GDrive, GetCourse, company lookup | `assist-agent` (`src/server.js`) |
| `ru-vm` | `178.212.14.192` | `platform.recruiter-assistant.ru` | RU-IP edge only — nalog.ru/ESIA login, RU-geo-blocked fetch, vacancy pages. No Claude, no runner, no MCP (issue #1288) | `ru-edge` (`src/ru-edge.js`) |

Both VMs run their service on port 8080, reverse-proxied via nginx on 443.
Identity visible in `/health` response: `vm` field (e.g. `"vm":"gcp-main"`) + `commit` (git SHA).

### Browser Session Infrastructure

**GCP VM only.** A persistent headless Chrome instance accessible via noVNC — used for sites that require manual login (CAPTCHA, IP-binding, hardware tokens) that can't be automated headlessly.

**Architecture:**

```
Xvfb :99 (virtual display)
  └── Chrome --remote-debugging-port=9224  (CDP for Playwright/scripts)
        └── x11vnc :5900  (VNC server on the virtual display)
              └── websockify :6080  (WebSocket proxy)
                    └── nginx /browser/  (noVNC web UI, public HTTPS)
```

**Systemd services** (`infra/systemd/`):

| Service | Description |
|---------|-------------|
| `xvfb-browser.service` | Virtual display `:99` (1280×900, 24-bit) |
| `chrome-browser.service` | Chrome on display `:99`, CDP on port 9224, opens Tilda login by default |
| `vnc-browser.service` | x11vnc on VNC port 5900 (no password, localhost only) |
| `novnc-browser.service` | websockify proxies VNC → WebSocket on port 6080 |
| `wm-browser.service` | Minimal window manager for Chrome window management |
| `ntp-hider.service` | Hides the Chrome NTP tab that opens on startup |
| `login-server.service` | HTTP server on 127.0.0.1:9090 — validates pending tokens and triggers login scripts |

**Setup:** `infra/browser-session/setup.sh` — installs packages (`xvfb x11vnc novnc websockify`), copies scripts to `~/browser-session/`, enables and starts systemd services.

**MCP skill:** `src/mcp-skills/tools/21-browser-session.js` — exposes the browser session to Claude. Lets the user open a noVNC link, log in manually (handles CAPTCHAs), then captures cookies via CDP for use by other skills (Tilda, etc.). Generates short-lived pending tokens stored in `~/browser-session/pending/` (30-min TTL). The noVNC URL is set via `BROWSER_SESSION_URL` env var (default: `https://136-65-7-197.sslip.io/browser/`).

**nginx endpoints** (`infra/nginx/relay.conf`, GCP VM only):

| Path | What it does |
|------|-------------|
| `/browser/` | Serves noVNC web UI (redirects to `tilda-login.html`) |
| `/browser-login` | Proxies to `login-server.service` on port 9090 |

### Secrets Architecture

RU `secrets.env` only lists the two secrets ru-edge (`src/ru-edge.js`) actually
needs — no Claude, no runner, no MCP there any more (issue #1288). Everything
else GCP needs (INN_*, image-gen keys, OPENROUTER_API_KEY, OPENCODE_*, ZeroCreds,
GitHub issues token, CHECKLIST_API_KEY) is GCP-only now too.

| Secret | Required | GCP Secret Manager | GCP `secrets.env` | RU `secrets.env` | Notes |
|--------|----------|:------------------:|:-----------------:|:----------------:|-------|
| `TELEGRAM_BOT_TOKEN` | ✅ | ✅ | — | ✅ | GCP reads from SM; ru-edge reads from file (Telegram notifications) |
| `ANTHROPIC_API_KEY` | — | ✅ | — | — | Unused anywhere now — GCP's Claude Code uses OAuth, RU no longer runs Claude |
| `AGENT_SECRET` | ✅ | ✅ | ✅ | ✅ | GCP↔ru-edge mutual auth (`/nalog/start-login`, `/nalog-api-relay`, `/nalog/token-store`, `/playwright-fetch`, `/vacancy/store`) |
| `DEEPGRAM_API_KEY` | — | ✅ | — | — | Voice transcription — GCP only (no Claude sessions on RU any more) |
| `BOT_SECRET` | — | ✅ | — | — | Chrome extension token relay — GCP only |
| `INN_DADATA_TOKEN` | — | — | ✅ | — | Injected directly into Claude env (bypasses secrets.js) — GCP only (MCP tool) |
| `INN_DADATA_SECRET` | — | — | ✅ | — | Same |
| `INN_CHECKO_KEY` | — | — | ✅ | — | Same |
| `CF_API_TOKEN` | — | ✅ only | — | — | GCP-only via Secret Manager |
| `HH_CLIENT_ID` | — | ✅ only | — | — | HH OAuth — GCP only |
| `HH_CLIENT_SECRET` | — | ✅ only | — | — | HH OAuth — GCP only |
| `GOOGLE_OAUTH_CLIENT_ID` | — | ✅ only | — | — | GDrive OAuth — GCP only |
| `GOOGLE_OAUTH_CLIENT_SECRET` | — | ✅ only | — | — | GDrive OAuth — GCP only |
| `OPERATOR_CHAT_ID` | — | ✅ only | — | — | Operator notifications — GCP only |

> **Single source of truth:** `infra/env-manifest.json`. Validated by `node scripts/check-env-sync.js` (runs in CI).

### GitHub Actions Secrets Checklist

Set in repo **Settings → Secrets and variables → Actions**:

**Infrastructure (SSH access):**
- [ ] `VM_HOST` — GCP VM IP (`136.65.7.197`)
- [ ] `VM_USER` — SSH user (`vova`)
- [ ] `VM_SSH_KEY` — Private SSH key for GCP VM
- [ ] `VM_RU_HOST` — RU VM IP (`178.212.14.192`)
- [ ] `VM_RU_USER` — SSH user (`vova`)
- [ ] `VM_RU_PASSWORD` — SSH password for RU VM

**App secrets (written to `secrets.env` during deploy):**
- [ ] `AGENT_SECRET`
- [ ] `TELEGRAM_BOT_TOKEN`
- [ ] `ANTHROPIC_API_KEY`
- [ ] `DEEPGRAM_API_KEY`
- [ ] `BOT_SECRET`
- [ ] `INN_DADATA_TOKEN`
- [ ] `INN_DADATA_SECRET`
- [ ] `INN_CHECKO_KEY`

### Adding a new secret — checklist

1. Add to `src/secrets.js` → `REQUIRED` or `OPTIONAL` array + `return` object
2. Add to `infra/env-manifest.json` → `github_actions_secrets.app` with `written_to` and `gcp_sm`
3. Add to **GCP Secret Manager**: `echo -n 'value' | gcloud secrets create NAME --data-file=- --project=alesa-personal-assistent`
4. Add to **GitHub Actions Secrets** (Settings → Secrets → Actions)
5. Add to `.github/workflows/ci.yml` → `printf` block for each VM in `written_to`
6. Add to `.github/workflows/deploy-manual.yml` → same `printf` blocks
7. Run `node scripts/check-env-sync.js` — must pass before commit
8. If GCP-only (not in `written_to`): add to `gcp_secret_manager_only` in manifest instead of step 4–6

### Deployment

**Normal flow:** PR → CI → auto squash-merge → deploy to both VMs.

**How deploy selects the running code (release model, #1391):** CI never resets a
live working tree. It builds the merged SHA into an immutable, root-owned
`~/agent-releases/<sha>/` (`git archive` + `npm ci`) and atomically repoints the
`~/agent-master` symlink at it; both services run with
`WorkingDirectory=~/agent-master`. The repo checkout is only a git source — sessions
may work in it (checkout/commit) without affecting prod. Rollback = repoint the
symlink to a previous release. Old releases are garbage-collected (3 kept).
Deploy code itself is run from the target SHA, not from the worktree.

**Emergency / manual deploy** (no PR needed):
1. Merge your change to main first (or it's already there)
2. GitHub → Actions → **Manual Deploy** → Run workflow → choose target (`gcp` / `ru` / `both`)
3. Enter reason (optional, goes to deploy log)

**Restart model — instant and silent** (details: [docs/instant-restart.md](docs/instant-restart.md)): a deploy or `/restart` never drains, pauses admission or messages users. SIGTERM → `interruptForRestart()` → exit; running tasks stay in `pending-tasks/` and the new process re-runs them via `resumePendingTasks` with no status messages. Users are told only when a task cannot come back. Do not reintroduce a drain gate, a "paused/restart planned" status, or a "restart finished" broadcast.

**After a failed deploy:**
```bash
# Check which VM is affected
curl -s -H "Authorization: Bearer $AGENT_SECRET" https://recruiter-assistant.ru/agent/health
curl -s -H "Authorization: Bearer $AGENT_SECRET" https://178-212-14-192.sslip.io/health

# SSH into the VM and check logs
sudo journalctl -u assist-agent --no-pager -n 50

# Common causes:
# - "Required secret missing: TELEGRAM_BOT_TOKEN" → secret not in GCP SM or secrets.env
# - Port 8080 already in use → sudo fuser -k 8080/tcp && sudo systemctl restart assist-agent
# - bad release deployed → repoint the symlink to the previous release, then restart:
#   ls -1dt ~/agent-releases/*/ ; sudo ln -sfn ~/agent-releases/<prev-sha> ~/agent-master.new
#   sudo mv -T ~/agent-master.new ~/agent-master && sudo systemctl restart assist-agent
```

## Setup

### 1. Initial VM setup

```bash
curl -sSL https://raw.githubusercontent.com/trained-assist/trained-assist-agent/main/scripts/setup.sh | bash
```

### 2. GCP Secret Manager

Required secrets (project `alesa-personal-assistent` — GCP project name, not renamed):

| Secret | Description |
|--------|-------------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `AGENT_SECRET` | Shared secret with tg-bot (generate random string) |
| `DEEPGRAM_API_KEY` | Optional: voice transcription |
| `BOT_SECRET` | Optional: Chrome extension |

```bash
echo -n "your-value" | gcloud secrets create SECRET_NAME --data-file=-
```

### 3. GitHub Actions secrets

See [Infrastructure → GitHub Actions Secrets Checklist](#github-actions-secrets-checklist) above for the full list.

Legacy minimal set — sufficient only if you haven't added new secrets:

| Secret | Description |
|--------|-------------|
| `VM_HOST` | VM IP address (e.g. `136.65.7.197`) |
| `VM_USER` | SSH user (`vova`) |
| `VM_SSH_KEY` | Private SSH key for deployment |

## RU VM — nalog login setup (RU-IP edge, `src/ru-edge.js`)

`POST /connect/nalog` runs headless Playwright for 30–60 s. nginx must not cut the connection before it completes.

### 1. Playwright Chromium

```bash
# On the RU VM, as root after npm ci:
sudo -u vova npx playwright install chromium
sudo -u vova npx playwright install-deps chromium
```

`scripts/setup-ru-vm.sh` already does this — only needed when adding the VM manually.

### 2. AGENT_PUBLIC_URL

Add to `/home/vova/secrets.env` on the RU VM:

```
AGENT_PUBLIC_URL=https://platform.recruiter-assistant.ru
```

This is what goes into the connect-link sent to users via Telegram.

### 3. nginx proxy_read_timeout

`POST /connect/nalog` blocks for up to 60 s while the browser logs in.
Default nginx `proxy_read_timeout` is 60 s — too tight. Add to the nginx server block:

```nginx
# /etc/nginx/sites-available/assist-agent  (or the relevant include)
location /connect/nalog {
    proxy_pass         http://127.0.0.1:8080;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
}
location /connect/nalog/code {
    proxy_pass         http://127.0.0.1:8080;
    proxy_read_timeout 60s;
}
```

Reload: `nginx -t && systemctl reload nginx`

### Smoke-test the nalog routes

```bash
AGENT_URL=https://178-212-14-192.sslip.io AGENT_SECRET=xxx bash scripts/smoke-test-ru-edge.sh
```

Or manually:

```bash
BASE=https://178-212-14-192.sslip.io
# Form renders (no auth needed)
curl -s -o /dev/null -w "%{http_code}" "$BASE/connect/nalog?t=abc"  # → 200
# Missing fields
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/connect/nalog" \
  -H 'Content-Type: application/json' -d '{"t":"aabbccddeeff00112233445566778899"}' # → 400
# Bad pending token
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/connect/nalog" \
  -H 'Content-Type: application/json' \
  -d '{"t":"aabbccddeeff00112233445566778899","login":"a","password":"b"}' # → 403
```

---

## Development

## Development workflow

All changes go through PRs — no direct pushes to `main`.

```bash
git checkout -b fix/description   # or feat/description
# make changes
git add . && git commit -m "fix: description"
git push origin fix/description
gh pr create --fill                # opens PR; CI runs; auto-merges on green
```

Branch protection requires the `ci` job to pass. PRs auto-merge (squash) when CI is green — no manual approval needed.

### After opening a PR — always write a checklist.md (default, unless told otherwise)

**Rule: right after `gh pr create`, write/append `checklist.md` in the project root with 3 items, unless the user explicitly said not to track it:**

```markdown
Goal: <one line — what this PR does>

- [ ] CI green on <PR URL>
- [ ] Merged to main
- [ ] Deployed to prod — verified live
```

Why: the GTD controller (`src/gtd-controller.js`) reads `checklist.md` and auto-schedules a durable
check-back — no need to explicitly ask to "see it through". The first two items are checked off for
free via a GitHub API poll (no LLM, no Claude spawn — see `checklistCheapPrecheck`); a real
Claude/Codex session only wakes up once there's actual work left (CI failed, or "deployed live" needs
a genuine check) — never just to poll a status that's plain data. This is why you don't need to ask
the user for a reminder or worry the VM restarting will lose track — it's durable on disk and survives
restarts. Include the actual PR URL in the checklist text (`github.com/<owner>/<repo>/pull/<n>`) — the
precheck greps it out of the file to know which PR to poll.


```bash
npm install
npm run dev    # starts with --watch
npm run check  # syntax check all src files
```

## Env vars

| Var | Default | Description |
|-----|---------|-------------|
| `PORT` | `3000` | HTTP listen port |
| `AGENT_DATA_DIR` | `~/agent-data` | Server-side operational state (candidate history, pending tasks, flags, execution history) |
| `USERS_DIR` | `~/users` | Canonical per-profile workspace root — sessions, projects, contexts, artifacts. Set explicitly in systemd |
| `AGENT_TOKENS_DIR` | `~/agent-tokens` | Per-profile credentials/tokens root. Set explicitly in systemd |
| `NODE_ENV` | — | Set to `production` in systemd |
| `AGENT_PUBLIC_URL` | `https://recruiter-assistant.ru` | Public base URL for connect-links. RU VM: `https://platform.recruiter-assistant.ru` |
| `ENGINE_UNAVAILABLE_AFTER_FAILURES` | `3` | Consecutive relevant engine failures before `engine_health.status` flips degraded → unavailable |

> **Engine Health vs Credentials vs Failure Events** (`src/engine-health.js`, spec §7–§10): three separate concerns.
> - **Credentials** — `auth-flag.js` + CLI credential stores. The auth flag now tracks only a real credential loss (class `AUTH`).
> - **Engine Health** — operational state per engine (`healthy`/`degraded`/`unavailable`, `consecutive_failures`, `last_failure_*`), SQLite at `$AGENT_DATA_DIR/engine-health/state.db`. Self-heals to `healthy` on the next successful call; failure history is not erased.
> - **Failure Events** — append-only attempt chain in `execution-history.js`.
>
> `QUOTA` / `RATE_LIMIT` / `CONFIG` degrade health but are **not** credential-invalid. `/internal/auth-status` returns both the back-compat `engines` flags and the derived `engine_health` view.

> **Health endpoints** (`src/readiness.js`, spec §13): `/health` is liveness only; `/readiness` answers "can this server accept work?" (data dir writable, execution-owner lock present, ≥1 engine not `unavailable`) and returns 503 when not. One unavailable engine does **not** make the server unready while a fallback engine is usable.

> **Claude OAuth hardening** (`scripts/claude-token-refresh.js`, spec §8): a single-owner refresh broker — exclusive flock, re-read under lock, atomic write (temp + fsync file + fsync dir + rename), backup before write, and it refuses partial credential states (access token without refresh token). Locked in by `test/claude-token-refresh.test.cjs` (single-owner concurrency, atomic write, partial-response reject, no-write-on-failure).

> **Identity ≠ location:** durable state stores stable IDs (profileId/projectId/sessionId/executionId) — filesystem paths are always derived in `src/data-paths.js`. Never persist an absolute path or construct a profile path inline. The legacy `$AGENT_DATA_DIR/sessions/<profile>` workspace tree is deprecated and migrated by `scripts/migrate-workspaces.mjs` (runs automatically in `deploy.sh`).

Note: on first deploy after this change, `deploy.sh` automatically migrates `~/alesa-data` → `~/agent-data` if the old directory exists.

## Claude Code Instructions

### Architecture rules
- All state on disk — persists across process restarts. **Resolve every path through `src/data-paths.js` (`USERS_ROOT`/`SYSTEM_ROOT`/`TOKENS_ROOT` + helpers); never hardcode or re-derive from `os.homedir()` inline.**
- Per-user workDir: `$USERS_DIR/<username>/` — files for Claude Code (canonical per-profile workspace; resolved via `src/data-paths.js`, never hardcode)
- User tokens: `~/agent-tokens/<username>/` — one file per service (github, nalog, gdrive…), `mode 0o600`
- Connect-pending tokens: `~/connect-pending/<token>.json` — short-lived (30 min), `mode 0o600`
- HTTP server: no framework, built-in `http` module only
- Claude: spawned as child process via `spawn('claude', ['--dangerously-skip-permissions', '--print', prompt])`
- Auth: all endpoints gated by `AGENT_SECRET` Bearer token
- MCP skills: `src/mcp-skills/` — stdio JSON-RPC 2.0 server, auto-discovers tools from `tools/*.js`

### Adding a new service to ZeroCreds — checklist

When adding a new entry to `SERVICE_FORM_SCHEMA` in `src/user-tokens.js`:

- [ ] No local `generateConnectLink` copy in `src/mcp-skills/tools/<service>.js` — MCP skills must use `require('../../user-tokens').generateConnectLink` (ZeroCreds) or `generateLegacyConnectLink` (OAuth / no form)
- [ ] MCP skill handler calls the function with `await`
- [ ] CI check passes: `grep -rn "connect-pending" src/ --include="*.js" | grep -v user-tokens.js | grep -v server.js` returns empty

### Adding a new endpoint
Add route handling in `src/server.js` in the request handler chain (method + pathname check pattern).

### Recruiter/quick-action MCP tools must use cheap LLMs, never Claude Code

**Rule: any MCP tool under `src/mcp-skills/tools/*hh*.js` or `*recruiter*.js` must call OpenRouter (DeepSeek/Gemini) directly via its own `llmCall()`-style helper — it must never spawn a Claude Code session.**

Why: these tools back one-tap Telegram quick-commands (`/eval`, `/review`, `/send_message`, …). Spawning Claude Code for them defeats the point of a "quick" action — it's slow and burns Claude tokens for work a cheap model already handles (see `src/mcp-skills/tools/90-hh.js` — 100% OpenRouter, `deepseek/deepseek-chat` / `deepseek/deepseek-v4-flash-0731`, no Claude Code call anywhere in the HH domain).

Enforced in CI (`ci.yml` → "Recruiter/HH tools must call OpenRouter, not spawn Claude Code") — a new file under those globs that imports `runner.js` or spawns the `claude` binary fails the build.

### src/ module map

| Module / path | Description |
|---------------|-------------|
| `src/ru-edge.js` | The RU-IP edge service (issue #1288) — a separate entry point (`node src/ru-edge.js`, `systemd/ru-edge.service`), not part of `server.js`'s request handler. No Claude/runner/task-queue/MCP. Runs on the RU VM only. |
| `src/domains/hh/lib.js` | Core's only path to HH domain code: `hhLib('hh-utils')` loads the module from the `trained-assist-hh-skill` sibling checkout (override `HH_SKILL_DIR`), which is the single source of truth — core keeps no `src/hh-*.js` copies (ratchet: `test/ratchet-hh-core.test.cjs`). A missing sibling only fails HH calls with a clear error; core still starts. |
| `src/nalog-login.js` | Headless Playwright login to lknpd.nalog.ru via Госуслуги (ESIA). Now only required by `src/ru-edge.js` — pushes the resulting token to GCP via `NALOG_TOKEN_SINK_URL` (`POST /nalog/token-store`) since that's where it's actually read from. |
| `src/connect-forms/` | HTML templates for `/connect/*` endpoints (nalog, gdrive, hh, getcourse, weeek, generic site). Each file exports a function that returns an HTML string. |
| `src/hooks/post-tool-use-artifacts.js` | Global `PostToolUse` Claude Code hook. Registered in `~/.claude/settings.json` via `runner.js`. Intercepts every tool-use response and stores extractable artifacts via `artifacts-store.js`. Skips sessions where `AGENT_USER_ID` is not set. |
| `src/inn-pipeline/` | Multi-source pipeline for company lookup by INN. Sources: `sources/dadata.js`, `sources/checko.js`, `sources/egrul.js`, `sources/bfo.js`, `sources/site-scraper.js`. Helpers in `lib/`: cache, matcher, usage-log, variants. |
| `src/site-connector.js` | Generic website connector: Playwright login → BFS crawl → Claude Haiku analysis → intent generation. Used by `POST /connect/site` and `src/user-sites.js`. |
| `src/user-sites.js` | Stores and loads connected-site settings per profile. Reads intents from the crawl results; used by `runner.js` to inject site-specific quick answers. |
| `src/engine-health.js` | Per-engine operational health (`healthy`/`degraded`/`unavailable`) in SQLite, separate from credentials (`auth-flag.js`) and failure history (`execution-history.js`). `markEngineSuccess` self-heals on success; `markEngineFailure` escalates at `ENGINE_UNAVAILABLE_AFTER_FAILURES`. Only class `AUTH` is credential-invalid. |
| `src/readiness.js` | `computeReadiness()` for `GET /readiness` — data dir writable, execution-owner lock present, ≥1 engine usable. A single unavailable engine does not make the server unready. |
| `src/failure-classifier.js` | Deterministic + cheap-LLM classifier mapping error text onto the fixed `FAILURE_CLASSES` enum (`failure-taxonomy.js`). Feeds `engine-health.js` and `execution-history.js`. |
| `src/mcp-skill-generation.js` | PR1 of the approved-MCP-source runtime wiring (issue #1367, design §12): pure generation compiler (`compileSourceGeneration`), `SessionMcpPlan` (`planSessionMcp`), full resolved generation snapshot + `RunBinding` materialization (`materializeSessionMcp`, contracts in `contracts/mcp-skill-runtime.schema.json`), operator status snapshot (`providerStatus`) and `acquireProvider` integrity API. |
| `src/mcp-action-broker.js`, `src/mcp-provider-journal.js` | PR2 (issue #1358/#1374): the narrow `ActionBroker` an adapter process talks to over a Unix socket (single execution owner — writes through `ActionExecutions`, never a second SQLite writer) and the provider lease journal (`scripts/mcp-provider-adapter.js` is the adapter entry point spawned per source). |
| `src/mcp-source-runtime.js` | PR2b host wiring (issue #1358/#1374): process-wide singleton (`getDefaultSourceRuntime()`) combining one compiled generation + one `ActionBroker` + per-run `SessionMcpPlan`/`RunBinding` materialization. `prepareRun({hostRunBinding, runtimeDir})` returns adapter server descriptors to merge into the engine's `.mcp.json`, or `null` when the run has no external servers. Inert by default (`enabled:false`, `prepareRun` a no-op) unless `MCP_SKILL_SOURCES_CONFIG` names an enabled source — production behaviour is unchanged until an admin activates one. Wired into `writeMcpConfig`'s `extraServers` (`src/browser.js`, merged via `mergeAdapterServers` — never shadows a core server name) from both `runner/index.js` and `hermes-tools-run.js`; `sourceRun.release()` runs in a `finally` right after the engine process exits. Because every engine (claude/codex/opencode) already derives its own MCP wiring from that one `.mcp.json`, no engine-specific code was needed — see `tests/mcp-source-runtime-engine-wiring.test.js`. |
| `scripts/refresh-weeek-session.js` | Refreshes `WEEEK_APP_COOKIE` in the Cloudflare Worker secret. Flow: capture cookies from Chrome via CDP → headless Playwright fallback → CF REST API update → Telegram alert on failure. Run manually or via `weeek-session-refresh.service`. |

### Quick answers — prefer instant replies over calling Claude

**Rule: if a response can be determined without calling Claude, make it a quick answer.**

Quick answers in `src/runner.js → getQuickAnswer()` bypass Claude entirely — zero latency, zero tokens, predictable output.

When to add a quick answer:
- User asks about a known capability: "есть ли скил X", "умеешь ли ты Y"
- User asks for a known setup flow: "подключи GitHub", "как добавить Weeek"
- User requests structured data that the server already has: `/secrets_list`, secrets log, revoke

How to add:
1. Add a regex constant near the other `*_INTENT` constants at the top of the function block
2. Add an `if (MY_INTENT.test(task)) return '...';` check inside `getQuickAnswer()` — before the `SETUP_INTENT` gate for non-setup patterns
3. For setup flows that generate a connect link, add an entry to `QUICK_SETUPS` array

**Do NOT route through Claude** for: yes/no capability questions, pre-scripted setup instructions, or anything where the server can produce the exact right answer deterministically.

#### Guard conditions — fall-through vs return null

When an intent matches but a guard condition fails, choose based on whether Claude adds value:

**Fall-through (do NOT `return null`):**
- Intent matched, but data is missing ("no vacancy", "not connected") and the next pattern may give a useful answer
- Example: `HH_REVIEW_PAGE_INTENT` + no active vacancy → fall-through, Claude gets the task as-is

**Return null (let Claude decide):**
- Intent matched, but the situation is genuinely ambiguous and Claude must use context
- Claude needs to autonomously call a tool (e.g. `gdrive_setup`) to handle the case
- Example: `GDRIVE_CAPABILITY_INTENT` + not connected → `null`, Claude calls `gdrive_setup`
- Example: `HH_REVIEW_PAGE_INTENT` + draft exists → `null`, Claude decides if user means publish or review

**Current audit of `return null` inside matched blocks:**

| Location | Guard | Verdict |
|----------|-------|---------|
| `GDRIVE_CAPABILITY_INTENT` + `!userId` | no profile | **Keep** — rare edge case, Claude answers fine |
| `GDRIVE_CAPABILITY_INTENT` + not connected | gdrive not configured | **Keep** — Claude calls `gdrive_setup` autonomously |
| `GDRIVE_SHARE_INTENT` + no SA config | gdrive not configured | **Keep** — Claude calls `gdrive_setup` autonomously |
| Illustrate intents + `!workDir` | no session context | **Keep** — no stateless answer possible |
| `ILLUSTRATE_ENABLE_INTENT` + draw command | combined enable+draw | **Keep** — enable first, then Claude draws (see trap #3) |
| `ILLUSTRATE_CAPABILITY_INTENT` + draw command | combined question+draw | **Keep** — Claude handles combined query |
| `HH_REVIEW_PAGE_INTENT` + draft exists | ambiguous context | **Keep** — Claude decides (vacancy publish vs review page) |
| `HH_REVIEW_PAGE_INTENT` + no active vacancy | no vacancy | **Fixed in #247** — now fall-through ✓ |

### Session management — architecture and traps

Sessions in Telegram are the core UX feature. Understanding the two-layer architecture prevents common bugs.

#### Two-layer storage

```
$USERS_DIR/<username>/
  sessions.json              ← INDEX: array of {id, topic, lastAt, messageCount, lastUserMessage}
  sessions/
    s-1234567890.json        ← FULL SESSION: {id, topic, messages: [{role, content, at}]}
    s-1234567891.json
    current-session.json     ← POINTER: {id, lastAt} — which session is "active" now
```

**Rule:** `sessions.json` (the index) is capped at 50 entries. The `sessions/<id>.json` files are the source of truth. `archiveSessions()` removes from both.

#### Session lifecycle

```
POST /run →
  1. Look up existing session (explicit sessionId from bot, or current-session.json within 4h TTL)
  2. getQuickAnswer() → if match: save exchange, return immediately (no Claude)
  3. If Claude path: appendUserMessage(), spawn Claude, stream output
  4. On Claude exit: appendReply(), setCurrentSessionId()
```

Key invariant: **user message is saved before Claude runs** (`appendUserMessage`), reply after. If Claude crashes mid-run, the user message is still in history.

#### Context injected into Claude

`buildContext(workDir, sessionId)` gives Claude the last 6 messages from the session, each truncated to 500 chars. Format:

```
[Продолжение сессии от 01.09.2026, 14:32]
Тема: "прочитай sales.xlsx"

Пользователь: прочитай sales.xlsx
Клод: Прочитал файл. 3 листа: Продажи, Расходы, Итог. Что нужно?
Пользователь: сделай сводку по итогам
```

Then the current task is appended as `Пользователь: <task>`. Without the "Пользователь:" prefix, Claude reads the last session message as the current request.

#### Common traps

**1. Never construct a profile path inline — resolve it via `src/data-paths.js`.**
```js
// ❌ Wrong — hardcodes the legacy AGENT_DATA_DIR/sessions tree and breaks on a path change
const workDir = path.join(os.homedir(), 'agent-data', 'sessions', username);

// ✅ Right — canonical per-profile workspace root (USERS_DIR/<username>)
const { userWorkDir } = require('./data-paths');
const workDir = userWorkDir(username);
```
Roots are set explicitly in systemd (`USERS_DIR=/home/vova/users`, `AGENT_DATA_DIR=/home/vova/agent-data`, `AGENT_TOKENS_DIR=/home/vova/agent-tokens`). Always go through the resolver — inline `os.homedir()` derivation drifts and breaks tests.

**2. Quick answers that touch state still need null-guard on `workDir`.**
```js
// ❌ Wrong — getQuickAnswer can be called with workDir=null
const flagPath = path.join(workDir, 'contexts', 'feature', '.enabled');

// ✅ Right
if (!workDir) return null;
const flagPath = path.join(workDir, 'contexts', 'feature', '.enabled');
```

**3. Enable-intent + draw-command combination.**  
If a user message matches BOTH an enable intent ("включи иллюстрации") AND a draw command ("нарисуй лёгкие"), the correct behavior is: **enable the skill first**, then return `null` so Claude handles the draw. Never return `null` before enabling — Claude won't have the tool registered yet.

```js
if (ENABLE_INTENT.test(task)) {
  enableSkill(workDir);                     // ← always do this first
  if (DRAW_COMMAND.test(task)) return null; // ← then let Claude draw
  return 'Скил включён!';
}
```

**4. All token files must be `mode 0o600`.**
```js
// connect-pending, agent-tokens — both must use:
fs.writeFileSync(filePath, content, { mode: 0o600 });
```
Files without an explicit mode default to `0o644` (world-readable on a shared VM).

**5. External API calls need timeouts.**
```js
// ❌ Wrong — hangs forever if API is down
const res = await fetch('https://api.hh.ru/...');

// ✅ Right
const res = await fetch('https://api.hh.ru/...', {
  signal: AbortSignal.timeout(15_000),
});
// Or for http.request: req.setTimeout(15_000, () => req.destroy(...))
```

**6. POST handler JSON.parse needs try/catch.**
```js
// ❌ Wrong — throws on bad JSON, can crash the process
const body = JSON.parse(await readBody(req));

// ✅ Right
let body;
try { body = JSON.parse(await readBody(req)); }
catch { return json(res, 400, { error: 'bad json' }); }
```

**7. `sessions.js` is deleted — don't recreate it.**  
The real session store is `src/session-store.js`. There used to be a dead file `src/sessions.js` with a `SessionManager` class — it was never used. If you need session functionality, use `session-store.js`.

#### server.js is a large file — where things live

`server.js` is ~2900 lines. Key sections:
- Lines 1–100: OAuth state store, HH scoring scheduler
- Lines 100–1040: All `/connect/*` and `/hh/*` OAuth/form routes
- Lines 1040+: Remaining API routes (auth-gated)
- Lines 2800+: `hhApiRequest`, `tgNotifyNalog`, `generateReviewPageHtml` helpers

When adding HH-related code, the helpers (`hhApiRequest`, `hhApiPost`) are at the bottom of `server.js`.

---

## Testing & Debugging Guide

### How to send a message as a user (from agent session)

Claude Code runs inside the agent session with env vars injected from `runner.js`:

| Env var | Value | What it is |
|---------|-------|------------|
| `AGENT_USER_ID` | `"alice"` | Profile name (= `username`) — owns files and tokens |
| `AGENT_CHAT_ID` | `"123456789"` | Telegram **chat ID** where output streams to |
| `AGENT_BOT_TOKEN` | `"7xxx:AAA..."` | Bot token used to call Telegram API |

**Send a message to the user's Telegram chat from a script:**

```bash
# from agent session (Claude subprocess) — env vars already set
curl -s -X POST "https://api.telegram.org/bot${AGENT_BOT_TOKEN}/sendMessage" \
  -H 'Content-Type: application/json' \
  -d "{\"chat_id\": ${AGENT_CHAT_ID}, \"text\": \"hello from agent\"}"
```

**From the VM shell (bypass agent):**

```bash
BOT_TOKEN=$(grep BOT_TOKEN ~/secrets.env | cut -d= -f2)
CHAT_ID=$(cat ~/agent-tokens/alice/.chatid)

curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -H 'Content-Type: application/json' \
  -d "{\"chat_id\": ${CHAT_ID}, \"text\": \"test message\"}"
```

**Edit an existing message** (agent streams output this way):

```bash
curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/editMessageText" \
  -H 'Content-Type: application/json' \
  -d "{\"chat_id\": ${CHAT_ID}, \"message_id\": 42, \"text\": \"updated text\"}"
```

**Send a file:**

```bash
curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendDocument" \
  -F chat_id="${CHAT_ID}" \
  -F document=@/path/to/file.pdf
```

---

### How to find which Telegram chat(s) a profile uses

Each profile has a `.chatid` file written when the first task runs:

```bash
# on the VM
cat ~/agent-tokens/<username>/.chatid         # e.g. cat ~/agent-tokens/alice/.chatid → 123456789
```

The file is updated on every `/run` call — it always holds the **most recent** chat ID that sent a task.

> **Many-chats-one-profile:** A profile may be shared across multiple chats (configured in the bot via `CHAT_MAPPINGS`). The `.chatid` file only stores the last one. To find all chats for a profile, check the bot's `CHAT_MAPPINGS` env var in the Cloudflare Worker — the agent server itself has no list.

**List all profiles and their last-seen chat IDs:**

```bash
for d in ~/agent-tokens/*/; do
  username=$(basename "$d")
  chatid=$(cat "$d/.chatid" 2>/dev/null || echo "—")
  echo "$username → $chatid"
done
```

**Find which profile owns a given chat ID:**

```bash
grep -r "^123456789$" ~/agent-tokens/*/.chatid 2>/dev/null
```

---

### Where profile state lives on disk

```
~/agent-tokens/<username>/
  .chatid                 ← last Telegram chat ID (numeric string)
  hh                      ← HH OAuth token (JSON)
  gdrive                  ← GDrive service account path (JSON)
  gdrive-catalog.json     ← cached GDrive folder listing
  nalog                   ← nalog.ru auth token (JSON, expires ~1h)
  weeek                   ← Weeek API token (plain text)
  weeek-login             ← Weeek session token (written by server.js /connect/weeek)
  github                  ← GitHub personal access token (plain text)
  getcourse/config.json   ← GetCourse API key + session cookies

~/users/<username>/              ← USERS_DIR: canonical per-profile workspace
  sessions.json                 ← session index (50 most recent)
  sessions/
    s-<id>.json                 ← full session with messages
  current-session.json          ← pointer to active session
  .pin_state.json               ← pinned context card state (msgId + chatId)
  profile.json                  ← user profile (about, preferences)
  requirements-log.md           ← per-user requirements log
  contexts/                     ← key-value state for MCP skills (03-context-store.js)
    <skill>/
      <key>.json
  projects/<projectId>/         ← cwd for sessions of that project (projects.js)
  artifacts/artifacts.jsonl     ← operational: extracted artifacts (post-tool-use hook)
  sites/<slug>/                 ← operational: connected-site config (user-sites.js)
  calltips-latest.json          ← operational: last Call Tips plan
  video-analysis/ interview-analysis/   ← operational: analyses
  .inn-config.json              ← operational: INN-pipeline keys

~/agent-data/                    ← SYSTEM_ROOT: server-wide operational state (NOT per-profile)
  system-flags/claude_auth.json  ← engine auth flag (auth-flag.js)
  pending-tasks/ execution-history/ hh/<username>/ …
```

> Legacy `~/agent-data/sessions/<username>/` is deprecated — `scripts/migrate-workspaces.mjs` merges it into `~/users/<username>/` (dry-run/apply/rollback, ledgered, idempotent).

---

### How to simulate a POST /run call (test as a specific user)

```bash
# on the VM or locally (needs AGENT_SECRET)
AGENT_SECRET=$(grep AGENT_SECRET ~/secrets.env | cut -d= -f2)

curl -s -X POST http://localhost:3000/run \
  -H "Authorization: Bearer ${AGENT_SECRET}" \
  -H 'Content-Type: application/json' \
  -d '{
    "userId": 123456789,
    "username": "alice",
    "task": "привет, что умеешь?",
    "context": "",
    "initialMsgId": 0
  }'
# → 202 {"taskId":"alice-1234567890"}
# Output streams to Telegram chat 123456789
```

To redirect output somewhere else (e.g. your own chat) during testing — just change `userId` to your chat ID. The `username` controls which files/tokens Claude sees; `userId` controls where the reply goes.

---

### Telegram API reference (what the agent uses)

All calls go to `https://api.telegram.org/bot<TOKEN>/<method>`.

| Method | When used |
|--------|-----------|
| `sendMessage` | New message (initial "thinking…" + quick answers) |
| `editMessageText` | Stream Claude output into existing message |
| `pinChatMessage` | Pin the context card |
| `sendDocument` | Send a file to the user |
| `sendPhoto` | Send an image |

**sendMessage minimal:**

```json
POST /bot<TOKEN>/sendMessage
{
  "chat_id": 123456789,
  "text": "message text",
  "parse_mode": "Markdown"    // optional — enables *bold*, _italic_, `code`
}
```

**Inline keyboard button:**

```json
{
  "chat_id": 123456789,
  "text": "Choose an option",
  "reply_markup": {
    "inline_keyboard": [[
      { "text": "Option A", "callback_data": "prefix|value" }
    ]]
  }
}
```

> Callback data is handled in the bot (Cloudflare Worker). If you add a new `callback_data` prefix in `runner.js`, also register it in `KNOWN_CALLBACK_PREFIXES` in `trained-assist-tg-bot/tests/callbacks.test.js`.

**Get your own chat ID** (useful when testing):
1. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` after sending any message to the bot
2. Look for `message.chat.id` in the response

---

### Checking what's connected for a profile

```bash
# List token files for a profile
ls ~/agent-tokens/<username>/

# Check HH token validity
node -e "
const t = JSON.parse(require('fs').readFileSync(require('os').homedir()+'/agent-tokens/alice/hh','utf8'));
console.log('expires:', t.expires_in, '| access_token:', t.access_token?.slice(0,20)+'...');
"

# Check nalog token
node -e "
const t = JSON.parse(require('fs').readFileSync(require('os').homedir()+'/agent-tokens/alice/nalog','utf8'));
console.log('expires:', t.expires, '| has_token:', !!t.auth_token);
"

# Hit /capabilities to see what the bot router sees
AGENT_SECRET=$(grep AGENT_SECRET ~/secrets.env | cut -d= -f2)
curl -s -H "Authorization: Bearer ${AGENT_SECRET}" \
  "http://localhost:3000/capabilities?userId=alice"
```

---

### Testing browser-session skill and site login (credentials_form_create / browser_session_autologin)

When debugging the connect-to-any-site flow, test directly on the VM via SSH instead of going through Telegram manually.

#### Full flow for a new site

```bash
# 1. Check if credentials are saved (after user fills ZeroCreds form)
cat ~/agent-tokens/<username>/<service-key>
# e.g. cat ~/agent-tokens/efi/kinescope-creds
# → {"email":"user@example.com","password":"..."}

# 2. Test login.js directly
LOGIN_EMAIL="user@example.com" \
LOGIN_PASSWORD="secret" \
LOGIN_URL="https://app.example.com/login" \
timeout 30 node ~/browser-session/login.js
# Expected outputs:
# {"ok":true, "navigated":true} → login succeeded (URL changed)
# {"ok":true, "already_logged_in":true} → already logged in (session alive)
# {"ok":false, "google_redirect":true} → account uses Google OAuth, need noVNC
# {"ok":false, "error_on_page":true} → wrong credentials

# 3. Check what the browser is currently showing
node -e "
const P = require('/home/vova/trained-assist-agent/node_modules/playwright');
(async () => {
  const b = await P.chromium.connectOverCDP('http://127.0.0.1:9224');
  const p = b.contexts()[0].pages()[0];
  console.log('URL:', p.url());
  console.log('Title:', await p.title());
  b._connection.close();
})().catch(e => console.error(e.message));
"

# 4. Test the full agent flow by calling /run from the outside
AGENT_SECRET=$(grep AGENT_SECRET ~/secrets.env | cut -d= -f2)
CHAT_ID=$(cat ~/agent-tokens/<username>/.chatid)
curl -s -X POST "http://localhost:3000/run" \
  -H "Authorization: Bearer $AGENT_SECRET" \
  -H "Content-Type: application/json" \
  -d "{\"userId\": $CHAT_ID, \"username\": \"<username>\", \"task\": \"войди в example.com используя <service-key>. login_url: https://app.example.com/login\", \"context\": \"\", \"initialMsgId\": 0}"
# Output streams to user's Telegram chat. Watch logs:
sudo journalctl -u assist-agent -f
```

#### Known login.js behaviours

| Scenario | What login.js does | Result |
|----------|--------------------|--------|
| Site with multiple login providers (Google, VK, email+password) | Skips OAuth buttons by text; clicks the exact "Войти"/"Log in" button | Correct button clicked |
| Already logged in (SPA redirects /login → /dashboard) | `goto` with `load` then `waitForNavigation(3s)` catches the redirect | `already_logged_in: true` |
| Clicked "Войти" and got redirected to `accounts.google.com` | Detects `google_redirect: true` | Tells user to use noVNC |
| SPA login (URL stays same, only content changes) | Checks `titleBefore !== titleAfter` as fallback for `navigated` | `navigated: true` |

#### Common debugging mistakes

- **Don't use `networkidle` for goto** — active SPAs (Kinescope, etc.) continuously poll APIs and never reach idle state. Use `load` + `waitForNavigation(3s timeout)`.
- **Don't kill Chrome** (`pkill chrome`) — kills the persistent browser session and MCP. Just kill the stuck Claude process: `kill <PID>`.
- **Stuck Claude process** — if `browser_session_autologin` hangs, check `ps aux | grep claude` and kill. Never reuse login.js output from a hung process.

---

### Git workflow — PR-first, enforced locally by hooks
**Never push directly to `main`.** All changes go through a feature branch + PR:

```bash
git checkout -b feature/my-change
# make changes, commit
git push -u origin feature/my-change
gh pr create --fill          # opens PR, triggers CI
gh pr merge --squash --delete-branch  # after CI is green
```

CI runs on every PR (`npm ci` → syntax check → unit tests). Deploy to GCP + RU VMs only fires on merge to `main`.

GitHub branch protection is not available on this private repo (free plan), so the rule is enforced client-side via `.githooks/` (run `scripts/install-git-hooks.sh` once per clone — a fresh session should verify `git config core.hooksPath` is set to `.githooks` before doing anything else):
- **pre-commit** blocks any commit made directly on `main`/`master` — create a branch first.
- **pre-push** blocks pushing to `main`/`master`, and blocks pushing *again* to a branch that already has an OPEN pull request. **PRs are immutable**: once a branch is submitted as a PR, don't amend/force-push it — open a new branch and a new PR for further changes, even to fix CI. This is what keeps sessions from colliding on the same branch/PR.
- Both have a documented emergency override env var (`ALLOW_PROTECTED_COMMIT=1` / `ALLOW_PR_UPDATE=1`) for the rare intentional exception — always explain why in the commit/PR when used.

### Спавн сессии на реализацию issue — дешёвый агент, не claude

Реализацию issue запускать **отдельной сессией** через Session Manager (не внутренним субагентом):

```bash
curl -s -N -X POST http://localhost:3000/api/sessions/start \
  -H "Content-Type: application/json" \
  -d '{"path": "'"$PWD"'", "message": "Implement issue #N: <title>", "agent": "opencode"}'
```

Выбор агента — `claude` дорогой, не ставить по умолчанию:
- `opencode` — **дефолт для реализации кода** (deepseek), самый дешёвый;
- `codex` (`gpt-5.4-mini`) — если opencode не тянет (сложный рефакторинг, много файлов);
- `claude` — только для архитектуры, ревью, research.

Всегда `-N` и вытаскивать `session_id` из SSE-ответа, иначе не видно, что сессия стартовала.

---

## CI Failure Handling — автоматическое

CI-падения обрабатываются автоматически через Session Manager — никаких дополнительных действий не нужно.

Когда CI падает на любом PR, `ci-failure-reporter.yml` отправляет событие в Session Manager. Session Manager:
1. Ищет локальный путь к репозиторию по имени
2. Проверяет, нет ли уже активной сессии для этого проекта
3. Если нет — запускает короткую одноразовую сессию-фиксер с контекстом падения
4. Фиксер чинит проблему, коммитит, пушит — CI перезапускается автоматически
5. Если не может починить — пишет `CI_FAILURE_SUMMARY.md` в корень проекта и уведомляет через Telegram

**Не нужно:**
- Встраивать session ID в тело PR
- Ставить алармы вручную
- Следить за CI из той же сессии

**PR создаётся просто:**
```bash
gh pr create --title "feat: ..." --fill
```
