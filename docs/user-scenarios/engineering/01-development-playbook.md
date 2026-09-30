# Engineering — Плейбук разработки: от запроса до проверенной поставки

**Домен:** Инженерная разработка (сам продукт `trained-assist-agent` и родственные репозитории)  
**Длина:** ~16 шагов (5 стадий плейбука)  
**Профиль:** любой профиль, запускающий изменения в репозитории  
**Плейбук:** `trained-assist-engineering/playbooks/development.json` (id `development`, v1, scope `system`; sibling-репо, ядро резолвит opt-in)  
**Тул:** `ba_development_playbook` (`src/mcp-skills/tools/62-business-analyst.js`), компилятор — `src/playbook-compiler.js`  
**Охват:** от «пользователь просит поставить изменение» до финализации только с актуальным доказательством приёмки

> Этот сценарий описывает **engineering playbook** — первый реальный плейбук системы. Он
> версионирован как контракт (`contracts/playbook.schema.json`): стадии → шаги, каждый
> агентный шаг несёт `executor_role` / `minimum_model_level` / `context_budget` и
> машино-проверяемую `validation`; объективные проверки — programmatic-шаги. Плейбук
> никогда не называет конкретную модель/провайдера — их резолвит рантайм по контракту шага.
>
> **Режим запуска (#1887 п.1).** Этот сценарий — **фоновый** путь (durable-план). Он по умолчанию
> для веба и неинтерактивных вызовов, в Telegram — при явном `mode:"background"` («в фоне») или
> когда в чате уже открыт гайд. В Telegram без `mode` по умолчанию идёт гайд — см. `03-playbook-guide-mode.md`.

---

## Состояние слайсов (#1372) — что реально работает сегодня

| Слайс | Что делает | Статус |
|-------|-----------|--------|
| **P0** | Реестр плейбуков: `playbook_list` / `playbook_get`, резолв profile → sibling → system | ✅ IMPLEMENTED |
| **P1** | Авторинг через Hermes: `playbook_draft` / `playbook_edit` / `playbook_save` | ✅ IMPLEMENTED |
| **P2** | `playbook_run` — компиляция плейбука + goal в DRAFT durable-план (items пиннятся к `playbook_id@version`) | ✅ IMPLEMENTED |
| **P3a** | Активация (`task_update status=active`) + бюджет шага (`attempt_count`/`max_attempts`, `expireWaitingDeadlines`, `execution_timeout_seconds`) | ✅ IMPLEMENTED |
| **P3b** | Резолв движка/модели по `executor_role` / `minimum_model_level` / `context_budget` (`src/playbook-executor.js`) | ✅ IMPLEMENTED |
| **P3c** | Recovery-policy (`failure-classifier` → `recovery_policy`) после исчерпания бюджета | ✅ IMPLEMENTED (#1457/#1458) |
| **P3d** | `task_validation_results` + `evidence_json`, гейт финализации contract-плана | ✅ IMPLEMENTED (#1431/#1442) |
| **P4** | Исполнение хуков (`notify`/`check` на границах стадий/шагов) | ✅ IMPLEMENTED (#1459/#1460) |
| **P5** | Вынос плейбуков + дефолт по аудитории (`AUDIENCE_DEFAULT_PLAYBOOK`) | ✅ IMPLEMENTED (#1462/#1464, dev-вынос #1541) |

**Что это значит для сценария ниже:** весь контур P0–P5 **работает** — авторинг/компиляция,
активация, claim items, бюджет шага, резолв контракта в движок/модель (P3b), recovery
после исчерпания попыток (P3c), машинная финализация по evidence (P3d) и хуки (P4).
Инженерный `development.json` живёт в sibling-репо `trained-assist-engineering` (#1541),
ядро резолвит его opt-in. Остаток работы сведён в sub-issue #1573 (авто-предложение
плейбука на старте dev-задачи, судьба prose-процедур, живая приёмка).

**Как работает резолв (P3b):** `src/playbook-executor.js` — чистый резолвер:
`executor_role` + `minimum_model_level` (эскалированный `current_model_level` важнее) →
`{engine, ocProfile, ocRole}`. Programmatic-шаги движка не получают; contract-шаги без
контракта / legacy → дефолтный движок (`claude`). Таблица level→engine — это данные
(`PLAYBOOK_LEVEL_MAP`): `bachelor → opencode/value`, `master → opencode/max`,
`doctor → claude`. `context_budget` влияет на то, как шаг получает контекст
(`contextSkipModels`).

---

## Контекст (начальный state)

- Профиль существует, рабочая директория сессии доступна
- Плейбук `development` виден через резолв: `playbooks/development.json` (system scope)
- Активного durable-плана по этой цели нет
- Durable store: `$AGENT_DATA_DIR/durable-tasks.db` (SQLite), схема переживает рестарт
- Пользователь хочет «поставить изменение» — багфикс или небольшую фичу

---

## Сценарий

### Шаг 1 — Пользователь формулирует цель

```
User: почини баг — бот не отправляет уведомление об истечении HH-токена
```

**Ожидаем:**
- Бот (Hermes) распознаёт инженерную цель и подтягивает плейбук `development`
- Показывает пользователю, что запускает process-артефакт, а не разовый промпт
- Цель (`goal`) сохраняется дословно как вход компиляции

**Validation:**
- `playbook_get id=development` возвращает плейбук (v1, source=`system`)
- Ничего не создано и не запущено — это только чтение реестра

**Статус:** ✅ IMPLEMENTED (P0)

---

### Шаг 2 — Компиляция плейбука + цели в DRAFT-план

Бот вызывает `playbook_run({ playbook_id: "development", goal: "<цель>", project_id?, session_id? })`.

```
Task(playbook_run): playbook_id=development, goal="<цель>"
```

**Ожидаем:**
- `src/playbook-compiler.js` рендерит `goal_template` (`{goal}`/`{input}`), заголовки и
  инструкции шагов с подстановкой vars
- Из `stages[].steps[]` получается линейный список items; каждый item пиннится к
  `{playbook_id: "development", playbook_version: 1}`
- Применяются `defaults` плейбука: `max_attempts=3`, `execution_timeout_seconds=600`,
  `recovery_policy="default"`
- `user_value` рендерится из `user_value_template`:
  «Working, verified change for the goal, with current acceptance evidence.»
- `acceptance_criteria` выводятся из валидаций шагов (если не переданы явно) — один
  критерий `development-complete` со списком `{stage, step, validation}`

**Validation:**
- План сохранён **одной атомарной транзакцией** через `task_create` (не по частям)
- `task.status = "draft"` — план НЕ исполняется, пока не активирован
- Агентный шаг без `executor_role`/`minimum_model_level`/`context_budget` → ошибка
  `COMPILE_INVALID`, а не молча выдуманный дефолт
- Неизвестный/невалидный плейбук → кодированная ошибка, в БД ничего не записано

**Статус:** ✅ IMPLEMENTED (P2)

---

### Шаг 3 — Проекция contract-плана в `checklist.md`

**Ожидаем:**
- Если задан `project_id`, `DurableTaskStore.writeProjection()` рендерит
  `<project>/.trained-assist/tasks/<taskId>/checklist.md`
- Каждый контрактный item печатается как `[executor_role/minimum_model_level/context_budget]`,
  programmatic-шаг — как `[programmatic]`

Пример строки проекции:

```markdown
- [ ] [researcher/bachelor/small] Define user value
- [ ] [reviewer/master/medium] Define validation
- [ ] [programmatic] Run tests, lint and regression checks
```

**Validation:**
- `checklist.md` содержит все items плейбука в порядке стадий
- Ошибка проекции даёт `projection_warning`, но **не** откатывает уже закоммиченный план
  (БД — источник истины)

**Статус:** ✅ IMPLEMENTED (P2/проекция store)

---

### Шаг 4 — Пользователь подтверждает план (проверка перед активацией)

```
User: план ок, запускай
```

**Ожидаем:**
- Бот показывает список шагов с их контрактами (роль/уровень/бюджет) и просит подтверждение
- Явная активация — отдельный шаг: план не стартует самовольно

**Validation:**
- До подтверждения `task.status` остаётся `draft`
- Ни один item не claim-ится (scheduler видит только `active`-планы)

**Статус:** ✅ IMPLEMENTED (P3a — гейт `draft→active`)

---

### Шаг 5 — Активация плана

Бот вызывает `task_update({ task_id, status: "active" })`.

**Ожидаем:**
- `DurableTaskStore.updateTask` переводит план `draft → active` (гейт сужен: `done`
  остаётся заблокированным до per-criterion валидации — гейт finalizePlan, P3d)
- План становится виден executor'у (`gtd-controller.js → claimNextDurableItem`)

**Validation:**
- `expireWaitingDeadlines(now)` вызывается до reconcile/claim — истёкшие `waiting` не
  выдаются повторно
- Активация — единственный способ сделать contract-план claimable

**Статус:** ✅ IMPLEMENTED (P3a)

---

### Шаг 6 — Стадия `frame`: ценность, критерии приёмки, валидация

Executor claim-ит items по порядку. Первые три шага:

1. **Define user value** — `agent / researcher / bachelor / small`
2. **Record acceptance criteria** — `agent / researcher / bachelor / small`
3. **Define validation** — `agent / reviewer / master / medium`

**Ожидаем:**
- Шаг 1 фиксирует пользовательскую ценность (что именно станет лучше)
- Шаг 2 записывает критерии приёмки в форме, которую можно проверить
- Шаг 3 определяет для каждого пункта плана **машино-проверяемую** `validation`
  (у каждого item уже есть поле `validation`, но здесь оно уточняется под цель)
- Каждый шаг завершается маркером `DURABLE: done` или `DURABLE: failed: <причина>`

**Validation:**
- `validation.user_value_written` / `acceptance_criteria_recorded` / `validation_defined_per_item`
- `attempt_count` шага инкрементится на `startExecution`, а не на claim
- Шаг без `DURABLE:`-маркера трактуется как провал и ретраится по `max_attempts`

**Статус:** claim + бюджет ✅ IMPLEMENTED (P3a); резолв `researcher/bachelor` в движок ✅ IMPLEMENTED (P3b — `bachelor → opencode/value`).

---

### Шаг 7 — Стадия `discover`: воспроизведение и root cause

1. **Research or reproduce the problem** — `agent / researcher / bachelor / medium`
2. **Identify root cause when needed** — `agent / researcher / master / medium`

**Ожидаем:**
- Сначала проблема воспроизводится или исследуется (лог, тест, минимальный репро)
- Затем определяется корневая причина; если баг тривиален — root cause всё равно
  фиксируется явно, а не пропускается

**Validation:**
- `problem_reproduced_or_researched`, `root_cause_identified`
- Репро/лог прикладывается как доказательство к шагу (evidence — ✅ P3d, `task_items.evidence_json`)

---

### Шаг 8 — Стадия `design`: минимальное изменение, риски, нарезка

1. **Design the smallest change** — `agent / developer / master / medium`
2. **Check risks and rollback** — `agent / reviewer / master / medium`
3. **Split implementation into small slices** — `agent / developer / master / small`

**Ожидаем:**
- Проектируется наименьшее изменение (без попутного рефакторинга)
- Проверяются риски и путь отката
- Работа режется на маленькие слайсы, каждый из которых отдельно проверяем

**Validation:**
- `smallest_change_designed`, `risks_and_rollback_recorded`, `slices_defined`
- Шаг «Check risks and rollback» исполняет роль `reviewer` (не тот же агент, что дизайн)

---

### Шаг 9 — Стадия `build`: реализация

```
Task(durable item): [developer/master/large] Implement
```

**Ожидаем:**
- Реализация по ранее нарезанным слайсам, в feature-ветке
- Ничего не пушится в `main`; PR-флоу — обязателен (см. `docs/user-scenarios/README.md`)
- Шаг длинный: `context_budget=large`, `execution_timeout_seconds` применяется как
  жёсткий лимит на прогон движка (clamp ≤ 40 мин)

**Validation:**
- `implementation_complete`
- Пробой `execution_timeout_seconds` = провал шага (не «бесконечное продолжение»),
  ретраит durable-слой по `max_attempts`
- Движок для шага (`developer/master/large`) резолвится ✅ IMPLEMENTED (P3b — `master → opencode/max`)

**Статус:** claim/таймаут ✅ IMPLEMENTED (P3a)

---

### Шаг 10 — Programmatic: тесты, lint, регрессия

```
Task(durable item): [programmatic] Run tests, lint and regression checks
```

**Ожидаем:**
- Объективная проверка — не LLM: запускаются тесты/lint/регрессия проекта
- Успех/провал определяется кодом возврата, а не суждением модели

**Validation:**
- `command_exit_zero: "npm run check && npm test"` — код возврата, не суждение модели
- `execution_kind=programmatic` → `executor_role/minimum_model_level/context_budget = null`
  (в `checklist.md` печатается `[programmatic]`)
- Ни одна programmatic-проверка не порождает Claude-сессию для «оценки» результата

---

### Шаг 11 — Programmatic: открытие PR

```
Task(durable item): [programmatic] Open PR
```

**Ожидаем:**
- Пуш feature-ветки и `gh pr create --base main`
- Хук `task_done` (`notify to=owner`) исполняется рантаймом (✅ P4) — уведомление
  уходит через audience-aware `bot-delivery.js` только с согласием (`approveHooks`),
  иначе записывается как `skipped` и не валит задачу

**Validation:**
- `pr_opened` — детерминированный GitHub-валидатор (`#1449`): подтверждает
  существование PR из ссылки в шаге/цели либо ищет PR по `repo/head-ветке`,
  взятой из git-checkout проекта. Никакого LLM.
- URL PR сохраняется как evidence шага

---

### Шаг 12 — Programmatic: ожидание CI и починка провалов

```
Task(durable item): [programmatic] Wait for CI and staging; repair failures
```

**Ожидаем:**
- `delay_after_sec: 600` — шаг становится runnable не раньше, чем через 10 минут
- Пока шаг ждёт, он `waiting` с `wait_deadline_at`; `expireWaitingDeadlines` фейлит
  шаг, если внешнее ожидание переросло дедлайн (вечное откладывание исключено)
- Провал CI чинится и перезапускается

**Validation:**
- `ci_green`
- `delay_after_sec` уважается store'ом (due_at = now + delay)
- Провал ожидания → `failed`, не бесконечный `pending`

**Статус:** delay/wait-budget ✅ IMPLEMENTED (P3a)

---

### Шаг 13 — Programmatic: merge + deploy

```
Task(durable item): [programmatic] Merge and deploy
```

**Ожидаем:**
- Squash-merge PR только после зелёного CI
- Деплой на оба VM (GCP + RU) по обычному флоу; release-модель (#1391)
- После провала деплоя — откат на предыдущий релиз (симлинк)

**Validation:**
- `merged`
- Применён правильный deploy-путь (PR→CI→automerged→deploy), без прямого пуша в `main`

### Product decision — staging/deploy halves dropped (#1449)

Единого health-сигнала «staging зелёный» / «задеплоено» across репозиториев нет,
поэтому детерминированные ключи `ci_and_staging_green` / `merged_and_deployed`
**больше не требуются** плейбуком. Осталось `ci_green` + `merged` — то, что реально
проверяется GitHub API без модели. Сам деплой по-прежнему входит в процесс шага 13,
но его *верификация* (проверка живого сценария) — за агентом на шаге 14
(`user_scenario_verified`), а не за programmatic-ключом. Валидаторы
`ci_and_staging_green` / `merged_and_deployed` остаются в реестре для плейбуков,
которые позже заведут настоящий сигнал.

---

### Шаг 14 — Стадия `deliver`: проверка реального пользовательского сценария

```
Task(durable item): [verifier/master/medium] Verify the actual user scenario
```

**Ожидаем:**
- Проверяется **тот самый** пользовательский сценарий из шага 6 (не просто «зелёные тесты»)
- Например: отправить боту сообщение, воспроизводящее исходный баг, и убедиться, что
  теперь уведомление приходит
- Доказательство привязывается к шагу

**Validation:**
- `user_scenario_verified`
- Проверка идёт на реальном окружении, а не только unit-тестами
- Резолв `verifier/master` движком ✅ IMPLEMENTED (P3b)

---

### Шаг 15 — Стадия `deliver`: наблюдение при необходимости

```
Task(durable item): [verifier/master/medium] Observe when needed
```

**Ожидаем:**
- Для изменений с отложенным эффектом (фоновые задачи, court-таймеры) — наблюдение
  в течение окна времени
- Если наблюдение не требуется, шаг закрывается без выдуманных данных

**Validation:**
- `observation_done`
- Отсутствие наблюдения не подменяется «наверное, работает»

---

### Шаг 16 — Финализация ТОЛЬКО с актуальным доказательством приёмки

```
Task(durable item): [reviewer/doctor/medium] Finalize only with current acceptance evidence
```

**Ожидаем:**
- Финализация (`done`) разрешена **только** если все критерии приёмки подтверждены
  свежим evidence
- Contract-план нельзя закрыть «на память» или по устаревшему доказательству
- Это самый высокий уровень в плейбуке: `reviewer / doctor / medium`

**Validation:**
- `acceptance_evidence_current`
- `updateTask`-гейт не даёт перевести contract-план в `done` без per-criterion
  валидации — ✅ IMPLEMENTED (P3d, `finalizePlan`)

**Статус:** сам шаг claim/бюджет ✅ IMPLEMENTED (P3a); машинная разблокировка финализации ✅ IMPLEMENTED (P3d — гейт `finalizePlan`).

---

## Сводка контрактов шагов

| # | Плейбук-item | execution_kind | executor_role | minimum_model_level | context_budget |
|---|--------------|----------------|---------------|---------------------|----------------|
| 1 | Define user value | agent | researcher | bachelor | small |
| 2 | Record acceptance criteria | agent | researcher | bachelor | small |
| 3 | Define validation | agent | reviewer | master | medium |
| 4 | Research or reproduce the problem | agent | researcher | bachelor | medium |
| 5 | Identify root cause when needed | agent | researcher | master | medium |
| 6 | Design the smallest change | agent | developer | master | medium |
| 7 | Check risks and rollback | agent | reviewer | master | medium |
| 8 | Split implementation into small slices | agent | developer | master | small |
| 9 | Implement | agent | developer | master | large |
| 10 | Run tests, lint and regression checks | programmatic | — | — | — |
| 11 | Open PR | programmatic | — | — | — |
| 12 | Wait for CI and staging; repair failures | programmatic (delay_after_sec=600) | — | — | — |
| 13 | Merge and deploy | programmatic | — | — | — |
| 14 | Verify the actual user scenario | agent | verifier | master | medium |
| 15 | Observe when needed | agent | verifier | master | medium |
| 16 | Finalize only with current acceptance evidence | agent | reviewer | doctor | medium |

Дефолты плейбука: `max_attempts=3`, `execution_timeout_seconds=600`, `recovery_policy="default"`.

---

## Хуки (объявлены в плейбуке, исполняются рантаймом — ✅ P4)

| Событие | Хук | Что должен делать |
|---------|-----|-------------------|
| `task_done` | `notify to=owner "Task done: {goal}"` | Уведомить владельца о завершении |
| `task_failed` | `notify to=owner "Task stuck: {goal} — {error}"` | Уведомить о застревании |
| `stage.on_enter` / `stage.on_exit` | (по стадиям) | Границы стадии |
| `step.on_complete` / `step.on_fail` | (по шагам) | Границы шага |

Схема допускает также `check`, `create_issue`, `publish`. Рантайм (`src/playbook-hooks.js`)
исполняет хуки на границах; внешние эффекты (`notify`/`create_issue`/`publish`) требуют
согласия (`approveHooks`/`execution_policy.hooks_approved`), иначе `skipped`.

---

## Programmatic-шаги → `runner` (предложение)

Сейчас `execution_kind: programmatic` говорит только **что** шаг объективный, но не
называет, **чем** он исполняется: в `contracts/playbook.schema.json` и
`src/durable-task-plan.js` (`itemSchema`) нет поля `runner`/`script`/`command`. Поэтому
`checklist.md` рендерит просто `[programmatic]`.

Предложение — опциональное поле `runner` на шаге (schema v2), которое может быть
**и shell-командой, и id зарегистрированного действия/MCP-тула** (для инженерных шагов —
команды, для доменов — действия):

| # | Programmatic-item | Что должно выполниться | Предлагаемый `runner` |
|---|-------------------|------------------------|-----------------------|
| 10 | Run tests, lint and regression checks | `npm run check` + `npm test` | `shell: npm run check && npm test` |
| 11 | Open PR | `git push -u` + `gh pr create` | `action: git.open_pr` |
| 12 | Wait for CI and staging; repair failures | `gh pr checks --watch` | `action: ci.wait_for_green` |
| 13 | Merge and deploy | `gh pr merge --squash` + deploy | `action: deploy.merge_and_release` |

Как это отображалось бы в `checklist.md`:

```
- [ ] [programmatic: shell: npm run check && npm test] Run tests, lint and regression checks
- [ ] [programmatic: action: git.open_pr] Open PR
```

До schema v2 эквивалент — писать имя команды/действия в `instructions` шага (валидно
сегодня, но не машиночитаемо). Резолв `runner` в исполнение — это отдельный слайс; поле
только декларирует контракт.

> **#1449 (P3d follow-up):** объективно-проверяемая половина шага уже машиночитаема —
> это `validation`-ключи (`command_exit_zero`, `pr_opened`, `ci_green`, `merged`),
> исполняемые детерминированным реестром `src/playbook-validators.js`. Для шага 10
> `command_exit_zero` и запускает команду, и валидирует её код возврата; шаги 11–13
> проверяют уже созданные внешние артефакты (PR/CI/merge). Поле `runner` остаётся
> отдельным предложением для действий, которые нужны *до* проверки.

---

## CI-сценарий (черновик): план моков

Цель — тот же flow из 16 шагов, но детерминированно и без внешних миров, чтобы это был
тест, а не ручной прогон. План моков пишется **вместе со сценарием** — моки это часть
определения сценария, не постфактум.

| Что мокаем | Чем | Что проверяем вместо реального |
|------------|-----|-------------------------------|
| LLM/Hermes (агентные шаги) | скриптованные ответы: шаг отдаёт нужный артефакт + `DURABLE: done` / `DURABLE: failed: <причина>` | порядок и состав агентных шагов, реакцию на провал |
| Резолвер движка (P3b) | table-driven, без спавна процесса | что шаг с ролью/уровнем получает ожидаемый `{engine, ocProfile}` |
| `git` / `gh` | фейковый провайдер: «PR создан», «checks green» | что programmatic-шаг вызвал нужный `runner`, а не просто отписался |
| CI/staging и деплой | фейковый `ci.wait_for_green` / `deploy.merge_and_release` | что merge не идёт раньше зелёного CI |
| Telegram (`sendMessage`/`editMessageText`) | перехват в массив | текст/факт отправки, без реальной сети |
| Durable store + `checklist.md` | временная SQLite + temp-папка проекта | персистентность и рендер контрактов |
| Часы / `delay_after_sec=600` | fake timers | что wait-шаг не становится runnable раньше срока |

Детерминированные ассерты сценария:

1. `playbook_run` создаёт **draft** ровно с 16 items, пиння к `development@1`.
2. До `task_update status=active` ни один item не claim-ится; после — claim в порядке стадий.
3. Programmatic-шаг вызывает объявленный `runner` (в v2) / записанную команду (сегодня).
4. Провал шага ретраится ровно `max_attempts` раз, затем `failed` — не вечный `pending`.
5. Шаг с `delay_after_sec=600` не runnable до +600s (fake clock), и по `wait_deadline_at`
   истёкший waiter становится `failed`.
6. Финализация (P3d): план без свежего evidence не переходит в `done`.

---

## Edge Cases в этом сценарии

| Ситуация | Ожидаемое поведение |
|----------|---------------------|
| Цель пустая / пробельная | `GOAL_REQUIRED` — план не создаётся |
| Плейбук не найден или невалиден | `PLAYBOOK_NOT_FOUND` / `INVALID_PLAYBOOK`, в БД ничего не записано |
| Агентный шаг без `executor_role`/`level`/`budget` | `COMPILE_INVALID` с именем шага, без молчаливого дефолта |
| Плейбук отредактировали после запуска | Уже запущенный план пиннится к версии — не мутирует |
| Ошибка записи проекции `checklist.md` | `projection_warning`; план в БД считается созданным |
| Шаг упал | Ретрай пока `attempt_count < max_attempts`, затем `failed` (не вечный `pending`) |
| Шаг завис / перерасходовал `execution_timeout_seconds` | Жёсткий kill движка, шаг = провал, ретрай по бюджету |
| Ждём CI дольше `wait_deadline_at` | `expireWaitingDeadlines` → `failed`, не откладывание навсегда |
| Рестарт агента во время плана | Items персистентны в SQLite; orphaned `running` возвращаются в `pending` |
| План закрывают без evidence | Гейт финализации не пускает (✅ P3d) |

---

## Проверяемые инварианты

1. **Плейбук — версионированный артефакт, не промпт.** Редактирование плейбука не
   мутирует уже запущенный план, пиннящий `{playbook_id, playbook_version}`.
2. **Агентный шаг без контракта не компилируется.** Ни один шаг не получает
   выдуманную модель/уровень/бюджет.
3. **План создаётся одной атомарной транзакцией** — частично записанных планов не бывает.
4. **DRAFT не исполняется.** Contract-план claimable только после явного
   `task_update status=active`.
5. **Programmatic-шаги объективны** — проверка по коду/данным, без LLM-суждения и без
   спавна Claude-сессии для «оценки» результата.
6. **Бюджет шага конечен.** `max_attempts` и `execution_timeout_seconds` ограничивают
   ретраи и время; исчерпание = `failed`, а не бесконечный `pending`.
7. **Финализация — только по актуальному доказательству приёмки**, не по факту
   «шаги прошли» (✅ P3d).
