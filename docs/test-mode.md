# Gateway test mode (`delivery:"log"`) — what the agent must do

Scope: the gateway's test mode (US-TEST-01, trained-assist-tg-bot#329). A test
profile's message runs the whole routing path, but nothing may reach Telegram —
the answer goes to the gateway journal instead. Real users are unaffected: the
mode is keyed by a chat id in the gateway's `TEST_CHAT_IDS`.

## Contract on this side (trained-assist-agent)

1. `/run` with `delivery:"log"` → **no Telegram calls from the run**. The gate
   lives in `src/runner/tg-stream.js` (`tgSend`/`tgEdit` + lifecycle pushes), the
   single funnel for run output. Suppressed sends log
   `[test-mode] agent-suppress kind=…` locally.
2. The final answer comes back to the gateway as the `answer` field of the
   existing `POST /internal/run-finished` (not a separate endpoint).
3. **The log-mark must be released when the run finishes.** `markLogChat(chatId)`
   on run start, `unmarkLogChat(chatId)` in `_finishAcceptedChatRun` on *every*
   outcome (done/error/stop/quick answer). The mark is a refcount (`Map`), so
   overlapping runs of one chat release one at a time.

## Why rule 3 is non-negotiable (regression R2)

The original implementation never called `unmarkLogChat`: one test run silenced
that chat **until the agent process restarted**. Removing the chat from
`TEST_CHAT_IDS` did not bring it back (the gateway stopped sending
`delivery:"log"`, the agent kept suppressing) — silent, permanent delivery loss
for a real user, no recovery path short of a restart. Found by live verification
of tg-bot#329 on 2026-10-02, fixed in PR #2027.

## Tests that must keep passing

- `tests/unit/test-mode-delivery.test.js` — refcount, release-then-delivers,
  no-op unmark.
- `tests/runner-e2e.test.js` → `describe('Gateway test mode (delivery:"log")')` —
  log run, then an ordinary run in the same chat reaches Telegram. This e2e
  **fails without the release logic**; if it is ever skipped or weakened, the
  regression above is free to return.
