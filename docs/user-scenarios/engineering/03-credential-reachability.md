# Engineering — ключи доходят до потребителя и не теряются при миграции

**Домен:** Инженерная платформа (ядро `trained-assist-agent` + доменные скилы)
**Issue:** #1891 (эпик #1885) · предусловие для переезда профилей в Google Storage (#1789/#1808) и включения шифрования
**Уровень проверки:** S3 — всё проверяется автоматически (CI + тесткит), человек в контуре не нужен
**Песочница:** `npm run sandbox:cred-reachability` (`scripts/sandbox/credential-reachability.mjs`, C1–C11)

## Зачем

Ключ может быть объявлен (секреты сервера, токен-файл профиля) и всё равно не дойти до скила:
env-слои хоста написаны руками и ни с чем не сверялись. Живые примеры: Deepgram
(`DEEPGRAM_KEY` vs `DEEPGRAM_API_KEY`, speech-skill#1), `CF_API_TOKEN` vs `CLOUDFLARE_API_TOKEN`,
`HH_CLIENT_ID/SECRET`, объявленные в мёртвом `config/mcp-provider-env.json` и так и не переданные
hh-скилу, DaData в `USERS_DIR/<u>/.inn-config.json`.

## Из чего состоит

| Часть | Где |
|---|---|
| Реестр потребителей: кто какой ключ читает (env-имена, alias-имена, файлы) — только имена | `config/credentials.json`, схема `contracts/credentials.schema.json`, загрузчик `src/credential-registry.js` |
| CI-контракт «заявлено ⊆ предоставлено» + запрет `os.homedir()` для токен-путей | `scripts/check-credential-reachability.js`, шаг в `.github/workflows/ci.yml` |
| Env MCP-скилов как чистая функция (проверяется реальный объект, не grep) | `buildMcpToolEnv` в `src/browser.js` |
| Инвариант миграции «было доступно → доступно» | фаза `credentials-reachability` в `scripts/profile-migrate/` |
| Проверка реестра у доменного скила | `checkCredentials` в `packages/mcp-skill-testkit` (конформ) |
| Манифест бота/секрета не может обещать имя, которое никто не возит | `scripts/check-env-sync.js`: `infra/env-manifest.json → gcp_secret_manager_only ⊆ src/secrets.js` (`REQUIRED`/`OPTIONAL`) и ⊆ загрузчик реестра ботов |
| Предпродажный гард: красный контракт кредов не выпускает релиз в прод | `scripts/check-deploy-secrets-gate.js`, вызов из `scripts/deploy.sh` до переключения `~/agent-master` |

Формат записи реестра:

```json
{ "consumer": "speech-skill:deepgram", "scope": "profile", "host": "bridge",
  "env": ["SYSTEM_DEEPGRAM_API_KEY"], "aliases": ["DEEPGRAM_API_KEY", "DEEPGRAM_KEY"],
  "files": ["deepgram/key.txt"], "filesRoot": "tokens" }
```

`env[]` — каноническое имя по схеме `{SCOPE}_{SERVICE}_{TYPE}` (#2046):
`ADMIN_` — админский токен хоста, `SYSTEM_` — серверный ключ, `USER_` — ключ
профиля. `aliases` — старые имена, которые потребитель ещё принимает; хост их
давать не обязан. Правило разрешения: каноническое побеждает, alias — фолбэк.

- `scope`: `platform` — env хоста (одинаков для всех профилей); `profile` — токен-файл профиля (env — запасной путь).
- `host`: какой слой обязан дать `env[]`: `mcp` — `buildMcpToolEnv`, `bridge` — `engineEnv`, который мост MCP пробрасывает скилам.
- `aliases`: старые имена, которые потребитель ещё принимает; хост их давать не обязан.
- `files`: относительно `filesRoot/<профиль>/`; `tokens` = `AGENT_TOKENS_DIR`, `profile` = `USERS_DIR`. Без `..` и абсолютных путей.

## Сценарии

### US-CRED-01 Заявлено → предоставлено
Скил объявляет env-имя в реестре. `node scripts/check-credential-reachability.js` зелёный, если
имя есть в реальном env слоя `host`; иначе exit 1 и имя нарушителя в выводе.
Проверка: песочница C1–C4; `test/credential-reachability.test.cjs`.

### US-CRED-02 Регресс-ловушка
Кто-то убирает передачу заявленного имени или строит путь к токенам через `os.homedir()` —
тот же скрипт красный (файл:строка), PR не мержится. Токен-пути — только через `src/data-paths.js`
(`tokenPath` / `tokensRoot` / `userTokensDir`, учитывают `AGENT_TOKENS_DIR`).
Проверка: песочница C5.

### US-CRED-03 Инвариант миграции
```
node scripts/profile-migrate/cli.mjs credentials-reachability --profile <u> --dry-run [--json]
node scripts/profile-migrate/cli.mjs credentials-reachability --profile <u> --apply    # базовая линия «до» в ledger
node scripts/profile-migrate/cli.mjs credentials-reachability --profile <u> --verify   # после миграции
```
Отчёт: «имя → доступен да/нет → источник» (env-имя или `file:<root>/<путь>`), для файлов — sha256
содержимого. Значения ключей никогда не попадают ни в вывод, ни в ledger. `--apply` ничего не
двигает, только пишет базовую линию; ключ профиля, доступный в базовой линии и недоступный сейчас,
даёт `--verify` exit 2 с его именем. `--verify` без базовой линии — тоже exit 2. Ключи уровня
`platform` показываются, но фазу не валят: миграция профиля env хоста не меняет, а env оператора
между запусками может отличаться.
Проверка: песочница C6.

### US-CRED-04 Переходный период по alias
Хост даёт каноническое имя, потребитель принимает и старое. При `DEEPGRAM_KEY` или `CF_API_TOKEN`
без канонического имени ключ доступен, источник = alias-имя.
Проверка: песочница C7.

Тот же контракт на уровне загрузчика: `loadSecrets()` отдаёт каноническое поле,
даже когда в Secret Manager лежит только старое имя — `ADMIN_CLOUDFLARE_API_TOKEN
=== CF_API_TOKEN`. Это делает переименование безопасным для деплоя.
Проверка: `test/token-naming.test.cjs` (core), `tests/unit/deepgram-rotation.test.js` (speech).

### US-CRED-05 Файл скила
DaData: env нет, `USERS_DIR/<u>/.inn-config.json` есть → доступен. Файл читается через
`credential-store` (зашифрованный без `CRED_ENCRYPTION_KEY` считается недоступным).
Известное расхождение (не чинится молча, записано в реестре): `70-inn-enrichment` читает сначала
`agent-tokens/<u>/inn/config.json`, а `71-dadata`/`72-checko` — сначала env.
Проверка: песочница C8.

### US-CRED-06 Потребитель, включённый хостом (обратное направление)
Односторонняя проверка (объявлено ⊆ предоставлено) по построению слепа к обратному случаю:
хост включил потребителя, а его ключ никто не объявил. Наблюдение после релиза 01.10.2026
нашло именно это — `sales` был `enabled` в `infra/env-manifest.json → bots.registry`, а
`SALES_BOT_TOKEN` не объявлен и не грузился: прод работал, доставка упала бы в 403.
Теперь `scripts/check-credential-reachability.js` идёт по `HOST_REGISTRIES` в обе стороны:
у каждого включённого потребителя `token_secret_name` обязан быть в `config/credentials.json`,
с `host: secrets`, и присутствовать в загрузчике `src/secrets.js` (`REQUIRED`/`OPTIONAL`).
Имя, объявленное слоем `secrets`, но не возимое загрузчиком, — тоже красное.
Проверка: песочница C10.

### US-CRED-07 Красный гард не выпускает релиз в прод
```
node scripts/check-deploy-secrets-gate.js [--release <dir>] [--env gcp|ru]
```
Гард запускает контракт кредов и `check-bot-secrets.js` (значения: Secret Manager, затем host env)
против **целевого** релиза, пока предыдущий ещё обслуживает запросы. `scripts/deploy.sh` зовёт его
сразу после сборки релиза — до переключения `~/agent-master` и рестарта; красный гард = `exit 1`,
прод остаётся на прошлом коммите. Проверка `check-bot-secrets.js` живёт только в гарде, второй раз
в `.github/workflows/ci.yml` её не повторяет (раньше она стояла ПОСЛЕ `deploy.sh` — сломанный
релиз успевал уехать в прод, и только потом пайплайн становился красным).
Проверка: песочница C11.

## Как добавить ключ

1. Запись в `config/credentials.json` своего репозитория (скил) или ядра (core-потребители).
2. Если `host: mcp` — имя должно передаваться в `buildMcpToolEnv`; если `bridge` — в `engineEnv`;
   если `secrets` (токен бота) — имя обязано быть в `src/secrets.js` и в
   `infra/env-manifest.json → bots.registry.<bot>.token_secret_name` (иначе красный `check-env-sync`).
3. `node scripts/check-credential-reachability.js` (ядро) / `mcp-skill-conformance` (скил) — зелёные.

## Роллаут по скилам (отдельные PR)

Каждый доменный скил добавляет свой `config/credentials.json` (тесткит проверяет формат) и
переводит свои токен-пути с `os.homedir()` на свой data-paths: engineering (60-, 61-),
sales (30-, 40-, 70-). Пока в ядре лежат зеркальные записи для регресс-кейсов
(deepgram, dadata, checko, hh, serper).
