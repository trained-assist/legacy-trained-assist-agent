Goal: «Стоп» реально останавливает задачу — kill дерева процессов под run-as изоляцией + trace-тумбстоун + гейт на каждой точке спавна

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1800
- [ ] Merged to main
- [ ] Deployed to prod — verified live

Goal: register trained-assist-search-skill as the search-skills sibling — вынос веб-поиска из ядра, шаг 1: репо с search_serp_free создано, 6 точек регистрации, копия в core пока остаётся (#1792, #1470)

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1803
- [ ] Merged to main
- [ ] Deployed to prod — verified live (search-skills в .mcp.json, ensure_sibling в журнале деплоя)

Goal: mainstream-tester: причина фоллбэка decider'а видна в логе + ретрай таймаута + driver_error в отдельный лог, cron из релиза

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1816
- [ ] Merged to main
- [ ] Deployed to prod — verified live

Goal: encrypted credential store — AES-256-GCM at rest для agent-tokens (epic #1789 P0 C4): единый модуль credential-store, все чтения/записи через него, .meta + .index.json, scripts/encrypt-tokens.mjs, CRED_ENCRYPTION_KEY в env-manifest/CI

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1819
- [ ] Merged to main
- [ ] Deployed to prod — verified live
