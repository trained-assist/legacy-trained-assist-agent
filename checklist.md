Goal: «Стоп» реально останавливает задачу — kill дерева процессов под run-as изоляцией + trace-тумбстоун + гейт на каждой точке спавна

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1800
- [ ] Merged to main
- [ ] Deployed to prod — verified live

Goal: register trained-assist-search-skill as the search-skills sibling — вынос веб-поиска из ядра, шаг 1: репо с search_serp_free создано, 6 точек регистрации, копия в core пока остаётся (#1792, #1470)

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1803
- [ ] Merged to main
- [ ] Deployed to prod — verified live (search-skills в .mcp.json, ensure_sibling в журнале деплоя)

Goal: Speech skill extraction — sibling trained-assist-speech-skill + delegate recognition from core (#1779)

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1782
- [ ] Merged to main
- [ ] Deployed to prod — verified live

Goal: align remaining workspace writers with atomicJson/atomicText — one atomic path for every USERS_ROOT write (#1735 step 6)

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1793
- [ ] Merged to main
- [ ] Deployed to prod — verified live

Goal: profile migration M0+M1 — clean list + read-only inventory classifier + aggregate report (#1784)

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1794
- [ ] Merged to main
- [ ] Deployed to prod — verified live

Goal: research-поиск в интернете — 4 способа параллельно с запасными (эпик #1792), L0 = Гермес на opencode с веб-поиском

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1795
- [ ] Merged to main
- [ ] Deployed to prod — verified live (живой hermes_research с веб-вопросом: websearch в opencode DB, настоящие URL в ответе, grounded=true → коммент в #1618)
- [ ] L1/L2/L3 прижились и сравнены по 5 контрольным запросам → таблица в https://github.com/trained-assist/trained-assist-agent/issues/1792
- [ ] PR fallback-цепочки (единый web_search с бэкендами) создан и смержен

# #1789 P0 tracker

- [ ] C1 — unify token access through `src/data-paths.js`
- [ ] C2 — restrict engine environment to the reviewed allowlist
- [ ] C3 — remove user-to-service secret fallbacks and service-key leaks


Goal: token access and engine env allowlist (P0 C1-C3) — единый резолвер токен-корня, ENGINE_TOKEN_FILES, тесты на оба env-имени

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1801
- [ ] Merged to main
- [ ] Deployed to prod — verified live

Goal: отвязка pending-журнала и resume от абсолютных путей, context store по профилю, systemd drop-in в репо (#1789 P1)

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1814
- [ ] Merged to main
- [ ] Deployed to prod — verified live
