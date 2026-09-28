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

Факты, проверенные живьём 2026-09-28 — не переисследовывать: ключ `oc_sk_…` из `OPENCODE_GO_API_KEY` валиден под именем `OPENCODE_API_KEY`; `opencode run -m opencode-go/mimo-v2.6-flash` отвечает на продовом opencode 1.18.31, хотя модели нет в клиентском реестре того билда; сервер требует заголовок `x-opencode-session`. Пока лестницы нет, пин в `DIRECT_MODEL.research` работает без фолбэка: закончившаяся месячная allowance = упавший research.
Goal: profile maintenance lock + POST /internal/flush-profile — safety precondition for running the migration LIVE (#1784 G1+G2)

- [x] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1812
- [x] Merged to main
- [x] Deployed to prod — verified live: обе VM отвечают commit 38045b4 (gcp-main `/health`, ru-edge `/health`); `POST /internal/flush-profile` на GCP → 401 без Bearer, 400 на неверный username, `{ok:true,flushed:0,failed:0}` на валидный (body и `?username=`); live-smoke `src/profile-lock.js` → acquire `smoke-probe` → `isProfileLocked=true` → `waitForProfileUnlocked` ждёт → release → wait 154ms → unlocked; гейт в runner деплоя на месте (`isProfileLocked` в `_runTaskInner`)
