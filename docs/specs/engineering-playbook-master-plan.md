# Инженерный плейбук — мастер-план (#1372)

> Единый план доведения **Playbooks** до рабочего состояния, на примере инженерного
> плейбука (`development`). Это **не** новый дизайн — инфраструктура стоит; файл
> фиксирует, что уже сделано, и что осталось.
>
> **Обновлён 2026-09-27.** P0–P5 эпика #1372 **смержены**. Инженерный плейбук
> вынесен из ядра в доменный sibling-репозиторий `trained-assist-engineering`
> (#1541). `AUDIENCE_DEFAULT_PLAYBOOK` реализован (`src/audience-default-playbook.js`).
> Оставшаяся работа сведена в sub-issue **#1573**.
>
> Детали слайса живут в отдельных ТЗ (`docs/specs/playbook-executor-p3b-design.md`)
> и issue; здесь — карта целиком.

## TL;DR статуса (сверено по коду, не по памяти)

| Слайс | Что закрывает | Где | Статус |
|-------|---------------|-----|--------|
| **P0** | Реестр плейбуков, резолв profile→sibling→system, schema v1, рендер | `src/playbook-store.js`, `contracts/playbook.schema.json`, MCP `playbook_list`/`playbook_get` | ✅ merged |
| **P1** | Authoring через Hermes: draft→edit*→save | `src/playbook-authoring.js`, MCP `playbook_draft`/`playbook_edit`/`playbook_save` | ✅ merged |
| **P2** | `playbook_run` — компиляция в DRAFT durable-план, пин `playbook_id@version` | `src/playbook-compiler.js`, MCP `playbook_run` | ✅ merged |
| **P3a** | Активация `draft→active`, бюджет шага (`attempt_count`/`max_attempts`, `expireWaitingDeadlines`, `execution_timeout_seconds`) | `src/gtd-controller.js`, `src/durable-task-store.js` | ✅ merged (#1417) |
| **P3b** | Резолв контракта шага в движок/модель/роль | `src/playbook-executor.js`, проводка в `runDueDurable`/`runner` | ✅ merged (#1425) |
| **P3c** | Recovery-policy: `failure-classifier` → `recovery-policy.nextAction`, cross-engine / ladder fallback | `src/durable-recovery.js`, `src/recovery-policy.js` | ✅ merged (#1457/#1458) |
| **P3d-1** | Валидаторы + детерминированное исполнение programmatic-шагов + evidence + `validation_mode` | `src/playbook-validators.js` | ✅ merged (#1431, +1c #1441) |
| **P3d-2** | Гейт финализации (`finalizePlan`, `validation_mode`) | `src/durable-task-store.js`, `src/durable-task-plan.js` | ✅ merged (#1442) |
| **P4** | Исполнение хуков на границах стадий/шагов | `src/playbook-hooks.js`, `runDueDurable` | ✅ merged (#1459/#1460) |
| **P5** | Вынос инженерного/фриланс/выставочного плейбуков + дефолт по аудитории | `playbooks/`, sibling `trained-assist-engineering#1541`, `src/audience-default-playbook.js` | ✅ merged (#1462/#1464, dev-вынос #1541) |

**Что работает end-to-end:** `playbook_run` → draft-план с контрактом на каждом
item → `task_update status=active` → claim по стадиям → per-step таймаут и бюджет
попыток → **разный движок/профиль/роль по шагу** (P3b) → programmatic-шаги
исполняются без модели и пишут evidence (P3d-1) → провал шага классифицируется и
восстанавливается по фиксированной таблице (P3c) → финализация `done` только при
пройденном гейте per-criterion validation (P3d-2) → хуки `notify`/`check`/
`create_issue`/`publish` на границах стадии/шага/задачи (P4). Чеклист рендерит
`[executor_role/minimum_model_level/context_budget]`.

**Чего ещё нет (→ #1573):**

- **Авто-предложение плейбука.** `playbook_suggest` — read-only подсказка, её
  должен явно вызвать агент. Ничто **само** не подсовывает плейбук агенту на старте
  dev-задачи в основном боте (слайс C, ядро #1573).
- **Судьба prose-процедур** `trained-assist-engineering/playbooks/{implement-feature,
  fix-bug,prepare-task,connect-github}.md` (слайс D) не решена.
- **Живая проверка на GCP VM + E2E на боте** (слайсы B/E) не записана в issue.

---

## Модель: Playbook → Plan → Executor

```
Playbook (id+version, scope: repo | profile)
   │  playbook_draft / playbook_edit  ← Hermes: НЛ → валидный плейбук
   ▼
Plan (DurableTaskStore.createPlan: playbook_id, playbook_version, items[contract], hooks)
   │  playbook_run / task_create → DRAFT → task_update status=active
   ▼
Executor (claim item → resolveStepExecution → engine/model ladder
          → validators/evidence (P3d) → recovery (P3c) → hooks (P4)
          → finalizePlan: done only when every declared validation passes)
```

**Playbook v1** (`contracts/playbook.schema.json`): `stages[] → steps[]`. Каждый
agent-шаг несёт `executor_role` / `minimum_model_level` / `context_budget` + непустой
`validation`; объективные шаги — `execution_kind: "programmatic"`. Плейбук **никогда**
не называет конкретную модель/провайдера. Хуки — закрытый словарь (`notify` / `check`
/ `create_issue` / `publish`) на `stage.on_enter|on_exit`, `step.on_complete|on_fail`,
`hooks.task_done|task_failed`.

### Резолв плейбука (P0/P5)

`PlaybookStore` резолвит id на самом приоритетном уровне, где он есть:

```
1. profile custom : ~/users/<profile>/playbooks/<id>.json          (scope "profile")
2. sibling repo   : <repo-parent>/<domain-skill-repo>/playbooks/…  (scope "system")
3. system repo    : <this repo>/playbooks/…                        (scope "system")
```

Инженерный `development.json` живёт в sibling-чекауте
`trained-assist-engineering/playbooks/` (#1541) — ядро своей копии не держит.
Отсутствие sibling'а — нормальное состояние: `playbook_list` его не показывает,
`playbook_run` отдаёт `PLAYBOOK_NOT_FOUND`, агент просто работает без скаффолда
(opt-in, не зависимость). `AUDIENCE_DEFAULT_PLAYBOOK` (`src/audience-default-playbook.js`)
— отдельный слой «аудитория → плейбук» (env → `config/audience-default-playbooks.json`
→ built-ins), read-only: только подсказывает, никогда не запускает.

---

## Инженерный плейбук как эталонный кейс

`trained-assist-engineering/playbooks/development.json` (v1, scope `system`) —
5 стадий / 16 шагов. Разбор по контрактам:

| # | Стадия | Шаг | kind | role | level | budget |
|---|--------|-----|------|------|-------|--------|
| 1 | frame | Define user value | agent | researcher | bachelor | small |
| 2 | frame | Record acceptance criteria | agent | researcher | bachelor | small |
| 3 | frame | Define validation | agent | reviewer | master | medium |
| 4 | discover | Research or reproduce the problem | agent | researcher | bachelor | medium |
| 5 | discover | Identify root cause when needed | agent | researcher | master | medium |
| 6 | design | Design the smallest change | agent | developer | master | medium |
| 7 | design | Check risks and rollback | agent | reviewer | master | medium |
| 8 | design | Split implementation into small slices | agent | developer | master | small |
| 9 | build | Implement | agent | developer | master | large |
| 10 | build | Run tests, lint and regression checks | **programmatic** (`command_exit_zero`) | — | — | — |
| 11 | build | Open PR | **programmatic** (`pr_opened`) | — | — | — |
| 12 | deliver | Wait for CI and staging; repair failures | **programmatic** (`ci_green`, `delay_after_sec: 600`) | — | — | — |
| 13 | deliver | Merge and deploy | **programmatic** (`merged`) | — | — | — |
| 14 | deliver | Verify the actual user scenario | agent | verifier | master | medium |
| 15 | deliver | Observe when needed | agent | verifier | master | medium |
| 16 | deliver | Finalize only with current acceptance evidence | agent | reviewer | doctor | medium |

Дефолты плейбука: `max_attempts=3`, `execution_timeout_seconds=600`, `recovery_policy="default"`.
Резолв уровня (P3b, `src/playbook-executor.js`): `bachelor → opencode/value`,
`master → opencode/max`, `doctor → claude`. Роль → opencode-роль: `researcher→explore`,
`developer→build`, `reviewer/verifier→review`.

> Пользовательский разбор этого плейбука (что ожидается на каждом шаге, edge cases,
> инварианты) — в `docs/user-scenarios/engineering/01-development-playbook.md`.
> Обзор реестра и жизненного цикла — в `docs/playbooks.md`.

---

## Что закрыто (P3c–P5) — детали

### P3d — programmatic-шаги, validation/evidence, гейт финализации

- `src/playbook-validators.js` — реестр `validation key → async validator(ctx) →
  {status:'pass'|'fail'|'inconclusive', evidence, subject}` (`ci_green`, `pr_opened`,
  `command_exit_zero`, `file_exists`, `merged`/`pr_merged`, …). Незнакомый ключ →
  `inconclusive`; ошибка/битый JSON LLM → `inconclusive` (никогда не слепой pass).
- `validation_mode` (`programmatic | programmatic+llm | programmatic+llm-fastpass`),
  приоритет per-step > per-plan (`execution_policy_json`) > env
  `PLAYBOOK_VALIDATION_MODE` > дефолт `programmatic+llm`. Per-step режим выбирает
  агент в рантайме (`task_item_update`), fast-pass escape пишется в
  `task_validation_results` как `pass` + `evidence {skipped:true, reason, mode}`.
- `runDueDurable`: `programmatic` item **не** спавнит движок — прогоняет валидаторы,
  пишет `task_validation_results` + `evidence_json`, затем complete/fail по бюджету.
- `DurableTaskStore.finalizePlan(taskId, profileId)` — `done` только если каждое
  объявленное `(criterion_id, validator)` имеет `status='pass'` на текущем
  `contract_revision`. `updateTask status='done'` для contract-плана идёт через
  тот же гейт (сырой SQL-обход убран). Единое определение критериев —
  `src/durable-task-plan.js`.

### P3c — recovery после провала

- Каждая failure-ветка `runDueDurable` классифицирует ошибку
  (`failure-classifier.classifyDeterministic`) и берёт `nextAction(class, {spent})`
  из фиксированной таблицы `src/recovery-policy.js` (не решение LLM).
- Действия переиспользуют существующее: re-pend, `bumpModelLevel`
  (bachelor→master→doctor, на doctor — engine-fallback на claude),
  `opencode-ladder.forceAdvance`, `opencode-go-toggle.forceFlip`, backoff.
- Двойной кап: `max_attempts` item'а и `DEFAULT_RECOVERY_BUDGET`. Исчерпание →
  `terminal` (item остаётся `failed`), бесконечный re-pend исключён.
- Новый модуль `src/durable-recovery.js`; `last_failure_class`/`last_recovery_action`
  пишутся и на item, и в execution-history.

### P4 — хуки

- `compilePlaybook` резолвит task-хуки (`task_done`/`task_failed`) и per-item хуки
  (`step.on_complete`/`on_fail`, `stage.on_enter`/`on_exit` — на границы первого/
  последнего item стадии). Хуки персистятся на `playbook_version`.
- `src/playbook-hooks.js`: закрытый словарь `notify|check|create_issue|publish`;
  внешний эффект требует согласия (explicit `approveHooks` или
  `execution_policy.hooks_approved=true`), иначе `skipped` — задача не падает.
- Fire-once через `boundary_key` в `hook_executions`; `notify` идёт через
  audience-aware `bot-delivery.js`.

### P5 — вынос плейбуков + дефолт по аудитории

- `trained-assist-engineering/playbooks/development.json` (#1541).
- `playbooks/freelance-project-spec.json`, `playbooks/exhibition-catalog-to-sales-site.json`
  (ядро, `scope "system"`) — #1462/#1464.
- `AUDIENCE_DEFAULT_PLAYBOOK` (`src/audience-default-playbook.js` +
  `config/audience-default-playbooks.json`) — env → config → built-ins; MCP-тул
  `playbook_suggest` (read-only). Маппинг: `freelance → freelance-project-spec`,
  `exhibition → exhibition-catalog-to-sales-site`, `development/default → development`.
- `docs/playbooks.md` — обзор реестра/жизненного цикла/добавления плейбука.

---

## Остаточные разрывы и их закрытие (sub-issue #1573)

### Разрыв 1 — авто-предложение на старте dev-задачи (слайс C, ядро)

`playbook_suggest` — **read-only подсказка**, её должен явно вызвать агент. Ничто
**автоматически** не подсовывает плейбук агенту на старте dev-задачи в основном
боте. Владелец пишет «поставь изменение X» обычным текстом — хочется, чтобы бот
поднял процесс-плейбук, а не разовый промпт.

**План C:**
- В раннере при старте задачи инжектить в контекст/системный промпт подсказку
  аудитории: «доступен плейбук `development`; для крупной правки предложи запустить
  через `ba_development_playbook` → `playbook_run`».
- **Только для dev-подобных задач** (эвристика/классификатор; не для любой задачи).
- Границы: **никогда не авто-запускать** план — `draft→active` остаётся явным шагом
  пользователя.
- Opt-in-safe: плейбук не подключён (нет sibling'а/профильного override) → ничего
  не меняется, работаем как раньше.

### Разрыв 2 — судьба prose-процедур (слайс D)

В `trained-assist-engineering/playbooks/` лежат prose-чеклисты
`{implement-feature,fix-bug,prepare-task,connect-github}.md` (без id/version/
контракта, durable-исполнителем **не** исполняются). Решение: подсказывать их на
старте dev-задачи как «человеческие» процедуры или позже выразить шагами Playbook
v1. Зафиксировать выбор.

### Разрыв 3 — актуализация доков (слайс A)

- ✅ `docs/specs/engineering-playbook-master-plan.md` — обновлён под факт P0–P5
  merged, dev-плейбук в sibling (#1541), `AUDIENCE_DEFAULT_PLAYBOOK` реализован;
  устаревшие «planned» убраны (этот документ).
- ✅ `docs/requirements-log.md` + каталог `src/mcp-skills/tools/00-meta.js` — P5 и
  автовыполнение отражены.
- ✅ `docs/playbooks.md` — уже существует.

### Разрыв 4 — живая проверка (слайсы B/E)

На GCP VM: sibling `trained-assist-engineering` смонтирован →
`playbook_suggest(audience='default')` → `development`, `available:true`;
`ba_development_playbook` → `available:true` для целевого профиля;
`config/audience-default-playbooks.json` доехал деплоем. E2E на живом боте:
«поставь изменение X» → бот сам предлагает `development` → по согласию черновик
(16 items) → активация; при отсутствии sibling'а бот работает как раньше.

---

## Порядок работ (что делать следующим)

1. **A (этот PR)** — актуализировать мастер-план, `requirements-log.md`, каталог
   `00-meta.js`.
2. **C** — авто-предложение плейбука на старте dev-задачи (ядро цели).
3. **D** — зафиксировать судьбу prose-процедур.
4. **B/E** — живая проверка на GCP VM + E2E на боте, запись в #1573.

Порядок: A даёт честную карту; C закрывает главный разрыв (доставка плейбука
агенту); D — мелкая продуктовая фиксация; B/E — приёмка на живом контуре.

---

## Definition of Done (инженерный плейбук целиком)

- Юзер: «поставь изменение X» → бот **сам** подтягивает `development` → draft-план
  с 16 items → явная активация → шаги исполняются **разными** движками по контракту.
- Programmatic-шаги (тесты/PR/CI/merge) исполняются **без модели**, их validation
  записан как evidence.
- Провал шага: recovery по фиксированной таблице; исчерпание → `BLOCKED`/`failed`,
  не цикл.
- Хуки: на границе стадии уходит ровно одно уведомление владельцу (с consent-политикой).
- Финализация `done` — только когда per-criterion validation пройдена.
- Правка плейбука не мутирует уже запущенный план (pin версии).
- Мастер-план и `requirements-log.md` соответствуют коду; E2E на живом боте записан.
- CI зелёный: unit на схему/резолв/валидаторы/authoring, тесты исполнителя
  (лестница/recovery/хуки), отсутствие регресса `task_create`/`ba_development_playbook`.

---

## Связанное

- Epic #1372; sub-issue #1573 (остаточная работа); ТЗ `docs/specs/playbook-executor-p3b-design.md`.
- #1061 — лестницы OpenCode + авто-фолбэк движка (P3c закрывает per-step версию).
- #1201 — Durable Task Orchestrator (foundation #1200).
- #1440 — testkit/conformance; #1465 — audit end-to-end; #1463/#1466 — канарейка.
- `src/gtd-controller.js`, `src/durable-task-store.js`, `src/playbook-executor.js`,
  `src/durable-recovery.js`, `src/playbook-hooks.js`, `src/playbook-validators.js`,
  `src/audience-default-playbook.js`, `contracts/playbook.schema.json`.
- `docs/user-scenarios/engineering/01-development-playbook.md` — пользовательский разбор.
- `docs/playbooks.md` — обзор реестра/жизненного цикла/добавления плейбука.
