# Compatibility credential file-store contract

This is the encrypted file-format contract used by compatibility readers/writers, not a deployment or migration plan. Host credential resolution and lifecycle follow [the shared architecture](https://github.com/trained-assist/trained-agent-architecture/blob/main/ARCHITECTURE.md). Current rollout/key-rotation/TTL tasks live in [#1789](https://github.com/trained-assist/trained-assist-agent/issues/1789). A file-store format does not permit ambient credentials in an Agent Run.

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

## Master key injection

The host supplies CRED_ENCRYPTION_KEY explicitly through its trusted secret/config binding. Test uses a synthetic key. Google Secret Manager remains permitted, but the retiring GCP VM is not a deployment target. Encryption mode must be compatible with every enabled reader; no document declares those readers or a deployed key ready. Secrets and master keys never enter Git, prompts, logs or complete inherited Run env.

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

## Verification contract (`test/credential-store.test.cjs`)

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
