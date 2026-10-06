# Agent Profile Context v1

This producer-owned contract defines the identity boundary a Connected App may consume from the Agent. It does not define an app grant, a provider credential, or an Agent Run delegation.

The only valid context is resolved from an authenticated, server-owned Agent session and Agent-owned user-to-profile membership. The caller cannot choose `principalId` or `profileId`. A profile switch changes `profileGeneration`; logout, revoked membership, a disabled principal, a stale selection, or a revoked session yields no current context. An unavailable authority is a typed failure and must deny protected reads and effects.

The typed interface has two operations: `resolveBrowserSession(request)` resolves the current Agent browser session; `resolveCurrentSession(sessionId)` re-reads its present principal, membership, selected profile and generation. Consumers must compare the full context and generation at each authorization boundary. A context is not a durable schedule grant or task/run delegation.

## Current implementation boundary

This repository currently has no implementation of this authority contract. Its legacy `web_current` cookie is browser-readable and selects among per-profile JWTs; those JWTs identify only a profile username. Neither proves an authenticated human principal, Agent-owned membership, or a current selection generation. They must not be adapted into this contract. No production Connected App resolver is enabled by this document.

Implementation requires an existing trusted Agent user/session and membership source in a supported runtime. It must not add a service, scheduler, or dependency to the retiring GCP VM, and it must not create a new login provider as a side effect of contract adoption.

The Control Plane may implement a private typed adapter to this interface in the same supported Worker. A separately deployed authority would require its own signed assertion protocol and replay protection; it is outside this local typed contract.

Validation: `node --test test/agent-profile-context-v1.contract.test.cjs`. This checks the published JSON contract and schema only; it is not runtime identity acceptance.
