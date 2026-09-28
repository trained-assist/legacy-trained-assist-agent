# Credential Store Migration Plan

_Last updated: 2026-09-03_

> **Status — implemented (P0 C4, epic #1789).** `src/credential-store.js` is the
> single module (envelope format, `.meta` sidecars, `.index.json`, plaintext
> fallback); every credential read/write under `TOKENS_ROOT` in `src/` and
> `scripts/` goes through it; `scripts/encrypt-tokens.mjs` is the one-time
> migration (`--dry-run` to preview, originals backed up to
> `agent-tokens/.backup-<ts>/`). TTL filtering of `/capabilities` (Phase 2) and
> key rotation are still open. **Rollout is gated on the key**: with no
> `CRED_ENCRYPTION_KEY` in `secrets.env` everything stays plaintext, so the
> encryption switch-on must follow the sibling domain repos getting decrypt
> support (they still read these files with raw `fs.readFileSync`).

## Problem Statement

User credentials (GitHub, Weeek, nalog tokens, etc.) are stored as **plain text files** on the VM:

```
~/agent-tokens/
  efi/
    github          ← raw text: "ghp_xxxxx"
    weeek           ← raw text: "api_xxxxx"
    nalog           ← JSON: { auth_token, refresh_token, expires, ... }
    gdrive          ← JSON: full service account key
```

**Current risks:**
1. **Plain text at rest** — SSH access to VM = access to all user tokens
2. **No TTL enforcement** — nalog tokens expire in ~1h but `/capabilities` still reports `nalog` as available for hours after expiry
3. **Flat directory, no index** — querying "which users have nalog?" requires scanning every user directory
4. **No revocation cascading** — revoking a token doesn't touch any associated refresh tokens or OAuth sessions
5. **Migration debt** — legacy numeric chatId dirs still on disk, partially migrated

---

## Chosen Approach: Encrypted File Store

Keep the existing directory structure (`~/agent-tokens/{username}/{service}`) but:
1. **Encrypt each token file** with AES-256-GCM using a master key stored in GCP Secret Manager / secrets.env
2. **Add `{service}.meta` sidecar files** with expiry + audit metadata (no encryption — not sensitive)
3. **Add `.index.json`** at the tokens root for cross-user queries

**Why not alternatives:**
- **GCP Secret Manager per user token**: API latency on every request, costs money, not available on RU VM
- **SQLite**: new heavy dependency, overkill for current user count
- **Keep plain text**: unacceptable once there are real user credentials at risk

---

## New File Layout

```
~/agent-tokens/
  .index.json             ← { "efi": ["github", "nalog"], "recruiter": ["weeek"] }
  efi/
    github                ← encrypted blob (base64)
    github.meta           ← { service, created_at, expires_at, last_used_at, version: 2 }
    nalog                 ← encrypted blob (base64)
    nalog.meta            ← { service, created_at, expires_at: "2026-09-03T14:00:00Z", last_used_at }
    .secrets_log          ← unchanged (append-only audit log, plain text)
```

**Encrypted format (per file):**
```
<version_byte=2><iv_16_bytes><auth_tag_16_bytes><ciphertext>
```
Base64-encoded, stored as a text file. Version byte allows future format changes.

**Legacy plain text files:** files without the version byte prefix are detected and read as plain text + transparently re-encrypted on next write.

---

## Master Key Management

| VM | Source | Key name |
|----|--------|----------|
| GCP VM | GitHub Actions secret → CI writes `/home/vova/secrets.env` → systemd `EnvironmentFile=` → `process.env` (same channel as `AGENT_SECRET` / `INN_*`) | `CRED_ENCRYPTION_KEY` |
| RU VM | — (not written: `agent-tokens` on RU holds only `.chatid` plus the legacy local `nalog` copy, which has no reader there — it stays plaintext with a warning) | `CRED_ENCRYPTION_KEY` |
| Dev/test | `CRED_ENCRYPTION_KEY` env var | (test-specific 32-byte hex key; test harnesses delete it so fixtures stay plaintext) |

**Key generation:**
```bash
openssl rand -hex 32  # → 64-char hex string, store as CRED_ENCRYPTION_KEY
```

Key is loaded once at process startup, held in memory. If missing, falls back to plain text (warning logged). This maintains backward compatibility.

---

## TTL / Expiry Metadata

The `.meta` sidecar stores:
```json
{
  "service": "nalog",
  "created_at": "2026-09-03T13:00:00Z",
  "expires_at": "2026-09-03T14:00:00Z",
  "last_used_at": "2026-09-03T13:30:00Z",
  "version": 2
}
```

`expires_at` is set by the caller at write time:
- **nalog**: now + 1h (matches lknpd.nalog.ru session lifetime)
- **GitHub, Weeek, etc.**: null (no TTL)
- **HH OAuth access token**: now + 24h (HH default)

`/capabilities` endpoint: reads `.meta` and returns service as available **only if** `expires_at` is null or in the future.

---

## Implementation Plan

### Phase 1: Encryption layer (no behavior change) — ~3h

**File: `src/credential-store.js`** (new — replaces raw fs calls in `user-tokens.js`)

```js
// Key functions:
encryptToken(plaintext)   // → base64 blob
decryptToken(blob)        // → plaintext (detects v1=plain, v2=encrypted)
readToken(userId, service)
writeToken(userId, service, value, { expiresAt })
deleteToken(userId, service)
listTokens(userId)        // → [{ service, expiresAt, lastUsedAt }]
isTokenValid(userId, service)  // checks expiry
```

**`src/user-tokens.js`**: replace `fs.readFileSync` / `fs.writeFileSync` calls with `credential-store.js` equivalents. The public API of `user-tokens.js` is unchanged.

**`src/server.js` (POST /tokens endpoint)**: pass `expiresAt` when writing nalog tokens.

### Phase 2: TTL enforcement — ~1h

- `listConnectedServices()`: filter out expired tokens (don't show them)
- `/capabilities` endpoint: `isTokenValid()` instead of just `fs.existsSync()`
- `getQuickAnswer()` status check: expired nalog token → "токен просрочен, обновите через расширение"

### Phase 3: Index + cleanup — ~1h

- `writeToken()` updates `~/agent-tokens/.index.json`
- `deleteToken()` removes from index
- Cron-style cleanup: on server startup, scan index for expired tokens and delete them
- New endpoint: `GET /admin/token-stats` (AGENT_SECRET auth) → counts per service, expired count

### Phase 4: Migration of existing tokens — ~30min

- **As implemented:** `node scripts/encrypt-tokens.mjs` does it in one pass
  (backed up, idempotent, `--dry-run` to preview). Reads never rewrite: a legacy
  plaintext file is read transparently and re-encrypted on its **next write**, so
  nothing is mutated behind the caller's back.
- Lazy "re-encrypt on first read" (the earlier idea) was rejected: a read that
  writes back can race with concurrent writers and turns a read-only diagnostic
  into a mutation.

---

## Changes Required

### New files
- `src/credential-store.js` — encryption layer + `.meta` / `.index.json` bookkeeping
- `test/credential-store.test.cjs` — round-trip, legacy plaintext, tamper detection,
  missing-key fallback, index, mode 0600 (runs in `npm run test:cjs`)
- `scripts/encrypt-tokens.mjs` — one-time migration (`--dry-run`, idempotent,
  originals backed up to `agent-tokens/.backup-<ts>/`)

### Modified files
- `src/user-tokens.js` — use `credential-store.js` instead of direct `fs` calls
- `src/server.js` — pass `expiresAt` in POST /tokens for nalog; add `/admin/token-stats`
- `src/runner.js` — use `isTokenValid()` in capability check (or leave to server.js)
- `infra/env-manifest.json` — add `CRED_ENCRYPTION_KEY` to secrets list
- `scripts/check-env-sync.js` — will auto-pick up from manifest

### CI / infra (done in the C4 PR)
- `infra/env-manifest.json` → `github_actions_secrets.app`, `written_to: ["gcp"]`
- `ci.yml` **and** `deploy-manual.yml` GCP printf blocks write it into
  `/home/vova/secrets.env` — a manual deploy rewrites that file, so both workflows
  must carry the key or the next manual deploy silently drops it
- Run `node scripts/check-env-sync.js` — validates manifest ↔ ci.yml (green)
- **Operator step (not in the repo):** `gh secret set CRED_ENCRYPTION_KEY --body "$(openssl rand -hex 32)"`.
  Until the secret exists the printf writes an empty value → the store stays
  plaintext (by design: safe default, warning logged)

---

## Tests (implemented — `test/credential-store.test.cjs`)

```js
// Encrypt/decrypt round-trip
// Legacy plain text file → transparently read, re-encrypted on write
// writeToken with expiresAt → .meta file created
// isTokenValid → false when expires_at is in the past
// isTokenValid → true when expires_at is null
// listTokens → filters out expired entries
// deleteToken → removes both token file and .meta
// Missing CRED_ENCRYPTION_KEY → falls back to plain text + logs warning
// Concurrent writes → no corruption (fs.writeFileSync is atomic on POSIX)
```

---

## Security Notes

- **The master key is as sensitive as any individual token** — treat it like `AGENT_SECRET`
- **AES-256-GCM** provides authenticated encryption — tampering detected on read
- **Each token uses a unique random IV** — same token value produces different ciphertext
- **Key rotation**: to rotate, generate new key, re-encrypt all files (run `scripts/rotate-cred-key.js` — to be written)
- **GDrive service account JSON** is large — encryption works the same, no size limit issue
- **`.secrets_log` stays plain text** — it's an audit trail of service names only, no token values

---

## Out of scope (not in this migration)

- Key rotation tooling (separate PR after migration is stable)
- Cross-VM sync of user tokens (different problem, different solution)
- Nalog token auto-refresh (requires device_source flow, separate feature)
- OAuth token refresh for HH/GDrive (handled by their respective auth flows already)
