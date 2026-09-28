# Recruiting Web Hub + Programmatic Playbook Launch — UX spec

Status: **approved for implementation (v1 = minimal hub)**
Related: epic #1733 (extract to domain repo + relational DB), #1648 (domain repo pattern),
#1470 (HH extraction), #1729 (visibility of background work), #1726 (run contract).

---

## 1. Цель и принципы

Рекрутер должен **полностью работать в вебе**: видеть драфты вакансий, вакансии, ATS-воронку,
кандидатов — и запускать процессы кнопкой. Бот/агент остаётся NL-интерфейсом для тонких
нюансов («где поправить», «почему не так»), а не для рутины.

Принципы v1:

1. **Существующий работающий UI не перестраиваем.** Холодный поиск (`/hh/proactive`) и все
   текущие ссылки бота — **immutable**: URL не меняются, страница не редактируется, кроме
   добавления общего нав-бара инъекцией.
2. **Только добавление.** Новые разделы = новые маршруты; существующие маршруты и query-параметры
   (`username`, `token`, `vacancy_id`, `list`) не трогаем.
3. **Программный запуск.** Кнопка «Собрать» создаёт и активирует durable-plan **без
   engine-сессии** (`playbook_run` через `runMcpTool`) — мгновенный HTTP-отклик, никакого
   ожидания LLM на старте.
4. **Вся логика — в `trained-assist-hh-skill`.** Core (`server.js`) остаётся роутером,
   пробрасывающим ctx. Это ровно то состояние, из которого переезд в рекрутинг-репо (#1733)
   будет механическим (см. §6).
5. **Недоступность на время деплоя — допустима.** Никакой dual-write/совместимости версий на v1.

## 2. Information architecture (v1)

Общий нав-бар (инъекция во все `/hh/*` страницы):

```
Вакансии · Кандидаты · Холодный поиск · ATS воронка · Стиль · Синхронизация
```

- Ссылки относительные, `username`/`token` протягиваются из query страницы (как уже делает
  vacancy-tabs нав на review: `hh-review-page-html.js`).
- Active-state по `pathname`. Инъекция — минимальный HTML+CSS блок после `<body>`/перед `<h1>`,
  без изменения остальной разметки и JS страницы.
- Маппинг: Вакансии → `/hh/vacancies` (new), Кандидаты → `/hh/review`, Холодный поиск →
  `/hh/proactive` (**URL как сегодня**), ATS воронка → `/hh/ats-editor`, Стиль → `/hh/style`,
  Синхронизация → `/hh/sync-log`.

### 2.1 Экран «Вакансии» — `GET /hh/vacancies?username&token` (NEW)

Источники данных (уже есть, FS, читает hh-skill):

| Что | Откуда |
|---|---|
| Отслеживаемые вакансии (табы HH) | `~/users/<u>/contexts/hh/active_vacancies.json` (`hh-utils.js`) |
| Текущий драфт (state machine) | `~/users/<u>/contexts/hh/vacancy_draft.json` (`hh-vacancy.js`: `collecting` → `draft_ready` → …) |
| Опубликованные лендинги | `~/users/<u>/vacancy-drafts/*.html` |
| Кэш откликов/скоринга | `$AGENT_DATA_DIR/hh/<u>/…` |

Содержимое:

- Список карточек: название, статус (`черновик собирается` / `черновик готов` / `отслеживается HH`),
  счётчик откликов (из кэша), дата последнего скоринга.
- Действия:
  - **Открыть воронку** → `/hh/review?vacancy_id=…` (существующий маршрут);
  - **Холодный поиск** → `/hh/proactive?vacancy_id=…` (существующий маршрут, не меняется);
  - **▶ Собрать** — активна при `draft_ready` (иначе disabled + подсказка «доскажи драфт боту,
    команда `/new_job_post`»);
  - **Создать вакансию** → подсказка `/new_job_post` в телеграме (v1; собственный intake — v2).
- stretch (если выходит в этом PR): форма редактирования полей драфта →
  `POST /hh/vacancy-draft-update` → `runMcpTool('hh_vacancy_update_draft')`. Не вышло — кнопка
  «Изменить» отправляет в телеграм-сессию.

### 2.2 Экран статуса процесса — `GET /hh/plan?username&token&task_id` (NEW)

- Рендерит: goal, `{playbook_id, playbook_version}`, список шагов со статусами, «что выполняется
  сейчас» (семантика #1729), время старта.
- Данные: `runMcpTool('task_get' | 'task_list')` (`src/mcp-skills/tools/101-durable-tasks.js:184,201`).
- Поллинг: каждые 3–5 с первые 60 с, дальше 15–30 с; остановка при `done/failed`.

## 3. Флоу «Собрать» (кнопка запуска)

```
[Вакансии] ▶ Собрать
   │  модалка: цель (заголовок вакансии), чек-лист готовности
   │  (HH токен ✓ / вакансия ✓ / ATS конфиг — info, не блокирует),
   │  выбор плейбука (v1: один — recruiting-vacancy-launch)
   ▼
POST /hh/playbook-run   { username, token, playbook_id, goal, vars }
   │  auth: HMAC token — тот же, что у /hh/response-state (proactiveHmac)
   │  hostRunMcpTool({ tool:'playbook_run',
   │                   params:{ playbook_id, goal, activate:true, vars } })
   │      → compile → task_create → status=active   (без engine-сессии)
   │  Telegram: sendMessage в чат профиля (`.chatid`):
   │      «Процесс «<goal>» запущен. Статус: https://…/hh/plan?task_id=…»
   ▼
{ task_id, status_url }  →  редирект на /hh/plan?task_id=…
```

- Отклик HTTP — мгновенный (compile + 2 записи в SQLite, спавн MCP-чилда ~1–2 с).
- Параллельно — телеграм-уведомление с https-ссылкой. **t.me deep-links не нужны** (v1);
  «откроется в вебе или в телеграме» решаем позже — сейчас делаем оба канала:
  веб-страница статуса + пуш в чат.
- Отказ (плейбука нет, токен неверный, HH не подключён) → JSON error → тост на странице.

## 4. Первый плейбук `recruiting-vacancy-launch`

Лежит в `trained-assist-hh-skill/playbooks/recruiting-vacancy-launch.json` — sibling-ресолв уже
поддерживается (`playbook-store.js` DEFAULT_SIBLING_REPOS). Черновик шагов (точный состав
уточняется при авторстве по `contracts/playbook.schema.json`, валидация обязательна):

| # | kind | Шаг | Validation |
|---|------|-----|-----------|
| 1 | programmatic | Проверить вводные: HH токен, выбранная вакансия, draft state | deterministic |
| 2 | agent | Опубликовать лендинг вакансии, если нет `landing_url` (`hh_vacancy_publish_page`) | `landing_url` есть |
| 3 | agent | Синхронизировать отклики + прогнать скоринг воронки | свежий `last-scoring` |
| 4 | notify-hook | Итого со ссылками: лендинг, воронка, холодный поиск, статус | hooks_approved |

- `goal`-шаблон: `Запустить подбор по вакансии «{vacancy_title}»`, vars: `vacancy_id`, `title`.
- Hook-согласие: endpoint передаёт `approve_hooks: true` — пользователь нажал кнопку, это и есть
  consent (по контракту playbook_run: «pressed an action button» = активация).
- При отсутствии/падении шага — план переходит в failed, пользователь видит это на `/hh/plan`
  и в уведомлении (#1729).

## 5. Настройки (параметры сайта) — v2, обозначить, не строить

Раздел «Настройки» в навигации v1 не входит. На v2: домен публикации лендингов, HH-аккаунт,
канал уведомлений — как per-profile строки конфига (см. §6). Если юзер не настроил — разделы
отвечают «не настроено» + кнопка подключения; ничего не деградирует для остальных.

## 6. Вынос в рекрутинг-репо (#1733) — как это будет устроено

Это архитектурный контракт, ради которого v1 пишется «уже правильно»:

1. **Рекрутинг-репо владеет данными и контрактами**: SQL-схема (версионированные миграции),
   HTTP-роуты (`/hh/*`, `/vacancy/*`, `/apply/*`), шаблоны страниц, MCP-тулы домена,
   плейбуки домена. Core про схему не знает ничего — только sibling-lib (#1648,
   `docs/how-to-move-a-tool-to-a-domain-repo.md`).
2. **Схема разворачивается при деплое репо**: миграции прогоняются для всех существующих
   профилей (per-profile `schema_version`); новый юзер получает сразу последнюю схему.
   Правка схемы в рекрутинг-репо → PR → деплой → «хоп, и у новых юзеров новая структура вакансии».
3. **Акцепт скила у юзера = provisioning строк конфига** (домен, HH, уведомления). «Пользователь
   настроил» — есть строки; «не настроил» — их нет, сервис отвечает «не настроено». Отдельного
   состояния «развёрнуто/не развёрнуто» не нужно — схема есть всегда, конфиг опционален.
4. **Переезд v1-кода — механический**: `hh-routes.js` + `hh-*-html.js` + `playbooks/` уже в
   hh-skill; core добавит только роутерский монтаж (есть) и ctx-аксессоры (минимально).
   FS-данные → DB — это отдельный шаг #1733 (relational DB вместо `vacancy-drafts/` и
   `contexts/hh/*.json`), **не** в v1.

## 7. Quick wins (входят в v1)

- **nginx whitelist** (`infra/nginx/recruiter-assistant.conf:73`): добавить
  `vacancies|plan|playbook-run` и добрать `ats-editor|style|sync-log` — сейчас отдают 401 на
  домене (работают только через `136-65-7-197.sslip.io/agent/…`). Существующие location не трогать.
- **Host новых ссылок**: mint'им на том же host, что `/hh/review`
  (`HH_COLD_SEARCH_PUBLIC_URL` → `recruiter-assistant.ru`). Существующие ссылки не переписывать.

## 8. Out of scope (v2)

- Relational DB и переезд в рекрутинг-репо — epic #1733.
- Apex `recruiter-assistant.ru` → `/web/` (302 → 401) — отдельная задача.
- Полноценный редактор драфта (форма) — stretch v1, иначе deep-link в телеграм.
- Раздел «Настройки» / параметры сайта / custom domain (§5).
- Выбор «веб или телеграм» как основного канала статуса, t.me deep-links.

## 9. Проверка (acceptance)

1. `GET /hh/proactive` — 200, разметка и ссылки страницы **побайтно прежние** (кроме нав-бара).
2. Все страницы `/hh/*` показывают нав-бар; каждая ссылка ведёт на существующий маршрут.
3. `GET /hh/vacancies` — список из `active_vacancies.json` + `vacancy_draft.json`.
4. `POST /hh/playbook-run` с валидным HMAC → план `active` в durable-store
   (проверка `task_get`), телеграм-уведомление доставлено.
5. `GET /hh/plan?task_id=…` рендерит шаги и поллится.
6. Whitelist: `curl https://recruiter-assistant.ru/hh/{vacancies,plan,ats-editor}` ≠ 401.
7. `npm run check` + тесты обоих репозиториев зелёные; CI green.
