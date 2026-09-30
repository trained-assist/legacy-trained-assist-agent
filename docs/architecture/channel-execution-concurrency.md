# Channel execution concurrency (normative)

Epic: #1365. Code contracts: `src/core/conversation-ref.js`, `src/core/execution-context.js`.
Scenarios/acceptance: `docs/user-scenarios/core/01-channel-concurrency.md`.

## Invariant (owner requirement)

In one Telegram dialog at most **one** interactive execution runs at a time, even
when the executions belong to different sessions. Within one profile, project or
folder, different sessions may run in parallel (2, 3, 5+ as resources allow).
In Web, different sessions have separate workspaces and run in parallel.

**Explicit-choice exception (owner decision 2026-09-30, RC-03).** The lane is a
default, not a hidden ban: when the user is offered the launch menu during a
running task and explicitly picks **«⚡ Параллельно»**, the gateway sends
`parallel: true` on `/run` and that run skips the lane check. The flag may come
only from a user's menu choice on the gateway — never from the model, a retry or
any automatic path. The session writer guard is never bypassed, so «параллельно»
into the SAME session still queues (CH-05); the menu launches it as a separate
session. Everything without the flag behaves exactly as before: default = one
interactive run per dialog.

**Why:** Telegram is one message stream — two concurrent runs make it unclear which
task an input, answer, «Стоп» or «Дополнить» belongs to. A Web tab shows one
session's input/output/controls, so profile-wide serialization is not needed there.

## Two independent admission checks

```text
Telegram execution → Telegram conversation lane free
                   AND target session writer slot free
Telegram execution with user's `parallel` flag
                   → target session writer slot free   (lane check skipped for THIS run)
Web execution      → target session writer slot free
All executions     → ordinary admission by real resources
```

- Lane key = canonical `ConversationRef` key `(channel, endpointId, conversationId, threadId?)`.
  Forum topics are separate lanes; group members do not get separate lanes;
  profile/actor/project are never part of the lane key.
- Session writer key = `(profileId, sessionId)`; two tabs / TG+Web on the same
  session serialize writes, other sessions are unaffected.
- The policy is host-derived from the verified channel (`interactionPolicyFor`),
  never supplied by the client or model. Unknown channel fails closed.
- Headless cron/system runs get no lane and no fake chat/session; a durable
  continuation of a Telegram task inherits its dialog's lane.

## What this does NOT forbid

- Parallel sessions of one profile, project or workDir (shared folder is not a mutex;
  file conflicts are resolved per resource, coding workspaces are isolated per task).
- Keeping many historical sessions in one Telegram chat.
- Web continuing a session created in Telegram (with the visibility UX from #1365 §5).
- A visible resource-capacity queue (temporary wait, not a "one task" rule).

## Forbidden regressions

`profileId`/`projectId`/`workDir` as a global single-run lock; releasing the Telegram
lane once a sessionId is known; bypassing the lane via a new session, project/engine
switch, retry, restart/resume, GTD, or another group member — or by any automatic
decision. The only sanctioned exception is the user's explicit parallel choice
(`parallel: true` from the gateway's launch menu, RC-03).

Supersedes older notes stating "the only concurrency boundary is the session".

## Migration guard

`test/ratchet-telegram-senders.test.cjs` pins legacy direct Telegram senders and
`AGENT_CHAT_ID`/`AGENT_BOT_TOKEN` env fallbacks; each legacy site names the slice
that removes it. New sites fail CI — route output via the execution `replyToRef`.
