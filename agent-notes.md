
## Followup Controller — GTD «довести до конца» (2026-09-12, PR #502)
- src/followup-controller.js: intent-gate (дешёвая gemini-2.5-flash + regex pre-gate CONTROL_HINT) на завершённой задаче → durable followups/<sessionId>.json {dueAt,iterations,maxIterations,status}. Хук в runner.js _runTask success-path (после appendReply), skip при internalFollowup. Tick в server.js scheduleFollowupController каждые 5 мин.
- Гарды: re-entrancy=isTaskRunning(username) (не плодить дубль-claude на общем agent-data — старая ловушка); hard-cap maxIterations=3; persist ДО запуска (durable); reopen-промпт issue-first. Терминал: /FOLLOWUP:\s*done/i в ответе ИЛИ iterations>=max. Backoff: dueAt+=eta между проверками.
- Дефолты: etaMinutes=60 (LLM оценивает, clamp 20..180), maxIter=3, MAX_FIRES_PER_TICK=3.
- Осталось live: мерж #502 + рестарт assist-agent.service (рестарт убьёт текущую сессию — общий cgroup, только с подтверждения).

## Staging repo создан (2026-09-13)
- trained-assist-agent-staging СОЗДАН и запушен: github.com/trained-assist/trained-assist-agent-staging (private). Локально /home/vova/trained-assist-agent-staging.
- Отдельный репо (спека §7.0). Код агента тянется submodule по SHA (F1). CLAUDE_BIN-индирекция подтверждена runner.js:2167 → mock Claude без правок агента.
- Готово: 11 сценариев-фикстур S1–S11 (данные), mock-claude.mjs, mock-mcp.mjs (резолвер видимости public/grouped/private — S10/S11 зелёные, проверено node). S8a(R7)/S8b(R6)/S2/S3(R3) — красные мишени.
- «Супер-решение очереди» (спека §7.8): единый profileLanes(laneFor(profileId)) сворачивает chatId-лейн(runner.js:1382)+web-«0»(web-routes.js:255)+процесс-глобальный cap(runner.js:1198). Фаза 5, ПОСЛЕ красных S8.
- Осталось: Ф1 Harness A (шлюз Miniflare), Ф2 submodule+изолир.agent-data→красные S8 против реального runner, Ф3 env-индирекция MCP, Ф5 рефактор.
- NB: vitest npm install флапает в песочнице из-за родительского workspace — в CI (чистый checkout) ок. Логику гонял напрямую node.

## Гранулярность лейна сериализации — РЕШЕНО: по СЕССИИ (2026-09-13, отменяет §7.8 profile-lane)
- Владелец (голосом, Intensity 3, повторил 3×): «в 1 workDir могут работать несколько сессий с разных чатов или с веба — нормально работает». → лейн НЕ по workDir и НЕ по профилю.
- Единственная легитимная работа лейна: не дать двум claude писать ОДИН транскрипт → граница = СЕССИЯ. runner._laneKey(sessionId,chatId)=`session:<id>`, для новой сессии (нет id) fallback `chat:<id>` (свернуть два первых сообщения одного чата в одну сессию).
- Откатил #546-behaviour (queueKey=resolveLaneKey=workDir): он сериализовал сёстры-сессии в одном проекте. Удалил src/lane-key.js + test/lane-key.test.cjs + docs/CONCURRENCY-LANE-GRANULARITY.md. Новый тест test/lane-granularity.test.cjs (7 зелёных) в test:cjs.
- Что ОСТАЁТСЯ верным: per-profile cap (capKey=username, _perKeyRunning, лимит 4) + глобальный семафор (6). Кросс-сессионный параллелизм ограничен ТОЛЬКО этими cap'ами, не лейном.
- Почему безопасно без workDir-сериализации: единственный реально общий на профиль ресурс = context store (keyed username) — пишется АТОМАРНО temp+rename (03-context-store.js). Транскрипты у сессий разные. Порчи нет.
- ⚠️ Для staging-спеки: §7.8 «profileLanes(laneFor(profileId))» ПРОТИВОРЕЧИТ этому решению. Супер-решение может объединять web-«0»+chatId, но ключ обязан оставаться пер-СЕССИОННЫМ, иначе убьёт нужный параллелизм. R6 (web+chat в одном проекте «дерутся») признан НЕ-багом владельцем.

## Codex CLI — device-code login is the right "personal account" flow (2026-09-15)
- `codex login --device-auth` prints a URL (https://auth.openai.com/codex/device) + one-time code (~15 min TTL), no localhost callback needed — works fine on a headless remote VM, unlike browser-callback `codex login`. This is the exact analog of how Claude Code auth was done here: terminal command → link → user authorizes in their own browser → CLI process on the server picks it up automatically. No manual key copy-paste.
- `codex login status` reporting "Logged in using an API key sk-proj-***" was misleading — codex reads OPENAI_API_KEY from env live, doesn't require a stored auth.json for that path. Once device-auth completes it writes ~/.codex/auth.json which takes priority over the env key — that's the actual "switch profile" mechanism the user wants (device-auth = personal ChatGPT account, `printenv OPENAI_API_KEY | codex login --with-api-key` = shared key, switch anytime).
- NB: this VM's own agent-framework state (goals/queue/thread_history sqlite, sessions/, skills/) ALSO lives under ~/.codex — same dir as the real OpenAI Codex CLI's config. Coincidence of naming, not a conflict (different files), but worth knowing before assuming ~/.codex is "codex CLI's own dir" for cleanup purposes.
- scripts/codex-login-device.sh added (PR trained-assist-agent#602, companion to setup-codex.sh from #601) — wraps the device-auth flow + auto test prompt after login completes.

## Codex engine switch — per-profile claude|codex (2026-09-15, PR #605)
- Added `engine` field to profile.json (profiles.js, was dead code — now wired into runner.js `_runTask`). `scripts/set-engine.mjs <username> [claude|codex]` flips it; default stays claude.
- CRITICAL bug found+fixed: `codex exec` BLOCKS reading stdin for EOF when stdin is an unclosed pipe — which is Node's `spawn()` default. My first manual terminal test (stdin=TTY) didn't hang, gave false confidence; a repro with `spawn(..., {cwd})` (no stdio override) hung for 20s+ every time. Fix: `stdio: ['ignore','pipe','pipe']` for the codex branch only (claude doesn't read stdin in --print mode, left untouched). Lesson: always test child_process spawns with default (pipe) stdio, not an interactive terminal — TTY vs pipe stdin behavior differs for CLIs that "optionally" read stdin.
- codex exec --json event shapes (verified against real output): `item.completed` + `item.type==='agent_message'` → final/narration text (fires once per agent turn segment, last one wins as the real answer); `item.started`/`item.completed` + `item.type==='command_execution'` → shell tool use, `item.command`/`item.aggregated_output`/`exit_code`; `turn.completed` → usage (`input_tokens`/`cached_input_tokens`/`cache_write_input_tokens`/`output_tokens`/`reasoning_output_tokens` — field names differ from claude's `cache_read_input_tokens`/`cache_creation_input_tokens`).
- v1 has NO MCP tools for codex (its MCP config is TOML/`codex mcp add`-based, not wired) and no `--append-system-prompt-file` equivalent — persona/system prompt text gets concatenated into the exec prompt string instead. If the profile experiment goes well, next step is real MCP wiring for codex.
- Still open: this PR needs merge + a live systemd restart to take effect in prod (restart = shared cgroup, kills current session — only with explicit confirmation, per earlier codex-login note). Also still needed: actually flip a real profile's engine once the user names it.

## OpenCode было "слепо" на фото — OCR-фикс (2026-09-21, PR opencode-image-ocr)
- Гэп: Claude Code сам мультимодален (Read tool видит картинку), OpenCode — нет (minimax/GigaChat/DeepSeek все текстовые). До фикса фото в OpenCode-движке было просто путём в заметке `[Файл сохранён: ...]`, модель не могла его "увидеть".
- Фикс: `src/media-vision.js` (`extractImageText`, OpenRouter + google/gemini-2.5-flash, тот же паттерн что applylink/worker.js `geminiPdf`/`imageToText` — включая isRefusal() guard, отказ-предложением от модели не должен течь в текст как реальный OCR). Триггерится в `src/server.js` /run только когда `profiles.getEngine(workDir, userId) === 'opencode'` && mime image/* && есть OPENROUTER_API_KEY — для Claude не дергается (не нужно + не тратим деньги).
- Результат кладётся ПРЯМО под старую заметку: `[Распознано на изображении: ...]` — OpenCode читает как обычный текст задачи, новый intake-путь не нужен.
- Спека: specs/opencode-image-ocr-spec.md. Codex-движок НЕ проверялся (GPT-4o скорее всего и так видит картинки) — сознательно вне скоупа.

## PR-аудит 2026-09-26: autofix сломан ГЛОБАЛЬНО + CI-аномалия
- pr-autofix v1.2 битый для ВСЕХ PR: ci.yml glue дёргает trained-assist/pr-autofix@v1.2, а тот берёт ref из github.workflow_ref (у pull_request это `refs/pull/<n>/merge` в РЕПЕ ВЫЗЫВАЮЩЕГО) и пытается fetch `raw.githubusercontent.com/trained-assist/pr-autofix/<этот-ref>/scripts/autofix.mjs` → 404 → curl exit 22 → autofix=failure на каждом PR. Восстановление конфликта через autofix мертво. Фикс: в pr-autofix резолвить ref корректно (свой pinned tag / inputs.version / github.action_ref), не workflow_ref вызывающего.
- Checklist-tracking PR (типа #1439) регулярно конфликтуют на checklist.md (main его постоянно переписывает); recovery-путь через autofix мёртв (см. выше) → стоячие chore-PR. Правило: GTD-запись о уже смерженном PR дешевле перезалить на свежую ветку, чем реебейзить конфликт.
- Аномалия CI: PR #1446 — 0 workflow-ранов на head sha даже после nudge-коммита («ci: nudge CI trigger»), ветка с 5 коммитами, Actions жив (соседние ветки бегут). Workaround: push пустого коммита не помог; следующий левел — close&reopen PR (pull_request.synchronize/reopened триггерит ран). Если и это нет — смотреть events/timeline PR.

## PR CI «не запустился» — настоящий механизм (2026-09-26, чинил #1446)
- GitHub МОЛЧА дропает pull_request-воркфлоу у PR с mergeable_state=dirty: 0 check-runs, 0 workflow runs, ни skipped, ничего. close&reopen НЕ помогает (проверено на #1446). Лечит только мерж main в ветку: конфликт снят + тот же push уже запускает CI.
- Порядок при «CI не стартовал»: сначала GET /pulls/N → mergeable_state. Dirty → resolve локально (merge origin/main, ALLOW_PR_UPDATE=1 push) и не трогать close&reopen.
- checklist.md и docs/requirements-log.md — «горячие» файлы, их трогает КАЖДЫЙ PR → ветка рождается конфликтной после каждого мержа в main. Резолв-паттерн: версия main + дописать свой блок/секцию в конец.
- Push в PR-ветку требует ALLOW_PR_UPDATE=1 (гейт хука: «emergency override, explain why»). Штатный сценарий резолва конфликтов — это ровно тот override-кейс.
- forceOpencodeAlternation теперь совмещённая семантика: escalate (PR #1446: первые 3 ретрая на той же модели, 4-й двигает лестницу) + ocRole (P3b #1451: rung по роли); deepseek двигает свою лестницу ДО флипа тумблера.

## Web-задача, убитая рестартом агента — анатомия (2026-09-26)
- Симптом «agent task rejected» в вебе — НЕ валидация агента: это worker.mjs fallback на любой не-200 не-JSON ответ. Реальная цепочка: рестарт assist-agent убил веб-таск (nginx: «upstream prematurely closed» → 502 HTML) → воркер выдумал текст → receipt в /home/vova/agent-data/web-mutations/<user>/ остался state=accepted навсегда → повторный Начать из того же черновика 409 «duplicate request already accepted» навечно. Фикс: agent#1454 (claimWebMutation takeover при отсутствии pending-journal записи + финализация receipt при boot-очистке) + web#51 (честный «Агент недоступен (HTTP 502)»).
- LOCAL TEST TRAP: в shell экспортирован AGENT_DATA_DIR=/home/vova/agent-data → тесты, задающие только HOME=tmp, всё равно пишут в ПРОД agent-data. Локальные прогоны: env -u AGENT_DATA_DIR. Pollution (alice/req-123 done-receipt, web-canary/) вычищен 2026-09-26.
- git worktree не шарит node_modules → ln -s <main-checkout>/node_modules <worktree>/node_modules.
