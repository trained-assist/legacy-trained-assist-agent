# Durable wait latency — предложение изменения (шаг 4 плана a61bb2c5)

Сценарий: `docs/user-scenarios/core/04-durable-wait-latency.md` (DW-01…DW-09, V3 —
реквест владельца, requirements-log [202], голос 29.09 «5 минут ждать — это хрень»).
Контракт ожиданий: `docs/specs/durable-wait-until.md`. Follow-up CI-webhook: issue #1846.

## 1. Proposal

**Зачем.** Механизм ожиданий работает, но тайминг пробуждения = глобальный GTD-тик
(первый через 2 мин, дальше `setInterval 5*60*1000`, `src/server.js:268-269`).
`poll_every_sec` клампится от `MIN_POLL_SEC = 60` (`src/durable-wait.js:29`) и
фактически игнорируется (опрос раз в 5 мин), `task_item_wake` не будит никого
(отдельный MCP-процесс, `kickDurable()` из него не позвать), появление кредов
тоже ждёт тик. Пользователь видит «зависший» план.

**Что меняется.**
- отдельный лёгкий тик ожиданий ~30 с (детерминированные валидаторы, без LLM,
  без чек-листов и кронов);
- `MIN_POLL_SEC` 60 → 30 (и в схеме компилятора, и в описании MCP-тула, и в спеке);
- будильник: `task_item_wake` и запись кредова через credential-store будят
  durable-исполнитель сразу (`POST /internal/durable/kick` → `kickDurable()`);
- CI-событие — не здесь: вебхуков GitHub нет, DW-06 уже в issue #1846;
- тексты тула и спеки: что настраивает исполнитель и что для CI — `until:{ci_green}`.

**Влияние.**
- Модули: `src/durable-wait.js`, `src/durable-task-store.js`, `src/gtd-controller.js`,
  `src/server.js`, `src/handlers/internal.js`, `src/mcp-skills/tools/101-durable-tasks.js`,
  `src/durable-task-plan.js`,
  `src/credential-store.js`, новый `src/durable-kick.js`; доки + тесты.
- Контракты данных: без миграций — `wait_json` не меняется; `poll_every_sec: 30`
  старый код клампит обратно в 60 (деградация, не поломка).
- Чек-листовый GTD-тик, первый тик 2 мин, слоты #1752, `FIRE_LEASE_MS` — не трогаем.

## 2. Design (наименьшее изменение)

### 2.1 Тик ожиданий (DW-02, DW-03, DW-05, DW-08)

Новый тик — не новый планировщик, а тот же `runDueDurable` с флагом `waitsOnly`:

1. **`src/durable-task-store.js` → `claimNextRunnable(now, {waitsOnly})`** —
   в WHERE добавляется `AND i.wait_json IS NOT NULL
   AND json_extract(i.wait_json, '$.resolved') IS NULL`. Всё остальное
   (позиционный гейт, due-фильтр, статусы) без изменений → один claim = один
   проход, существующая сериализация остаётся якорем DW-08.
2. **`countActiveWaits()`** — счётчик `wait_json IS NOT NULL AND
   json_extract(…,'$.resolved') IS NULL`; при 0 тик выходит без запросов
   (крайний случай сценария: пусто → no-op).
3. **`runDueDurable({ waitsOnly })`** — пробрасывает флаг в claim. Ветки fanout,
   stage-lock, pollDurableWait, fire — как есть: когда ожидание разрешается в
   этом же проходе, шаг «proceed» и запускается сразу (это и есть ускорение).
   Чек-листы сюда не попадают по построению: legacy `gtd/*.json` живут только в
   `_runDueInner` (`gtd-controller.js:1872`), а тик ожиданий зовёт только
   `runDurableSerialized` — значит `tickCount` heartbeat не растёт (DW-03).
4. **`gtd-controller.js` → экспорт `runWaitTick(deps)`** —
   `runDurableSerialized({ …deps, waitsOnly: true, maxFires: durableBudget(freeSlots) })`
   c быстрым выходом по `countActiveWaits()`. Прогон идёт через существующую
   цепочку `_durableChain` (`gtd-controller.js:1826`) → перекрытие с 5-мин тиком
   и kick даёт ровно один claim (DW-08). Heartbeat `runDue` не трогаем.
5. **`src/server.js` → `scheduleGtdController`**: второй `setInterval(runWaitTick, 30_000)`
   (env `DURABLE_WAIT_TICK_MS`, 0 = выкл — выключатель отката), первый запуск
   через 30 с. При регистрации тик записывает `_kickDeps` (сейчас они ставятся
   только в `_runDueInner`, т.е. после первого 2-мин тика) — с 30 с после старта
   работают все будильники.

Почему не проще: вариант «ускорить сам GTD-тик до 30 с» запускает чек-листы и
кроны в 10 раз чаще (нарушает не-цели, риск спама сессий); вариант «второй
процесс» запрещён ловушкой дублей pending-tasks; вариант «свой claim-цикл»
дублирует позиционный гейт и fanout.

### 2.2 Мгновенный будильник (DW-04 + креды)

Новый **`src/durable-kick.js`** (крошечный клиент, работает из любого процесса):

- `notify(reason)` → если процесс сервер зарегистрировал in-process кикчер
  (`useInProcess(fn)` из `server.js`) — зовёт его напрямую; иначе best-effort
  `POST http://localhost:${PORT}/internal/durable/kick` (Bearer `AGENT_RUN_TOKEN || AGENT_SECRET`,
  таймаут ~1.5 с, ошибки молча глотаются — fallback это тик ≤30 с).
- **`src/handlers/internal.js`**: новый маршрут `POST /internal/durable/kick`
  → `require('../gtd-controller').kickDurable()` (уже экспортируется,
  `gtd-controller.js:2112`; дебаунс 3 с, сериализация — как есть), ответ
  `{ok, armed}`. Существующий `POST /internal/gtd/tick` не трогаем (он полный,
  с чек-листами, — сценарий требует будить именно durable-проход).
- **Вызовы**:
  - `task_item_wake` (`101-durable-tasks.js:331`): после `wakeItem` →
    `durableKick.notify('wake')` — будильник из отдельного MCP-процесса (DW-04);
  - `credential-store.writeCredentialFile` (единственный чокпоинт записи кредов,
    см. шапку модуля «at every credential read/write» — серверные формы, OAuth,
    MCP-тулы `nalog/getcourse/tilda/sites/…` идут через него) →
    `durableKick.notify('credential')`. В сервере — прямой кик, в MCP — HTTP.
    Шум от лишних киков нулевой: дебаунс 3 с + пустой claim = no-op;
    kill-switch `DURABLE_KICK=0`.

Почему не проще: будить из `wakeItem`/storage нельзя напрямую (MCP-процесс —
свежий процесс на каждый вызов, `mcp-action.js:124`); хук по каждому из ~10
MCP-тулов, пишущих креды, — точечные фиксы «у кого руки дойдут», чокпоинт
`credential-store` закрывает класс.

### 2.3 Тексты для исполнителя (DW-07)

- `101-durable-tasks.js` `task_item_wait`: «default 300, **min 30**»; явно:
  «`poll_every_sec`/`timeout_sec`/`sleep_sec` задаёшь ты; опрос идёт каждые
  ~30 с; **для CI — `until:{ci_green}`, не `sleep_sec`**».
- `docs/specs/durable-wait-until.md`: секция «Что настраивает исполнитель» —
  пол опроса 30 с, отдельный тик, правило ci_green-vs-sleep.
- `src/durable-task-plan.js:22,44`: `minimum: 60` → `minimum: 30` (компилятор
  плейбуков, тот же общий контракт).

## 3. Spec delta (docs/user-scenarios)

- **Меняется:** `core/04-durable-wait-latency.md` — статусы DW-02/03/04/05/07/08
  «новое → реализовано» по мере срезов (в конце — колонка «подтверждено» с
  ссылкой на тест/смоук).
- **Добавляется:** ничего нового — сценарий создан на шаге 1.
- **Удаляется:** ничего.
- Живые сценарии `core/01-03` не затронуты; после приёмки 04 архивируется
  штатным порядком.

## 4. Срезы (порядок, каждый со своим тестом)

| # | Срез | Файлы | Тест (исполняемый) |
| --- | --- | --- | --- |
| S1 | `MIN_POLL_SEC` 60→30 + контракт | `durable-wait.js`, `durable-task-plan.js`, описания MCP | в `test/durable-wait.test.cjs`: `poll_every_sec:30` принимается, `nextDueAt ≤ now+30s`; старые кламп-тесты на 60 зелёные |
| S2 | `waitsOnly`-claim + счётчик | `durable-task-store.js`, `gtd-controller.js` | новый `test/durable-wait-tick.test.cjs`: due-шаг **без** wait не клеймится при waitsOnly; активный wait клеймится; счётчик 0 → выход без claim |
| S3 | тик ожиданий в сервере | `gtd-controller.js` (`runWaitTick`), `server.js` | юнит: прогон тика разрешает due wait и запускает шаг; не-wait item не тронут; два параллельных прогона → один claim (DW-08); `tickHeartbeat().tickCount` не растёт (DW-03) |
| S4 | будильник wake + креды | новый `durable-kick.js`, `internal.js`, `101-durable-tasks.js`, `credential-store.js`, `server.js` | юнит с мок fetch: wake → вызван kick; маршрут `/internal/durable/kick` зовёт `kickDurable`; запись креда → notify; сервер недоступен → без исключения |
| S5 | доки | `101-durable-tasks.js` (текст), `docs/specs/durable-wait-until.md`, сценарий 04 | grep-проверка строк `poll_every_sec`/`min 30`/`ci_green` в тул-описании и спеке |
| S6 | прод-смоук (приёмка) | — | ждущий шаг `until:{file_exists}`, `poll_every_sec:30` → сигнал пробуждения в журнале **<60 с**; wake по `task_item_wake` → продолжение **<5 с** (плюс обычный регресс всего durable-набора) |

S1→S4 независимо коммитятся в ветку `eng/trained-assist-product-owner-plan-a61bb2c5`;
PR открывается после S1–S5. Всё в одном PR (одна тема, общая кнопка отката).

## 5. План проверки (DW → уровень)

| DW | Проверка | Уровень |
| --- | --- | --- |
| DW-01 | регресс `test/durable-wait.test.cjs` (инварианты waiting/попытки/гейт) | S1 |
| DW-02 | юнит фейковое время: `due_at ≤ now+30s`, кламп 30 (S1) | S1 |
| DW-03 | юнит: wait-тик не трогает legacy `gtd/*.json`, `tickCount` статичен (S3) | S2 |
| DW-04 | юнит: wake → kick вызван (S4); e2e `wake → claim < 5 с` (существующий драйв `POST /internal/gtd/tick` + новый kick-роут) | S3 |
| DW-05 | прод-смоук S6: `file_exists`, `poll 30` → пробуждение <60 с | S4 |
| DW-06 | follow-up уже открыт: **issue #1846** (вебхуков нет — подтверждено на шаге 2) | — |
| DW-07 | grep-проверка текстов (S5) | S1 |
| DW-08 | юнит перекрытия: два прохода → один claim (S3) | S2 |
| DW-09 | регресс `test/durable-wait.test.cjs` (рестарт/`final` fail) | S1 |

Уровни: S0 статический (node -c), S1 юнит, S2 интеграция store×controller,
S3 e2e-харнесс, S4 прод-смоук. Цель изменения — S3 на каждом PR-тесте,
S4 = критерий приёмки задачи владельца («<1 мин на проде»).

## 6. Риски и откат

| Риск | Что плохого | Митигация |
| --- | --- | --- |
| Второй интервал конкурирует с GTD-тиком | двойной claim шага | оба прогона через `_durableChain` (уже есть); тест перекрытия DW-08 |
| `json_extract` в claim-SQL | если JSON1 выключен — claim падает | better-sqlite3 собирает JSON1 по умолчанию; тест S2 падает громко в CI, не на проде |
| Wake/креды без ответа сервера | будильник молчит | fallback = тик 30 с (≤60 с — укладывается в DW-05) |
| 30-с опрос `ci_green` | rate limit GitHub (~120 req/ч при лимите 5000/ч) | названо вслух; при росте ждущих — общий интервал/backoff (отдельно) |
| Лишние kики от записи кредов | шум CPU | дебаунс 3 с, пустой claim = no-op, `DURABLE_KICK=0` |
| Старый код читает `poll_every_sec:30` | после отката релиза | `nextDueAt` клампит в 60 — деградация, не поломка |

**Откат.** Миграции данных нет. Откат релиза = перевести symlink на прошлый
релиз + рестарт (штатная процедура). Точечный выключатель без отката:
`DURABLE_WAIT_TICK_MS=0` (тик выкл, всё остаётся на 5-мин GTD-тике как сейчас),
`DURABLE_KICK=0` (будильники выкл). Полный revert PR безопасен в любой момент:
`wait_json` формат не менялся.

## Как запускается и как проверяется (для исполнителя)

- Тесты: `node --test test/durable-wait.test.cjs test/durable-wait-tick.test.cjs`
  (и полный прогон `npm test` перед PR). Заметь: тесты с подменой HOME обязаны
  подменять `AGENT_DATA_DIR` + `USERS_DIR`; полный `src/server.js` локально не
  поднимать — проверять модули через `node -e`.
- Локально тик без сервера: `node -e 'const g=require("./src/gtd-controller"); …'`
  с инжектированными deps (как делает юнит S3).
- Прод-смоук после деплоя: создать план с programmatic-шагом
  `wait:{poll_every_sec:30}` + `until:{file_exists}`, создать файл, в журнале
  `journalctl -u assist-agent | grep gtd-durable` — пробуждение <60 с;
  отдельно `task_item_wake` — продолжение <5 с.
