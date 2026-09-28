# Hermes integration — checklist

Контекст: опубликованные ранее доки — `hermes-integration-handoff` и
`hermes-training-storage-architecture` (публичные страницы, см. artifacts).
Вывод обоих: Hermes — не отдельный агент со своим диспетчером к тем же
пользователям (это и есть источник исходной проблемы «отключить Гермеса»), а
специализированный stateless-воркер ВНУТРИ trained-assist, вызываемый главным
оркестратором как один из инструментов.

Проверено по коду (2026-09-21), не только по присланному плану:

- Провайдер уже есть. `src/hh-scoring.js` уже реализует GigaChat (primary,
  `gcCall`/`gcGetToken`, self-signed cert, per-user ключ
  `agent-tokens/<user>/gigachat`) + OpenRouter (fallback, `llmCall`,
  `agent-tokens/<user>/openrouter`). Это ровно та пара моделей, которую
  предлагает roadmap (GigaChat Ultra/Pro). **Новый провайдер заводить не
  нужно** — `llmCall`/`gcCall`/`parseLlmJson`/`readGigachatKey`/`readOrKey`
  уже экспортированы из `hh-scoring.js` и полностью не привязаны к HH.
- Паттерн «текст + критерии → LLM → структурный JSON» уже реализован дважды:
  `hh-scoring.evaluateCandidate` и `99-interview-analysis.js:interview_analyze`.
  Это и есть live-прецедент rule-of-three (см. `docs/rule-of-three-cache-research.md`)
  — оправдано вынести общий примитив, а не изобретать Hermes с нуля.
- Существующие слои знаний (`agent-notes.md`, `requirements-log.md`,
  `projects/<id>/PROFILE.md`) уже реализованы и общие для claude/codex/opencode
  (см. память `project_agent_training_storage_layers`). Недостающий слой —
  `projects/<id>/agent-project-notes.md` (накопленное знание ПРО ЭТОТ проект,
  не правила проекта).
- Durable-исполнение уже есть: `src/gtd-controller.js` (durable retry/resume,
  hard cap на итерации, re-entrancy guard) — это и есть DurableTask-примитив
  из Phase 4 roadmap. Не строим вторую систему параллельно — расширяем эту.
- MCP-тулы регистрируются автодискавери из `src/mcp-skills/tools/*.js`
  (`registry.js`), нумерация файлов — не жёсткий контракт, просто сортировка.

## Phase 1 — Hermes как «тупой worker» (STARTED THIS SESSION)

Цель: один вызов `hermesRun({task, context, outputSchema})`, без памяти,
инструментов и cron. Критерий успеха: даёт более глубокий результат на
сложной задаче, состояние системы не меняется.

- [x] `src/hermes-run.js` — примитив, переиспользует `llmCall`/`gcCall` из
      `hh-scoring.js` (никакого нового провайдера).
- [x] `src/mcp-skills/tools/100-hermes.js` — MCP-тулы `hermes_run` (общий) и
      `hermes_candidate_report` (пилот №3 из roadmap: кандидат+вакансия+
      интервью → CandidateReport JSON).
- [x] `test/hermes-run.test.cjs` — контрактные тесты (нет сети в CI).
- [ ] Смок на живом ключе (GigaChat или OpenRouter) — прогнать
      `hermes_candidate_report` на одном реальном кандидате, сравнить с текущим
      `evaluateCandidate` по глубине/цене/времени (это и есть критерий успеха
      этапа из roadmap).
- [ ] Пилот №1 (vacancy → ideal candidate profile) и №2 (candidate deep
      analysis) — отдельные тулы поверх того же `hermesRun`, только после того
      как пилот №3 подтвердит качество/цену.
- [x] Смержить PR #1035, задеплоить — смерджен в `main` (`dfb750e`), сервис
      перезапущен, `hermes_run`/`hermes_candidate_report` подтверждены живыми
      в MCP-тулсете (2026-09-21).

## Phase 1.5 — Hermes с доступом в интернет: Playwright + веб-поиск (STARTED THIS SESSION)

Триггер: явный запрос владельца — Hermes должен уметь «плейрайтингом [Playwright]
и поиском сети [веб-поиском] заниматься хорошо». Проверено по коду (2026-09-21):
`hermesRun` (Phase 1) — это ОДИН сырой вызов `gcCall`/`llmCall` (chat-completions
API), без единого инструмента. Он не может открыть страницу и не может искать —
только обрабатывает текст, который ему дали в `context`. Для роли «исследовательский
воркер» из исходного ТЗ («изучи CV + интервью + доступные источники») это дыра:
«доступные источники» = сеть, а сети у Hermes не было вообще.

Рассмотрено два варианта, выбор обоснован по коду, не с нуля:

- **(A, выбран) Scoped headless-инвокация существующего движка.** Каждая обычная
  сессия УЖЕ получает `.mcp.json` с двумя MCP-серверами — `playwright`
  (`@playwright/mcp`, headless) и `trained-skills` (ru_browser_fetch,
  website_request/discover и т.д.) — это `writeMcpConfig` в `src/browser.js:77`.
  MCP-обвязка codex/opencode для этого же файла уже чинилась в этой же теме
  (PR #1040). Значит «дать Hermes Playwright» = не писать браузер-драйвер заново,
  а один раз позвать `writeMcpConfig`+`buildEngineCommand`+`runEngineProcess`
  headless (без Telegram). Проверено по коду `claude-runner.js`: все
  Telegram-вызовы (`progressEdit`→`tgEdit`, heartbeat, typing-индикатор) уже
  ЗАВИСЯТ от `msgId` и не вызываются при `msgId: null` — кроме `tgSend` в
  38-минутном тайм-аут-предупреждении, для него передан no-op. Это подтверждено
  фактическим запуском `hermesRunWithTools({username:'x', task:''})` и т.п. —
  ловятся все guard-ошибки до спавна процесса (`test/hermes-tools-run.test.cjs`).
- **(B, отклонён) Function-calling loop внутри `hermes-run.js` напрямую к
  OpenRouter/GigaChat.** Это дублирует и Playwright-драйвер (`@playwright/mcp`
  уже решает эту задачу), и веб-поиск. По поиску `grep -rniE
  "websearch|web_search|web-search"` по `src/` — единственное упоминание
  `WebSearch` во всём репо это `case 'WebSearch':` в `formatToolActivity`
  (`claude-runner.js:140`) — просто ярлык для UI-статуса Claude Code. Своего
  веб-поиска (Brave/Serper/Bing API) в системе НЕТ. Строить его отдельным
  провайдером под GigaChat/OpenRouter — новая внешняя интеграция + платный API-
  ключ ради того, что Claude Code уже даёт бесплатно как встроенный тул.

**Решение:** `hermesRunWithTools({username, task, context, outputSchema, engine})`
(`src/hermes-tools-run.js`) — новый примитив РЯДОМ с `hermesRun`, не вместо него:
`hermesRun` остаётся дешёвым путём по умолчанию для задач, которым хватает текста
в `context`; `hermesRunWithTools` — для задач, которым реально нужна сеть.
`engine` по умолчанию `'claude'` — единственный из трёх движков со встроенным
`WebSearch`/`WebFetch`, поэтому веб-поиск получаем бесплатно, без нового
провайдера и без нового платного API-ключа.

> **Обновлено 2026-09-28 (#1792):** дефолт `engine` теперь `'opencode'` (профиль
> `research`), и оба утверждения выше устарели. У opencode ТОЖЕ есть встроенный
> `websearch` — но он регистрируется только для провайдера `opencode`/`opencode-go`
> либо при `OPENCODE_ENABLE_EXA`/`OPENCODE_ENABLE_PARALLEL`. Флаг не был выставлен,
> провайдер — `openrouter`, поэтому research ходил в сеть без поиска вообще и
> возвращал выдуманные источники. Фикс: `runEngineProcess` ставит
> `OPENCODE_ENABLE_EXA=1` на каждый opencode-ран (бесплатно, ключ не нужен).

- [x] `src/hermes-tools-run.js` — `hermesRunWithTools`, реюзает
      `writeMcpConfig`/`buildEngineCommand`/`runEngineProcess` из
      `browser.js`/`claude-runner.js`, headless (`msgId: null`, no-op
      `tgEdit`/`tgSend`, throwaway `activeTimers`), workDir —
      `~/agent-tokens/<user>/hermes-tmp/`.
- [x] MCP-тул `hermes_research` в `src/mcp-skills/tools/100-hermes.js` —
      обёртка над `hermesRunWithTools`, с явным предупреждением в описании
      («медленнее и дороже `hermes_run`, не гоняй без реальной потребности
      в интернете»), чтобы не стало дефолтом на месте дешёвого `hermes_run`.
- [x] `test/hermes-tools-run.test.cjs` — контрактные тесты (guard-clauses, без
      сети/спавна процесса в CI — как и `hermes-run.test.cjs`), вписаны в
      `npm run check`/`test:cjs`; полный прогон `npm run test:cjs` зелёный (без
      регрессий по остальным 60+ тестам).
- [ ] Смок на живом ключе: реальный `hermes_research` c задачей вида «найди Х на
      сайте Y и верни поле Z» — подтвердить, что реально спавнится claude CLI,
      Playwright MCP реально открывает страницу, а не просто модель домысливает
      ответ (тот же класс риска, что и «отказ предложением», см. заметку про
      ApplyLink OCR). Не сделано в этой сессии — требует реального сетевого
      сценария, не сфабрикован.
- [ ] Тайм-аут headless-вызова сейчас = дефолтный 40-минутный `CLAUDE_TIMEOUT_MS`
      движка (не параметризован под более короткую scoped-задачу) — приемлемо
      для Phase 1.5 (бывает вызвано редко, вручную), но при переходе на cron/
      proactive Hermes (Phase 4) стоит дать `hermesRunWithTools` свой, более
      короткий потолок.
- [ ] `codex`/`opencode` как `engine` для `hermesRunWithTools` технически
      проходят (MCP-обвязка одна на всех после #1040), но без Claude'овского
      `WebSearch` — для них останется только `playwright`+`trained-skills`
      (фетч по известным URL, не поисковая выдача). Не блокирует Phase 1.5
      (дефолт `claude` уже даёт оба), но стоит явно задокументировать пользователю
      Hermes, если он когда-то попробует сменить `engine`.
      **Обновлено 2026-09-28 (#1792):** у `opencode` поисковый тул есть — см. заметку
      выше про `OPENCODE_ENABLE_EXA`; без флага у него действительно оставался только
      `webfetch` по уже известному URL. У `codex` поиска по-прежнему нет, и это остаётся
      открытой задачей (параллельные линии в #1792 добавляют поиск как MCP-тул,
      который одинаково доступен всем трём движкам).

## Phase 1.5b — DEEP-mode GTD wiring: hermes_research ДО checklist.md (PR #1080)

Триггер: явный запрос владельца (голосовое, 2026-09-22) — для сложных
research-образных задач (юзер сам говорит «research») сначала звать Hermes на
research, и только потом формировать checklist.md, а не писать чек-лист по
догадкам заранее.

- [x] `src/answer-router.js` `DEEP_BLOCK` (системный промпт DEEP-режима/
      проработки) — добавлена явная инструкция: для сложных research-образных
      задач сначала `hermes_research`, потом checklist.md на основе его
      результата. `deep-research`-скил и Workflow остаются для
      многоисточникового фан-аута — не заменены, а разведены по сценарию.
- [x] `node test/answer-router.test.cjs` + `npm run test:cjs` зелёные, без
      регрессий (текстовые substring-проверки DEEP_BLOCK не завязаны на
      конкретную формулировку).
- [ ] PR #1080 смержен, задеплоен, проверено вживую (следующая
      DEEP-сессия с research-образной сложной задачей реально видит и
      применяет инструкцию) — на GTD-трекинге (checklist.md).

## Phase 2 — общий слой знаний (PR #1036 MERGED+LIVE)

- [x] Добавить `projects/<id>/agent-project-notes.md` в `src/projects.js`
      (`notesPath`/`notesText`, не сеется при создании проекта — как и
      профильный `agent-notes.md`, файл появляется только когда в него
      реально что-то пишут) + инъекция в промпт в `runner/index.js` сразу
      после профильного `[AGENT NOTES]` блока (`test/projects-notes.test.cjs`).
- [x] Hermes и обычные сессии (claude/codex/opencode) читают/пишут ОДИН и тот
      же файл — никакого отдельного хранилища у Hermes. Технически это уже
      верно и для codex/opencode: инъекция — это простой текст промпта
      (`baseContext`, до ветвления по движку), а запись — обычный
      Write/Edit-тул файла, не MCP. Для ЭТОГО слоя знаний MCP не нужен.
- [x] Смержить PR #1036, задеплоить — смерджен в `main` (`2370839`), сервис
      перезапущен 2026-09-21, `src/projects.js`/`src/runner/index.js` на
      диске идентичны репо (сверено `diff`).
- [x] Явно зафиксировать: встроенная память Claude Code — disposable cache,
      не source of truth. Зафиксировано выше в этом же чеклисте и в
      `hermes-training-storage-architecture` — намеренно НЕ подключаем Hermes
      к ней, только к файловым слоям (`agent-notes.md`/`agent-project-notes.md`/
      `PROFILE.md`), которые видны claude/codex/opencode одинаково.
- [ ] Отдельный, более крупный техдолг (НЕ блокирует Hermes): `claude-runner.js`
      передаёт `--mcp-config` только на claude-ветке — `agent_store_artifact`
      и другие MCP-тулы недоступны на codex/opencode. Не трогали в этом PR
      (TOML-конфиг для codex + отдельный формат для opencode — самостоятельная
      задача с собственным риском регресса).

## Phase 3 — Hermes Skills (NOT STARTED — grounded scoping done 2026-09-21)

Сверено с кодом, не только с roadmap. Вывод: это **самостоятельная подсистема,
не аддитивный патч** — в отличие от Phase 1/2, здесь ничего переиспользовать
почти нечем.

- Тулы грузятся `src/mcp-skills/registry.js:14` чистым file-scan одной
  директории (`src/mcp-skills/tools/*.js`, сортировка по имени файла), без
  манифеста. Коллизия имён тула = warn+skip (`registry.js:21-24`) — это
  ПРОТИВОПОЛОЖНО нужной семантике override «system→profile→project» (там
  последний уровень должен побеждать, а не молча теряться).
  `TOOLS_DIR` — единственный существующий hook, но это «подменить всё»,
  а не слой поверх слоя.
- `users/{user}/skills/` и `projects/{project}/skills/` на диске **не
  существуют вообще** — есть только `projects/<id>/` под заметки/профиль
  (`src/projects.js`), директории под скилы придётся вводить с нуля.
- Draft → approve → publish **не на что опереться**: в кодовой базе нет ни
  одного существующего примитива ревью/версионирования контента (`gtd-controller.js`
  "pending" — это только due-time для задач, не контент-ревью). Ближайший
  реальный аналог — обычный GitHub PR (`60-github.js:github_create_pr`), но он
  общий инструмент, не привязан к скилам/Hermes.
- MCP-тулы (а значит и любой skill в виде MCP-тула) сейчас видны ТОЛЬКО
  claude-движку (`claude-runner.js:69`, `--mcp-config` только там) — Phase 3
  унаследует этот же codex/opencode-гап, если не закрыть его отдельно.

**Решение оставлено на владельца (не блокирует Phase 1/2, но блокирует старт
Phase 3):** строить ли custom три-tier merge+draft/approve с нуля, или сузить
Phase 1 до одного варианта — обычный PR-ревью на `system/`-скил (готовый
примитив) + просто "не даём Hermes писать в system/ автоматически" для
profile/project уровней (без отдельного draft-стейта, т.к. эти файлы и так
пишет только конкретный юзер/проект). Второе — на порядок дешевле и почти
ничего нового не требует.
- [ ] Первый кандидат на system-skill (после решения по дизайну выше): то, что
      уже дублировано в `hh-scoring.evaluateCandidate` + `interview_analyze` →
      один `candidate-analysis` skill поверх `hermesRun`.

## Phase 4 — durable long-running Hermes (NOT STARTED)

- [ ] Не строить новый DurableTask с нуля — расширить `gtd-controller.js`
      (уже: durable JSON на диске, dueAt-тик, re-entrancy guard, hard cap
      итераций, `checklist.md`-режим до 25 итераций). Добавить недостающие
      поля из roadmap (`hermesRunId`, `inputArtifactIds`, `resultArtifactIds`,
      `skillVersions`) как расширение существующей схемы, не новую таблицу.
    - [ ] Sub-workflow — не своя оркестрация: `subagent: research X/Y/Z` из
      roadmap = существующий `Workflow`/`Agent` fan-out паттерн этого харнесса.
- [ ] Только после Phase 1–3 доказали качество — cron/proactive Hermes (по
      аналогии с уже живым `hh_proactive_schedule`).

## Явный архитектурный риск, вынесенный на вид (не блокирует, но зафиксирован)

Roadmap предлагает GigaChat Ultra как «сильную» модель для Hermes-оркестратора.
На практике `hh-scoring.js` уже держит GigaChat как **primary с фолбэком на
OpenRouter при ошибке**, а не как единственный провайдер — это надёжнее и
дешевле в тестировании (OPENROUTER_API_KEY уже в окружении сервера). Phase 1
реализован по этой уже проверенной схеме, а не как отдельный GigaChat-only путь.
