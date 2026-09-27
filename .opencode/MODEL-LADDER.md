# Model ladder — decision log

Issue #1061. A profile in `.opencode/profiles/*.json` declares, per agent role, a `ladder`: a list
of models in preference order, tried top-down. `src/opencode-ladder.js` resolves the first
non-skipped rung before every OpenCode invocation.

Ladders and policy are **config-driven** (issue #1467). A profile carries
`"ladderRef": "<name>"` pointing at `config/model-routing.json`'s `ladders`, so the model lists
live in ONE file instead of being copied into every profile — updating a ladder no longer means
editing several profiles that just happen to share it. A profile with an inline `ladder` or a flat
`model` (legacy shape) still works unchanged.

Health is stored **per model, not per profile** (issue #1467, owner 2026-09-26: "клиент единый
сервис, единый для всех профилей") in `src/model-health.js` →
`~/.config/opencode/model-health.json`. The same physical model appears in the ladders of several
profiles (`deepseek`, `max`, `value`); before this its flakiness was learned separately in each,
so a rung burned in one place was still tried fresh elsewhere. Now one shared record is used by
every profile/role, and a skipped model comes back when the next call to it succeeds
(`recordSuccess`).

This file is the human-readable log of *why* the rungs are ordered the way they are — update it
alongside `config/model-routing.json` whenever the order changes, don't let it drift into a
description of some past state.

## Error classes (`src/opencode-ladder.js: CLASSIFIERS`)

- **quota** (auto-clears after a TTL, safe to retry automatically): rate-limit / HTTP 429 (1h
  TTL), "usage limit" / "quota exceeded" (24h TTL — daily caps reset once a day, not hourly),
  "temporarily overloaded" / HTTP 503 (5min TTL — upstream provider capacity, not our quota, and
  the point of skipping to the next rung is to dodge it, not wait it out). A retired/never-existed
  model slug ("unavailable for free", "model not found", "no endpoints found") is ALSO classified
  as quota with a 30-day TTL, even though it will never actually recover — see the comment in
  `CLASSIFIERS` for why: unlike a true account-wide config problem, a dead single rung shouldn't
  stop the whole task, it should just be skipped, and 'quota' is the class that skips instead of
  dead-stopping.
- **config** (never auto-clears, alerts an operator instead of burning the rest of the ladder):
  "subscription required", "requires Global regions" (OpenCode Go region not enabled on the
  account — a one-time setting, not a quota), "insufficient account funds" (Zen pay-as-you-go
  balance empty — needs a human to top up, doesn't reset itself).
- **transient** (short shared per-model backoff, then retry the SAME model): an intermittent
  per-rung fault where the model usually works — currently `"Bad Request: {model:...}"` (observed
  live 2026-09-25 on `opencode-go/deepseek-v4.1-flash`, which intermittently rejects a request while
  its siblings serve fine). Unlike quota/config, this is NOT persisted hours/days: `recordFailure`
  gives the model a short skip window (issue #1467) and the runner retries the SAME model once that
  window elapses, up to `MAX_INCOMPLETE_RETRIES` (3) times, and only escalates to the sibling rung
  after those fail — see the owner requirement (2026-09-26) "частенько багует, нужны ретраи
  грамотные, альтернатива — если три ретрая не сработали". The macro-alternation
  (`forceOpencodeAlternation`) takes an `escalate` flag so early same-model retries leave the rung
  untouched and only the last retry advances it.

### Transient backoff (`src/model-health.js`, issue #1467)

Policy is data in `config/model-routing.json` (`backoff`), with identical built-in defaults so a
missing/unreadable config never breaks model selection:

- `baseMs: 15000`, `multiplier: 2`, `capMs: 300000` → **15s → 30s → 60s → 120s → 240s → 300s
  (cap)**. The owner's framing: "ошибка разовая обычно" — the first rollback must be SHORT, not
  fifteen minutes.
- `failureWindowMs: 900000` — a failure streak older than the window no longer counts, so a model
  that had a bad hour yesterday is not permanently "sick".
- `config`-class never auto-clears (`skipUntil: null`) and keeps alerting an operator — one model
  needing manual account setup is now blocked for every profile (that is the intent of a single
  client, but it must be loud).
- `forceAdvance` (the blind crash-retry in `runner/index.js`, unrelated to error classification)
  writes a short 15-min `force` skip so a task's own retry schedule doesn't hammer the same rung.
  This one IS shared per model — a known trade-off, listed in the design doc.

Codex auth-error patterns are still unconfirmed empirically (issue #1061 spike 0.1, open) — the
config/quota classifiers above are OpenCode-engine-specific (they classify errors from `opencode
run`, not from Claude/Codex, which go through the separate cross-engine fallback in
`src/auth-flag.js` / `runner/index.js`'s `isAuthError` branch).

## `max` — default profile

Top rung is OpenCode Go's GPT-6/5.6 Luna family (subscription-based, no per-token cost beyond
the Go plan) — the former `lavish-luna` profile's models, now the top of `max`'s ladder instead
of a separate profile a user had to opt into by name. Degrades through the GPT-6/5.6 Luna family
(6-Luna → 5.6-Luna) and GLM-5.3 before falling to `opencode-go/deepseek-v4.1-flash`, then finally
to the metered `openrouter/deepseek/deepseek-v4-flash-0731` as a paid last resort so a task never
just stops because every Go rung rate-limited.

> Historical slugs `gpt-6-astra` / `gpt-5.6-sol` / `gpt-5.6-terra` were retired by the
> opencode-go gateway and returned a generic `UnknownError`; removed 2026-09-24 (issue #1265).

## `value` — economical, not free

DeepSeek V4 Flash (OpenRouter, paid) first — cheap and reliably available. GLM-5.3-flash and
Qwen3.8-flash as fallbacks (former `quality`/`mimo` rungs). `plan` leads with GigaChat-Ultra —
carried over from the pre-#1061 config, kept because planning benefited from it in practice.

`review` was reordered 2026-09-26: `openrouter/deepseek/deepseek-v4-flash-0731` now leads instead
of `nemotron-3-ultra-550b:free`. The free rung had ~70% request availability (owner report:
"бесплатные LLM в 70% случаев ошибка request"), which made reviews flaky; deepseek-v4-flash at
$0.021/M input / $0.32/M output is the cheapest reliable large-context model (1.3M ctx) on
OpenRouter — Google's cheapest text model (gemma-3-4b, $0.05/M input) is 2.4x MORE expensive on
input, so nothing from Google competes for the input-dominated review workload. The free
nemotron stays as a fallback rung; `free.review` was left untouched (its contract is zero-cost,
and deepseek already sits there as the paid last resort).

## `free` — zero cost, background/fallback use

Mostly `:free`-tier OpenRouter models, cycled per role so retries don't all hammer the same one.
Each role's ladder ends on one metered rung, `openrouter/deepseek/deepseek-v4-flash-0731` — the
same cheap paid model `value`/`max` already trust as their fallback. Added 2026-09-23 after a
retry storm where every `:free` rung was simultaneously rate-limited/dead left the task with
nowhere to degrade to; a caller on `/oc_free` still wants cost near zero, not a hard failure, so
one guaranteed-to-work paid rung as the very last resort beats failing loudly.

2026-09-23: dropped `xiaomi/mimo-v2.5:free` from every role — confirmed live against OpenRouter
that this slug 404s unconditionally ("This model is unavailable for free"), and it sat FIRST in
`build`/`general`, so every fresh `/oc_free` task's first attempt was a guaranteed failure before
the ladder had a chance to degrade. It was retired rather than kept as a rung, because the old
error-classifier had no pattern for "unavailable for free" at all (`classifyError` returned
`null`), so the ladder never even recognized it as exhausted — it silently fell through to the
generic incomplete-retry path and could burn the whole retry budget hammering a dead model. Also
observed `nemotron-3-ultra-550b-a55b:free` returning "Service temporarily overloaded" (HTTP 503)
on 3/3 consecutive live calls — reordered it to the LAST rung in every role (instead of first)
since it's the one most likely to be busy on the free tier, and added a short-TTL 'quota' rule so
a genuine overload now correctly advances the ladder instead of being an unclassified crash.

## `russian` (formerly `russian-recruiter`) — Russian-language tasks, not recruiting-only

GigaChat Pro for `build`/`explore`/`general`, Ultra for `plan`, Max for `review` (its
`rolePrompts.review` carries a strict-reviewer prompt focused on factual accuracy and
Russian-language quality — ladder degradation doesn't touch `rolePrompts`, only which model fills
the role). Renamed from `russian-recruiter` because the ladder mechanism is generic and this
profile is useful for any Russian-language task, not just recruiting.

## `deepseek` — default profile: one ladder, Go first (2026-09-27)

Every chat without an explicit choice runs on `deepseek` (`src/profiles.js`). It is ONE per-role
ladder (`.opencode/profiles/deepseek.json` → `ladderRef: deepseek` in `config/model-routing.json`):

`opencode-go/mimo-v2.6-flash` → `opencode-go/deepseek-v4.1-flash` ($0.15/$0.60)
→ `opencode-go/muse-spark-1.3-contributor` ($0.10/$0.20)
→ **`openrouter/deepseek/deepseek-v4-flash-0731`** (paid, last). Same ladder for every role.

Order set by the owner 2026-09-27: «MiMo-V2.6-Flash → DeepSeek V4.1 Flash → Muse Spark 1.3
Contributor → далее openrouter» (supersedes #1589's cheapest-first order; `gpt-6-luna` dropped,
`deepseek-v4-pro` stays out).

How it degrades and comes back — no manual switch anywhere:

- **A flaky Go rung** ("Bad Request", 5xx) — retried on the model's own backoff (15s → 30s → 60s …),
  then the next Go rung. Each model keeps its own backoff counter.
- **A Go key hits its limit / is rejected** — `src/opencode-go-keys.js` rotates `auth.json` to the
  other key (two keys: `OPENCODE_GO_API_KEYS`) and the task retries on Go.
- **Both keys parked** — the runner skips every `opencode-go/*` rung of the ladder until the
  earliest key heals (≤15 min for a quota hit, 1 h for a rejected key), so the ladder serves its
  OpenRouter last rung. When the skip lapses the Go rungs are picked again automatically.

History: until 2026-09-27 `deepseek` was a "logical" profile resolved through a VM-wide
go/openrouter toggle (`deepseek-go.json` / `deepseek-openrouter.json`, `/oc_go`, `/oc_openrouter`,
`~/.config/opencode/go-mode.json`). A manual `/oc_openrouter` never expired — it was left on (and
re-set by `npm test` runs on the VM, whose test hit the live toggle file) and drained the OpenRouter
balance. The toggle, both halves and the pin commands were removed.

| Command | Effect |
|---------|--------|
| `/oc_deepseek`, `/oc_ds`, `/oc_go`, `/oc_ds_go` | Select `deepseek` for *your* profile |
| `/oc_openrouter`, `/oc_ds_or` | No switch any more — replies that OpenRouter is only the automatic last rung |

## Retired profiles

`quality`, `mimo`, `lavish-luna` are gone as standalone profiles — their models are now rungs
inside `max`/`value`'s ladders (see above). `russian-recruiter` was renamed to `russian`, same
ladder. `/oc_quality`, `/oc_mimo`, `/oc_lavish-luna`, `/oc_ll` no longer switch anything — they
return a message pointing at `max`/`value`/`free`/`russian` instead
(`src/runner/intent-engine.js: OC_PROFILE_INTENT`). `infra/opencode-switch-profile.sh` does the
same for the shell-level equivalents (`m`/`q`/`ll` aliases).

## Фаза 4 — mid-session model changes (issue #1061)

The epic's item 11 asked to confirm, not assume, that OpenCode's `-s <session-id>` resume is
unaffected by a ladder degradation between two turns of the same conversation. Checked by
reading the invocation path (`buildEngineCommand` / `runEngineProcess` in
`src/runner/claude-runner.js`): this codebase never passes `-s`/`--session` to `opencode run` for
any engine (Claude, Codex, or OpenCode) — every turn is a fresh, stateless CLI invocation, and
continuity across turns comes entirely from re-injecting the prior conversation into the prompt
text (`sessions.buildContext` folded into `baseContext`/`sessionContext` in
`src/runner/index.js`). There is no OpenCode-native session to desync, so the concern in item 11
doesn't apply to how this system actually works — no further spike needed there.

What *was* a real gap: the ladder resolver (`opencodeLadder.buildOcProfileOverrides`) re-resolves
the role model fresh on every turn, so if a rung became exhausted between two messages of the
same Telegram conversation (a different task burned it in the meantime), the model would silently
change with no trace — unlike the intra-task retry loop below, which already sends a "пробую
следующую ступень" message. Fixed: `session-store.js` records the resolved model per session/role
(`getLastOcModel`/`setLastOcModel`), and `runner/index.js` compares it against the newly resolved
model each turn. The swap is now logged internally only (`[runner] oc model changed mid-session…`):
the explicit "ℹ️ Модель сменилась: X → Y" Telegram message it originally sent was debug noise and
was removed on owner request (2026-09-27) — it is no longer sent to the chat nor appended to the
session transcript.

## Updating this file

Whenever a rung's order changes in `config/model-routing.json` (the ladders) — or, for a
still-inline legacy profile, in `.opencode/profiles/*.json` — add or edit the relevant section
above with the reason — a benchmark result, a recurring rate-limit, a new model becoming
available. Don't just bump the JSON silently; the whole point of this file is that the next
person (or agent) picking up issue #1061's follow-ups doesn't have to reverse-engineer *why* rung
3 is where it is.
