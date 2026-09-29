> **2026-09-27:** the free/cheap ladder now lives in the [trained-assist-llm-ladder](https://github.com/trained-assist/trained-assist-llm-ladder) worker (`https://llm-ladder.trainedassist.store`, model `free-ladder`). pr-autofix ≥ v1.6.0 and trained-assist-agent call it with `LLM_LADDER_TOKEN`; the provider keys below live in the worker's secrets. The rest of this page is history.

# Free/cheap LLM credentials — how to call them

Context: issue #584 (multi-step PR auto-triage pipeline — analyze failed CI,
draft a fix, verify, clarify issues, draft PRs for simple bugs). Every sub-agent
step in that pipeline should default to a cheap/free model via OpenRouter
instead of Claude, and fall back to Claude only when the cheap model fails or
the task needs deeper reasoning.

## Credential

- Env var: `OPENROUTER_API_KEY` — already declared in `src/secrets.js` (`OPTIONAL`
  list) and loaded the same way as every other integration key. No new secret
  plumbing needed; if a profile hasn't set it, `getOpenRouterKey()`-style
  lookups return `null` and callers should skip/fallback (see
  `src/hh-scoring.js:271`).
- Set per-profile like any other secret: `/settoken` flow or the credentials
  form (`src/mcp-skills/tools/23-credentials-form.js`), or directly in the
  profile's secrets store.

## Call pattern (already used in this repo)

OpenRouter is called as a plain OpenAI-compatible chat-completions endpoint:
`https://openrouter.ai/api/v1/chat/completions`, header
`Authorization: Bearer ${OPENROUTER_API_KEY}`.

Existing call sites to copy from:
- `src/hh-scoring.js` — model selection + fallback pattern
  (`FALLBACK_MODEL = 'google/gemini-2.5-flash'`)
- `trained-assist-hh-skill` `src/mcp-skills/tools/96-applylink.js` (was core `41-applylink.js`) — PDF/resume extraction via
  OpenRouter (`gemini-2.5-flash` native file parsing + `gpt-4o-mini` text
  fallback, run concurrently, pick the more complete result)
- `src/hh-bullshit-guard.js`, `src/session-summary.js`, `src/project-summary.js`,
  `src/mcp-skills/tools/96-label.js` — cheap-model classification/summary calls

## Recommended models for pipeline steps

| Step | Task | Model | Why |
|---|---|---|---|
| 1 | Analyze failed PR/CI logs | `deepseek/deepseek-chat` (a.k.a. "DeepSeek V3") | strong at reading logs/diffs, cheap |
| 2 | Draft a fix from the analysis | `deepseek/deepseek-chat` or escalate to Claude if the diff touches >1 file / architecture | code-editing capable, cheap |
| 3 | Clarify an issue (gather info from past sessions) | `google/gemini-2.5-flash` | fast, cheap, good at summarizing/collating |
| 4 | Prepare a PR for simple bugs | same as step 2 | |
| 5 | Verify a fix (adversarial check) | run 3x with `google/gemini-2.5-flash-lite` (cheapest) as independent voters, majority wins | matches the "3 attempts" pattern already used elsewhere (see `verify` skill / adversarial-verify pattern in Workflow tool) |

`google/gemini-2.0-flash-001` is retired (404) — do not use it; `2.5-flash` /
`2.5-flash-lite` are the live replacements (confirmed working on CID/Cyrillic
PDF OCR).

## Free-tier ladder for PR-review/auto-fix (bench-validated 2026-09-26)

Bench: 500 rows, 10 diffs × 5 runs × 10 `:free` models (see
`bench-cicd/bench-ext-summary.json`). Old chain (`deepseek-v3-0324`,
`gemma-3-12b-it`, `llama-3.1-8b-instruct`, `mistral-7b-instruct`) and
`deepseek/deepseek-v4-flash-0731:free` are gone from the live OpenRouter
catalog. Survivors, ordered by availability × recall:

1. `nvidia/nemotron-3-super-120b-a12b:free` — 84% avail, recall 0.79, 4.6s
2. `inclusionai/ling-3.0-flash-fin:free` — 72% avail, recall 0.92, 0 FP, 2.5s
3. `inclusionai/ling-3.0-flash-sante:free` — 58% avail, recall 0.72
4. `nvidia/nemotron-3-ultra-550b-a55b:free` — 52% avail, recall 1.0, 0 FP
5. `cohere/north-mini-code:free` — 50% avail, recall 0.88, 0 FP
6. `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` — 46% avail, recall 0.74
7. `poolside/laguna-xs-2.1:free` — 46% avail, recall 1.0 (rate-limited)
8. `dots-studio/dots-3-note-preview:free` — 18% avail, recall 1.0

Dead: `nemotron-3.5-lightning:free`, `nemotron-3.5-content-safety:free`.
Coded into `pr-autofix` as `FREE_MODEL_LADDER` with per-stage failover (a
single 429/404 no longer kills the pipeline) and a tolerant JSON guard
(`response_format` dropped on 400, `parseJSON` extracts `{…}` from fences).

## Budget/fallback rule

Every pipeline step must:
1. Try the assigned OpenRouter model first.
2. On empty/malformed response or 2 consecutive failures, fall back to Claude
   for that single step (not the whole pipeline) — same "3 attempts then
   escalate to human" cap requested in issue #584.
3. Never silently swallow a step failure — log which model handled the step
   in the PR/issue comment the pipeline posts, so cost and reliability are
   auditable per step.
