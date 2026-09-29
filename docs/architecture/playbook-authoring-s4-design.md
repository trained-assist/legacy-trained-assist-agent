# S4a+S4b: предложение изменения — дизайн, срезы, проверка, откат

Эпик #1851, дефекты D1 (выдуманные проверки в конструкторе) и D2 (профильный плейбук
недостижим из обычной просьбы). Источники: сценарий
`docs/user-scenarios/engineering/02-custom-playbook-authoring.md`, карта
`docs/architecture/playbook-authoring-s4-context.md`, требования
`docs/architecture/playbook-authoring-s4-requirements.md` (R1–R10, C1–C9).
База — #1372 P1. Срезы S4a (D1) и S4b (D2) — один PR.

## 1. Proposal — зачем

- **D1.** `playbook_draft`/`edit` (Hermes, `src/playbook-authoring.js` `AUTHORING_PROMPT`)
  не знает реального списка проверок и пишет в `programmatic`-шаги ключи вне реестра
  (`shell_command_success`, `http_ok_contains_sha`) и `{scenario}` в `goal_template` без
  `inputs[]`. Такой плейбук сохраняется и молча не проходит (в режиме `programmatic` шаг с
  неизвестным ключом никогда не завершится; `{scenario}` остаётся литералом в плане).
- **D2.** Личный плейбук достижим только если юзер помнит id: `playbook_health` для
  `scope:profile` всегда `dispatch: fail` (у профиля нет prompt-domain A1 и нет launcher F).
  Сейчас обход — маршрут, вручную вписанный в правила проекта PO.

Ценность: плейбук, собранный словами, содержит **только реально исполняемые** проверки и
запускается **из обычной просьбы** без знания id. Источник дефектов — живой пример владельца
(комментарий #1851#issuecomment-5883779762).

**Влияние:** `playbook-authoring.js`, `playbook-validators.js`, `playbook-store.js`
(только добавление поля в `list()`), `contracts/playbook.schema.json` (аддитивно),
новый `src/profile-playbook-menu.js`, `src/runner/index.js` (одна инъекция),
`playbook-reachability.js` (новый маршрут). Другие сервисы/данные не трогаются, доступа
и прав не меняем (C9).

## 2. Design — наименьшее изменение

### 2.1 S4a: Hermes получает реестр и каталог; семантические проверки на авторстве

**`src/playbook-validators.js`** — единственный источник правды о ключах:
- `VALIDATOR_NOTES` — карта `key → однострочное RU-описание` (документация рядом с
  `createDefaultRegistry`, строки 621–637).
- `listValidatorCatalog(registry?)` → `[{key, note}]`: **ключи берём из
  `Object.keys(registry || getDefaultRegistry())`** (C3 — динамически, не хардкод), заметки —
  из `VALIDATOR_NOTES` (нет заметки → пустая строка).
- Экспорт `VALIDATOR_NOTES`, `listValidatorCatalog`.

**`src/playbook-store.js`** — точка доступа к каталогу типовых шагов:
- `siblingRepoRoots()` — кандидаты корней сиблингов (`PLAYBOOK_SIBLING_ROOTS` override либо
  `REPO_PARENT/<DEFAULT_SIBLING_REPOS>`); `defaultSiblingRoots()` рефакторится на её основе
  (остаётся фильтр по наличию `playbooks/`).
- `list()` — добавить `when_to_use: pb.when_to_use ?? null` (нужно блоку промпта/health, без
  повторного чтения файлов).

**`src/playbook-authoring.js`**:
- `loadStepTypeCatalog({ siblingRoots })` — читает первый найденный
  `<root>/library/step-types.json` из `siblingRepoRoots()`, возвращает
  `[{id, purpose, execution_kind}]`; файла нет / битый → `[]` (профили без сиблинга, не ошибка).
- `buildValidatorCatalogBlock()` и `buildStepTypeCatalogBlock()` — текстовые блоки для промпта.
- `buildAuthoringPrompt({ validatorCatalog, stepTypes } = {})` =
  `AUTHORING_PROMPT + '\n\n' + блоки`. `callHermes` использует её вместо `AUTHORING_PROMPT`
  (константа `AUTHORING_PROMPT` остаётся экспортом).
- В базовый `AUTHORING_PROMPT` — два новых правила: (11) для `scope: profile` обязателен
  непустой `when_to_use` (1–2 фразы «когда предлагать», язык юзера); (12) `programmatic`-шаг:
  `validation` — **только ключи из списка ниже**, без `instructions` к исполнению (правило
  промпта, на save не отклоняем — C5).
- `assertAuthoringSemantics(playbook, { validatorKeys, requireWhenToUse })`:
  1. каждый ключ `validation` шага `execution_kind:"programmatic"` ∈ `validatorKeys`, иначе
     `PROGRAMMATIC_UNKNOWN_VALIDATOR` (`unknown programmatic validator "<key>" в шаге «<title>»;
     доступны: …`);
  2. `{name}` в `goal_template`, кроме `{input}` (C7), объявлен в `inputs[].name`, иначе
     `GOAL_TEMPLATE_UNDECLARED_VAR` (`{scenario} в goal_template без inputs[]`);
  3. при `requireWhenToUse` непустой `when_to_use`, иначе `WHEN_TO_USE_REQUIRED`.
  **Не трогаем agent-шаги** (C4) и **не кладём правило в `validatePlaybook`** — он зовётся в
  `_load` и сломал бы загрузку уже сохранённых плейбуков (C1).
- `authorAndValidate`: `normalizeDraft → validatePlaybook → assertAuthoringSemantics` внутри
  того же `try` — ошибка уходит в существующий repair-круг (Hermes чинит). Повторный провал →
  `AUTHORING_INVALID` с текстом (мусор на диск не пишется).
- `save()`: те же `validatePlaybook + assertAuthoringSemantics` (без Hermes) — защита от ручной
  правки черновика (R6); при нарушении `ok:false`/код, файл не пишется.
- `summarizePlaybook()` — добавить `when_to_use` (R5, UX).

### 2.2 S4b: `when_to_use` → маршрут из обычной просьбы

**`contracts/playbook.schema.json`** — добавить в `properties` корня (не в `required`)
опциональное `when_to_use: {type:"string", minLength:1}`. `additionalProperties:false` теперь
принимает поле, старые файлы валидны (C2), сиблинги/`.core`-CI читают ту же схему.

**`src/profile-playbook-menu.js`** (новый, по образцу `dev-task-playbook-suggestion.js`):
- `buildProfilePlaybookMenu({ profileId, store, env })` → строка промпта или `''`.
- Берёт `store.list().playbooks`, фильтр `source === 'profile'` и непустой `when_to_use`;
  формат:
  ```
  [ТВОИ ПЛЕЙБУКИ]
  Личные плейбуки профиля. КОГДА просьба совпадает по смыслу со строкой «когда использовать»
  ТОГДА предложи/запусти `playbook_run(playbook_id: "<id>", goal: "<цель>")` — id помнить не нужно.
  - `<id>` — <when_to_use>
  ```
- Лимиты R8: ≤10 плейбуков, `when_to_use` обрезается до ~160 символов, при переполнении —
  `… ещё N — см. playbook_list` (не молча). Kill-switch `PROFILE_PLAYBOOK_MENU=off`.
- Никогда не бросает (try/catch → `''`); пусто у профиля без плейбуков — байт-в-байт промпт.

**`src/runner/index.js`** (инъекция — системный промпт профиля, C6): после блока
`promptDomains.buildDomainBlock` (строка ~2304–2311) под `!internalGtd && user?.username`
дописать menu в тот же `.system-prompt.txt` (как domainBlock). `''` для internalGtd (не
рекурсировать), как `playbookSuggestionSection` (строки 2239–2241). Ошибка не роняет ран.

**`src/playbook-reachability.js`** — новый маршрут **P** (R10). После `pointerHits`
(A1) и перед `weak`:
- `pb.source === 'profile'` и непустой `pb.when_to_use` → `dispatch: pass`
  (`P профильный блок промпта: when_to_use «…»`);
- профильный без `when_to_use` → `dispatch: fail` с подсказкой «заполни when_to_use».
Проверка `playbook_health` (тул) код не меняет — читает тот же `checkPlaybookReachability`.

**Почему не проще.** (а) «Только запретить в промпте, без проверки» — именно так
`shell_command_success` просочился в сохранённый черновик (D1). (б) Положить проверки в
`validatePlaybook` — сломает `_load` у всех (C1). (в) `{var}`-литерал молча ломает план —
предупреждения мало. (г) Хранить `when_to_use` вне схемы нельзя: нужен и промпту, и health;
добавление опционального поля безопасно, удаление/переименование было бы 🔴.

## 3. Spec delta (`docs/user-scenarios`)

- **Добавляется:** 0 файлов.
- **Меняется:** 0 файлов. Сценарий `engineering/02-custom-playbook-authoring.md` уже написан
  (шаг 1 плана) и является **приёмочной спецификацией** этого изменения; правок в него этот
  шаг не вносит.
- **Удаляется:** 0.
- Уточнение для протокола (не edit сценария): маршрут **P проходит и в `--strict`** (это
  прямой чат-маршрут профильного плейбука, не «weak»); `when_to_use` обязателен на **любом**
  save профильного плейбука (кросс-чтение остаётся без ограничений, C2).

## 4. Срезы реализации (маленькие, каждый со своим тестом; порядок — сверху вниз)

**Slice 1 — реестр и каталог в промпт Hermes (S4a).**
Файлы: `src/playbook-validators.js` (`VALIDATOR_NOTES`, `listValidatorCatalog`),
`src/playbook-store.js` (`siblingRepoRoots`), `src/playbook-authoring.js`
(`loadStepTypeCatalog`, `buildValidatorCatalogBlock`, `buildStepTypeCatalogBlock`,
`buildAuthoringPrompt`, вызов в `callHermes`, правила 11–12).
Тест: `tests/unit/playbook-authoring.test.js` — `buildAuthoringPrompt()` в промпте содержит
все ключи `createDefaultRegistry()` и id из фикстурного `library/step-types.json`; без
сиблинга промпт всё ещё валиден (блок каталога пуст). Проверка: захват `runHermes.calls[0].task`.

**Slice 2 — схема `when_to_use` + семантическая проверка на draft/edit/save (S4a).**
Файлы: `contracts/playbook.schema.json`, `src/playbook-authoring.js`
(`assertAuthoringSemantics`, встройка в `authorAndValidate`/`save`, `summarizePlaybook`).
Тесты (`tests/unit/playbook-authoring.test.js`):
- programmatic-шаг с `shell_command_success` → repair; повторно невалиден → `AUTHORING_INVALID`
  и файл не пишется;
- `goal_template` `{scenario}` без `inputs[]` → нарушение; с `inputs:[{name:'scenario'}]` → ок;
- programmatic-шаг только с ключами реестра → ок; agent-шаг с произвольным ключом → ок (C4);
- `{input}` без `inputs[]` → ок (C7);
- save черновика без `when_to_use` → `WHEN_TO_USE_REQUIRED`, профильный файл не создан.
**Обновление устаревшей фикстуры** (см. §7): `validPlaybook()` получает дефолтный
`when_to_use`, иначе существующие draft/save-тесты теперь справедливо репарятся.

**Slice 3 — `list()` + сборщик блока меню (S4b).**
Файлы: `src/playbook-store.js` (list `when_to_use`), новый `src/profile-playbook-menu.js`.
Тест: новый `tests/unit/profile-playbook-menu.test.js` — 0 профильных → `''`; один с
`when_to_use` → строка содержит id и текст; >10 → `ещё N`; текст режется до 160; kill-switch;
системный плейбук без `when_to_use` не попадает.

**Slice 4 — инъекция в системный промпт профиля (S4b).**
Файл: `src/runner/index.js`. Тест: `tests/unit/runner-system-prompt.test.js` (или рядом) —
на профиле с плейбуком `when_to_use` в собранном `.system-prompt.txt` есть блок `[ТВОИ ПЛЕЙБУКИ]`;
при `internalGtd` и без плейбуков блок отсутствует; домен-блок не ломается.

**Slice 5 — маршрут P в reachability (S4b).**
Файл: `src/playbook-reachability.js`. Тест: `tests/unit/playbook-reachability.test.js` +
`tests/unit/playbook-health-tool.test.js` — профильный плейбук с `when_to_use` → `dispatch: pass`
(и в `strict`); без → `fail` с подсказкой; системный/A1 не затронуты.

Зависимости: Slice 2 требует Slice 1 (источник ключей). Slice 4 требует Slice 3. Slice 5
независим от 3–4.

## 5. План проверки (каждый Шаг сценария → автотест / песочница; целевой уровень S)

Шкала (локальная для этого среза, в репозитории канонической нет — задаём явно):
**S1** юнит на чистой функции с инъекцией; **S2** интеграция (реальные модули + временный FS +
фейковый LLM); **S3** модульный E2E через handler MCP-тула на временном профиле;
**S4** живой бот в staging; **S5** прод-регресс.

| Шаг сценария | Проверка | Уровень |
|---|---|---|
| 1 (draft видит реестр+каталог) | Slice 1 тест — состав промпта | **S2** |
| 2 (unknown programmatic key → repair) | Slice 2 тест (фейк Hermes) | **S2** |
| 3 (`{var}` без `inputs[]` → repair) | Slice 2 тест | **S2** |
| 4 (`when_to_use` пусто → repair) | Slice 2 тест | **S2** |
| 5 (сводка показывает «когда использовать») | Slice 2: `summarizePlaybook().when_to_use` | **S2** |
| 6 (save повторяет проверки, файл не пишется) | Slice 2 тест + существующий save-тест | **S2** |
| 7 (edit — тот же промпт/проверки) | Slice 1/2 тесты на `edit` | **S2** |
| 8 (блок «твои плейбуки» в промпте) | Slice 3/4 тесты | **S2/S3** |
| 9 (просьба → агент предлагает плейбук) | приёмка на живом боте | **S4** |
| 10 (health: with when_to_use → dispatch pass) | Slice 5 + `playbook-health-tool.test.js` | **S2/S3** |

Приёмка (ручная, S4, на staging): `playbook_draft` по «проверить фичу на проде» → в черновике
все programmatic-ключи из реестра, `when_to_use` заполнен; `playbook_health prod-feature-check`
после заполнения `when_to_use` → `dispatch: pass`.

## 6. Риски и откат

- **R2/R3 строгость на авторстве.** Ложный отказ возможен только для `programmatic`-шагов при
  авторстве; `_load`/чтение/запуск сохранённых не затронуты (C1/C2). Откат — revert коммита;
  миграции данных нет.
- **R4 схема.** Добавление опционального поля; сиблинги читают ту же схему. Убрать поле нельзя
  без миграции — поэтому только добавляем.
- **R8 рост промпта.** Жёсткий лимит 10 × ~160 симв. + «ещё N» + kill-switch
  `PROFILE_PLAYBOOK_MENU=off` (немедленный откат без деплоя кода — снять флаг). Не для internalGtd.
- **Уже сохранённые профильные плейбуки без `when_to_use`** читаются/запускаются как раньше,
  в промпт не попадают, health подсказывает заполнить (C2). Новый save требует поле — цена один
  repair-круг (решение требований, строки 61–63).
- **`playbook_list` фиксированной формы** не имеет (проверено) — добавление `when_to_use`
  аддитивно.
- **Откат целиком:** revert ветки/PR (изменения аддитивны, схемная миграция не нужна) либо
  kill-switch для блока промпта; удаление данных не требуется.

## 7. Отдельно: устаревшие тесты в этом же PR

Правило staging: устаревший конкретный тест можно заменить в том же PR с указанием
путь/название, причина, изменившееся требование, заменяющий тест.

- **`tests/unit/playbook-authoring.test.js` → `validPlaybook()`**: добавить дефолт
  `when_to_use: 'когда нужно …'`. Причина: требование R4 — непустой `when_to_use` обязателен для
  `scope: profile`, иначе draft/edit справедливо уходят в repair, а save — `WHEN_TO_USE_REQUIRED`.
  Заменяющий/дополняющий тест: новые кейсы Slice 2 (unknown validator, undeclared goal var,
  when_to_use required, agent-step free keys, `{input}` allowed).
- **`tests/unit/playbook-health-tool.test.js` → `profilePlaybook()`**: фикстуру оставить без
  `when_to_use` для кейса «no route → fail» (ожидание верно) и добавить новый кейс «with
  when_to_use → dispatch pass». Удалений не требуется.

## Итог

Всё укладывается в R1–R10/C1–C9; 🔴/⚫ нет, подтверждения пользователя не требуется. Наименьшее
изменение: пять срезов, каждый с автотестом, без миграции данных, с откатом через revert или
kill-switch.
