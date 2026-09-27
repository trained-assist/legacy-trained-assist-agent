Goal: #1450 durable executor — strict positional ordering + claimNextRunnable honors now

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1452


Goal: Retry deepseek "Bad Request" 3x on the same model, then a sibling mimo model on the same gateway (PR #1446)

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1446
- [ ] Merged to main
- [ ] Deployed to prod — verified live


Goal: Migration control plane — per-domain-skill status matrix + core/domain toggle (#1511), PR #1513

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1513
- [ ] Merged to main
- [ ] Deployed to prod — verified live


Goal: Auto dev-worktree per agent spawn — main checkout stays clean (#1535)

- [ ] https://github.com/trained-assist/trained-assist-agent/issues/1535 — implemented + merged
- [ ] Verified: spawning in a git repo yields an isolated worktree, main tree stays clean


Goal: «▶️ Запустить агента» dead in group chats — run-finished push dropped for negative chatId (agent #1538 + bot #281)

- [x] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1538 — merged, deployed (0932afd)
- [x] CI green on https://github.com/trained-assist/trained-assist-tg-bot/pull/281 — merged, deployed (eed3c82)
- [x] All stuck chats released (busy cleared); new runs release normally
- [x] Follow-up merged + deployed: bot #282 (per-minute busy poll) — https://github.com/trained-assist/trained-assist-tg-bot/pull/282


Goal: restart no longer strands a chat — release gateway hold on shutdown + for every non-resumed task (agent #1548)

- [x] CI green + merged + deployed — https://github.com/trained-assist/trained-assist-agent/pull/1548 (f984564)
- [x] Verified live: restarted prod with 4 active runs → all resumed as live runs, holds correct, journal intact
- [x] Invariant confirmed: every busy chat has a matching live run (no orphans)


Goal: intake — ▶️ tap during pending media acknowledged + bounded wait (bot #284)

- [x] CI green + merged + deployed — https://github.com/trained-assist/trained-assist-tg-bot/pull/284 (3816ea8)
- [x] Tap now answers «📥 Задачу забрал…» and auto-launches on resolve; stuck media dropped after 15 min


