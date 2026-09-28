Goal: encrypted credential store — AES-256-GCM at rest для agent-tokens (epic #1789 P0 C4): единый модуль credential-store, все чтения/записи через него, .meta + .index.json, scripts/encrypt-tokens.mjs, CRED_ENCRYPTION_KEY в env-manifest/CI

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1819
- [ ] Merged to main
- [ ] Deployed to prod — verified live

Goal: «Стоп» реально останавливает задачу — kill дерева процессов под run-as изоляцией + trace-тумбстоун + гейт на каждой точке спавна

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1800
- [ ] Merged to main
- [ ] Deployed to prod — verified live

Goal: register trained-assist-search-skill as the search-skills sibling — вынос веб-поиска из ядра, шаг 1: репо с search_serp_free создано, 6 точек регистрации, копия в core пока остаётся (#1792, #1470)

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1803
- [ ] Merged to main
- [ ] Deployed to prod — verified live (search-skills в .mcp.json, ensure_sibling в журнале деплоя)

Goal: mainstream-tester: причина фоллбэка decider'а видна в логе + ретрай таймаута + driver_error в отдельный лог, cron из релиза

- [x] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1816
- [x] Merged to main
- [x] Deployed to prod — verified live (релиз 63a9a7c на GCP; ручной запуск cron-скрипта 22:23–22:31 UTC: code dir=agent-master, 12/12 шагов разные, 0 fallback'ов, 0 driver errors; 27 исторических driver-записей перенесены в driver-errors.jsonl, бэкап bugs.jsonl.bak-1790634845104)

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

Goal: research-профиль на OpenCode Go — `opencode-go/mimo-v2.6-flash` вместо gemini через openrouter, ноль стоимости на вызов сверх подписки (#1792)

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1821
- [ ] Merged to main
- [ ] Deployed to prod — verified live (живой hermes_research отвечает с Go-моделью в логе рана и grounded=true)

Goal: поисковая лестница `search` в llm-ladder worker — opencode-go/mimo-v2.6-flash → openrouter/google/gemini-2.5-flash как фолбэк. ПОСЛЕДНИЙ пункт очереди (#1792)

- [ ] В trained-assist-llm-ladder (config/ladders.json) добавлена лестница `search`: rung 1 `opencode-go/mimo-v2.6-flash`, rung 2 `openrouter/google/gemini-2.5-flash`
- [ ] src/opencode-ladder-provider.js: `research` переезжает из DIRECT_MODEL в PROFILE_LADDER → `search`
- [ ] CI green → Merged to main
- [ ] Deployed to prod — verified live (исчерпанная Go-allowance деградирует на gemini, а не роняет hermes_research)

Факты, проверенные живьём 2026-09-28 — не переисследовывать: в `OPENCODE_GO_API_KEYS` лежат **два** разных ключа `oc_sk_…` через запятую, оба работают по отдельности и склеенными — провайдер `opencode-go` читает `OPENCODE_API_KEY` и запятую принимает, так что ротация доходит до движка целиком; `opencode run -m opencode-go/mimo-v2.6-flash` отвечает на продовом opencode 1.18.31, хотя модели нет в клиентском реестре того билда; сервер требует заголовок `x-opencode-session`. Открытого пока нет только ранга НИЖЕ Go: когда кончатся оба ключа — упавший research вместо деградации. Этот ранг и есть `openrouter/google/gemini-2.5-flash` в лестнице `search` ниже (в llm-ladder worker); ключ OpenRouter на боксе пока один, без ротации.
