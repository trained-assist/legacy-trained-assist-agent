# capability-relay contract v1

The file `capability-relay-v1.contract.json` next to this README is the single source of
the tools/schema mapping for capability calls: REST clients and the MCP relay
(`src/capability-relay/`) both read it, which is what keeps a direct API call and a
relayed call identical by construction rather than by review.

Owner: the capability (Cloudflare) side. Here the contract is only consumed.
Changes are ADDITIVE — a new capability is one more entry in `tools[]`; a breaking change
bumps `version` and every side refuses a mismatch explicitly (`version_mismatch`) instead
of silently switching handlers.

What this contract deliberately does NOT carry yet (arrives with the following PRs, see
issue #2061 §6): the manifest binding contract version → handler release, retry/reconcile
semantics with operationId (PR3), and the host-issued identity issuer (PR2). PR1 relays
the identity field as an opaque value it never inspects.

Verify locally: `node --test test/capability-relay.contract.test.cjs` — the contract must
validate against `capability-relay-v1.contract.schema.json`, and `tools/list` must stay a
1:1 projection of `tools[]`.
