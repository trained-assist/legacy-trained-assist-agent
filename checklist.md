Goal: «Стоп» реально останавливает задачу — kill дерева процессов под run-as изоляцией + trace-тумбстоун + гейт на каждой точке спавна

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1800
- [ ] Merged to main
- [ ] Deployed to prod — verified live

Goal: register trained-assist-search-skill as the search-skills sibling — вынос веб-поиска из ядра, шаг 1: репо с search_serp_free создано, 6 точек регистрации, копия в core пока остаётся (#1792, #1470)

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1803
- [ ] Merged to main
- [ ] Deployed to prod — verified live (search-skills в .mcp.json, ensure_sibling в журнале деплоя)

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
