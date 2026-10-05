# VM2 GCS Archive — Workload Identity Federation

Issue #2114 P0.6. The session archive (`trained-assist-workspaces`) must be reachable from the
Contabo box after GCP is shut down. This document is the reference for how that credential is
supposed to work, what is already built, and exactly where it is stuck.

## Why not a service-account key

Two independent constraints rule out the obvious approach:

| Constraint | Source |
|---|---|
| `constraints/iam.disableServiceAccountKeyCreation` is enforced on the project | org policy, inherited from organization `1063113994654` |
| Contabo has no ADC metadata server | the box is not a GCP VM |

So the credential is **federated**: a local issuer signs a subject token, Google STS verifies it
against a JWKS this box serves publicly, and STS returns a token that impersonates the archive SA.
No key file ever touches disk.

## Architecture

```
VM2 (Contabo, France)                                    GCP
─────────────────────                                    ──────────────────────────
systemd wif-oidc (127.0.0.1:18080)
  └─ signs {iss, sub, aud} with RSA key
       │
       │  GET /.well-known/jwks.json          ──────────►  Google STS
       │  (public, via nginx on the box's                    verifies signature
       │   own origin 169-58-15-230.sslip.io)                against the JWKS
       │                                                     │
       │  POST /v1/token  ◄────────────────────────────────  │
       │  grant_type=token-exchange                           │
       │  subject_token=<signed JWT>                         │
       │                                                     │
       │  federated access token (sub=vm2-archive)           │
       │                                                     │
       │  POST …/generateAccessToken  ─────────────────────►  IAM Credentials API
       │  Bearer <federated token>                            impersonates the SA
       │                                                     │
       │  SA access token  ◄────────────────────────────────  │
       │                                                     │
       │  GCS JSON API  ──────────────────────────────────►  storage.googleapis.com
       │  Bearer <SA token>                                     trained-assist-workspaces
```

### The three claims STS checks

All three were load-bearing; each one broke the exchange in a distinct way:

| Claim | Requirement | Symptom when wrong |
|---|---|---|
| `iss` | must equal the provider's `--issuer-uri` | `The issuer in ID Token null does not match the expected one` |
| `aud` | must equal the provider's `--allowed-audiences` | `invalid_target` |
| `sub` | becomes the federated principal; the SA grant names it as `principalSet/…/attribute.sub/<sub>` | exchange succeeds, but no permission matches |

### Why the issuer is public

Google STS fetches the issuer metadata **from the public internet** to verify the subject token.
There is nothing secret on those routes — a JWKS is a public key set by definition. Every other
route on the origin stays authenticated.

The routes live **inside the existing TLS server block** of `infra/nginx/agent-vm2.conf`, not in
a second `server` block with the same `server_name`: nginx silently keeps only the first block,
so a separate block makes `/.well-known` 404 and STS reports `Error connecting to the credential's
issuer`. `test/deploy-nginx.test.cjs` asserts there is exactly one TLS block and that the issuer
routes are inside it.

## What is built

| Piece | Where | State |
|---|---|---|
| WIF pool | `ta-vm2` | created |
| OIDC provider | `ta-vm2-public`, issuer `https://169-58-15-230.sslip.io` | ACTIVE |
| Local issuer | `/opt/wif/oidc-server.js`, systemd `wif-oidc`, 127.0.0.1:18080 | running |
| RSA keypair | `/opt/wif/private.pem`, `public.pem` | 0600 |
| Public JWKS | `https://169-58-15-230.sslip.io/.well-known/jwks.json` | 200, valid TLS |
| Credential config | `/opt/wif/credentials.json` (external account, no SA impersonation) | 0600 |
| Archive SA | `session-archive-vm2@alesa-personal-assistent.iam.gserviceaccount.com` | created |
| SA IAM bindings | `workloadIdentityUser` + `serviceAccountTokenCreator` for the pool principal | set |
| Bucket binding | `principalSet://…/ta-vm2/attribute.sub/vm2-archive` → `roles/storage.objectAdmin` on `trained-assist-workspaces` | set |
| nginx routes | `infra/nginx/agent-vm2.conf` (PR #2129) | merged |

## What works

The token exchange itself succeeds end to end:

```bash
SUBJ=$(curl -s http://127.0.0.1:18080/token | jq -r .access_token)
curl -s -X POST https://sts.googleapis.com/v1/token \
  --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  --data-urlencode "audience=//iam.googleapis.com/projects/731388616698/locations/global/workloadIdentityPools/ta-vm2/providers/ta-vm2-public" \
  --data-urlencode "requested_token_type=urn:ietf:params:oauth:token-type:access_token" \
  --data-urlencode "subject_token_type=urn:ietf:params:oauth:token-type:jwt" \
  --data-urlencode "subject_token=$SUBJ" \
  --data-urlencode "scope=https://www.googleapis.com/auth/cloud-platform"
# → {"access_token":"ya29.d.…","token_type":"Bearer","expires_in":3597}
```

The token is a valid Google credential — proven by granting `allUsers` on a throwaway bucket and
getting a successful `objects.list`.

## Where it is stuck

`iam.serviceAccounts.getAccessToken` is denied for the federated principal, so the
impersonation step cannot complete:

```
POST …/serviceAccounts/session-archive-vm2@…:generateAccessToken
→ 403 Permission 'iam.serviceAccounts.getAccessToken' denied
```

The SA now carries both `roles/iam.workloadIdentityUser` and `roles/iam.serviceAccountTokenCreator`
for the pool principal, and the denial persists. That points at the **identity not resolving to
the principalSet** rather than at a missing role: the same 403 appears for every principalSet
format tried (`attribute.sub/vm2-archive`, `attribute.sub/*`, `attribute.google.subject/…`, with
and without the `/providers/…` segment), for `allAuthenticatedUsers`, and for the project's own
service accounts — while `allUsers` succeeds.

## Second, separate symptom

IAM permissions on this project **flap**. An account holding `roles/owner` with no condition
intermittently gets `PERMISSION_DENIED` on operations that succeed minutes later — including
`storage.buckets.setIamPolicy`, which worked and then stopped. For an owner this is not normal
and suggests an **IAM Deny policy** rather than a missing role.

## What is needed

One of:

1. **Grant the pool principal `iam.serviceAccounts.getAccessToken`** on
   `session-archive-vm2@alesa-personal-assistent.iam.gserviceaccount.com` — if the identity
   resolution is the real blocker this will not be enough, and the next item applies.
2. **Inspect the project's IAM Deny policy** (`denyPolicies` in the project IAM policy). An owner
   being denied `getIamPolicy` / `getAccessToken` / `setIamPolicy` intermittently is not a
   role problem.

## Fallback

Without GCS the archive degrades to **local-only**: nothing is deleted, failures are reported,
and the next run retries. This is the documented behaviour for an unreachable bucket and does not
block P2 (switching consumers) — only the post-shutdown readability of session history (P4).
