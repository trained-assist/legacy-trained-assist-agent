# Core 06 — Платформенные ключи доезжают до инструментов

Issue #1892 (эпик #1885, пункты 2 и 4).

## Зачем

Часть инструментов работает на ключах платформы, а не пользователя: продление входа в HH (`hh_sync_messages`), отправка файлов (`tg_send_file`), публикация сайта (`site_deploy`), расшифровка речи. На проде эти ключи грузятся из GCP Secret Manager и живут только в памяти сервера (объект secrets), в `process.env` их нет. Раньше они доходили до серверов инструментов по случайному наследованию окружения: HH OAuth-клиент не доходил никогда, а внутри `hermes_run` (там было `secrets: {}`) не доходили ключи бота, Cloudflare и Deepgram.

Инвариант: **серверы инструментов получают платформенные ключи из загруженных секретов по явному списку `TOOL_PLATFORM_KEYS` (`src/secrets.js`); движок их не видит; `.mcp.json` на диске их не содержит.**

## Список ключей

Env инструмента — имя, которое читает скилл. Поле загруженных секретов — каноническое
имя по схеме `{SCOPE}_{SERVICE}_{TYPE}` (#2046). Оба поля присутствуют в объекте
secrets, поэтому скиллы, читающие старые имена, продолжают работать.

| Env инструмента | Каноническое поле | Старое имя (alias) |
| --- | --- | --- |
| `AGENT_BOT_TOKEN` | `BOT_TOKEN` | — |
| `DEEPGRAM_API_KEY` | `SYSTEM_DEEPGRAM_API_KEY` | `DEEPGRAM_API_KEY` |
| `CLOUDFLARE_API_TOKEN` | `ADMIN_CLOUDFLARE_API_TOKEN` | `CF_API_TOKEN` |
| `HH_CLIENT_ID` | `SYSTEM_HEADHUNTER_CLIENT_ID` | `HH_CLIENT_ID` |
| `HH_CLIENT_SECRET` | `SYSTEM_HEADHUNTER_CLIENT_SECRET` | `HH_CLIENT_SECRET` |

Правило разрешения: каноническое имя побеждает, старое подставляется как фолбэк.
Хост, чей Secret Manager ещё не мигрирован на канонические имена, работает через
aliases — переименование аддитивное, не жёсткий переключатель.

## Сценарии

| ID | История → ценность | Ожидаемое поведение | Validation | Статус |
| --- | --- | --- | --- | --- |
| TK-01 | У рекрутера истёк вход в HH → переписка продолжает синхронизироваться | Env серверов `trained-skills`/`hh-skills` несёт HH_CLIENT_ID/HH_CLIENT_SECRET, `hh_sync_messages` продлевает токен сам | `tests/unit/platform-keys-to-tools.test.js` (a) | есть |
| TK-02 | Отправка файла, публикация сайта, расшифровка внутри `hermes_run` | `hermes_run` передаёт загруженные секреты; env его серверов инструментов несёт AGENT_BOT_TOKEN/DEEPGRAM_API_KEY/CLOUDFLARE_API_TOKEN | тот же файл (b) и «hermes_run passes the loaded secrets» | есть |
| TK-05 | Secret Manager ещё на старых именах | `loadSecrets()` отдаёт каноническое поле из старого: `ADMIN_CLOUDFLARE_API_TOKEN === CF_API_TOKEN` | `test/token-naming.test.cjs` «canonical name wins; legacy alias is the fallback» | есть |
| TK-03 | Секреты не утекают модели | `.mcp.json` на диске (с мостом и без) не содержит значений; `buildAgentEnv` вырезает HH_CLIENT_SECRET/CF/Deepgram | тот же файл (c), (d) | есть |
| TK-04 | Только нужное | В env инструментов попадает только список выше, не все секреты | тот же файл (b): OPENROUTER_API_KEY отсутствует | есть |

## Ограничения

- Ключи передаются только в изолированном режиме с мостом (bridge): там конфигурация серверов живёт в памяти. Прод работает в этом режиме. Без моста (локальная разработка, изоляция выключена) конфигурация пишется в `.mcp.json`, который читает движок, поэтому ключи туда не кладутся и продление HH-входа там не работает.
- Проверка на проде: у процесса `hh-skills` в `/proc/<pid>/environ` есть имена HH_CLIENT_ID/HH_CLIENT_SECRET, у процесса движка их нет, `grep -c HH_CLIENT <profile>/.mcp.json` = 0.
