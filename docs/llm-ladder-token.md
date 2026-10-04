# Где взять LLM_LADDER_TOKEN

Страница отвечает на один вопрос: **где лежит токен общей LLM-лестницы и как
выдать его процессу, который хочет ходить в лестницу.** Токен нужен не только
агенту — его же просят `trained-assist-communication-skills` (корпус вживую),
`trained-assist-llm-ladder-apps` и любой sidecar.

## Три источника, в порядке приоритета

`src/service-llm.js` → `_ladderToken()` — единственное место, где токен
разрешается. Ничего больше его не читает.

| # | Источник | Где живёт | Кто использует |
|---|---|---|---|
| 1 | `process.env.LLM_LADDER_TOKEN` | env процесса; в проде — подставляется systemd из Secret Manager | сервис агента |
| 2 | `$AGENT_TOKENS_DIR/llm-ladder/token` | `~/agent-tokens/llm-ladder/token`, `mode 0600` | локальные запуски, sidecar'ы |
| 3 | GCP Secret Manager `LLM_LADDER_TOKEN` | проект `alesa-personal-assistent` | прод-ВМ, откуда systemd берёт env |

`AGENT_TOKENS_DIR` разрешается как `AGENT_TOKENS_DIR` || `AGENT_TOKENS_ROOT` ||
`~/agent-tokens` (`src/data-paths.js`). Имя `AGENT_TOKENS_ROOT` — историческое,
поддерживается для старых systemd-юнитов; **новые** должны ставить `AGENT_TOKENS_DIR`.

Файл читается через `readCredentialFile` (`src/credential-store.js`), поэтому может
быть как plaintext, так и конвертом AES-256-GCM. Конверт требует
`CRED_ENCRYPTION_KEY` — без него зашифрованный файл читается с loud-ошибкой, а не
как мусор. Проверить, какой формат у файла: зашифрованный имеет sidecar
`<file>.meta`.

## Как выдать токен локально

```bash
export LLM_LADDER_URL=https://llm-ladder.trainedassist.store
export LLM_LADDER_TOKEN="$(cat ~/agent-tokens/llm-ladder/token)"
```

Для sidecar'а, который умеет только файловый токен, копировать секрет в его
окружение не нужно — достаточно указать путь:

```bash
LLM_LADDER_TOKEN=... AGENT_TOKENS_DIR=~/agent-tokens node script.mjs
```

## Проверка, что токен живой

```bash
curl -s https://llm-ladder.trainedassist.store/health          # 200 БЕЗ токена
curl -s -X POST https://llm-ladder.trainedassist.store/v1/chat/completions \
  -H "Authorization: Bearer $LLM_LADDER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"service","messages":[{"role":"user","content":"ok"}],"max_tokens":16}' \
  | head -c 200
```

- `/health` отвечает без токена — он не проверяет авторизацию, только что воркер жив;
  **успешный `/health` ничего не говорит о токене**;
- `200` с `choices[0].message.content` = токен принят;
- `401`/`403` = токен не тот или отозван.

Проверено 17.10.2026: локальный файл даёт `200`, `service` → `opencode-go/mimo-v2.6-flash`.

## Не путать с `OPENCODE_LADDER_TOKEN`

Это **другой** токен и другая пара процесса:

| | `LLM_LADDER_TOKEN` | `OPENCODE_LADDER_TOKEN` |
|---|---|---|
| кто читает | `src/service-llm.js` — серверные вызовы агента | `src/opencode-ladder-provider.js` — движок OpenCode |
| где | env / `~/agent-tokens/llm-ladder/token` | env конкретного запуска OpenCode |
| видимость | server-only, в `src/agent-isolation.js` в списке непроницаемых | per-run credential, выдаётся на один запуск |
| в воркере | используется как есть | используется как есть |

Токен агента **не** должен попадать в окружение движка: изоляция процессов
(`AGENT_ENV_ALLOWLIST`, `scripts/ops/agent-isolation-setup.sh`) специально держит
`LLM_LADDER_TOKEN` непроницаемым — движок получает только свой.

## Где токена нет и быть не должно

**В репозитории агента нет provider-ключей** — ни `OPENROUTER_API_KEY`, ни
`OPENCODE_GO_API_KEY(S)`, ни OpenCode Go/Zen-креденшела. Всё это живёт в секретах
самого воркера лестницы (`trained-assist-llm-ladder`), и агент их не видит: он
держит только токен доступа к лестнице. Любая попытка «добавить ключ провайдера в
агента, чтобы не ходить в лестницу» возвращает дублирование, которое воркер уже
решает (ротация ключей, health-скипы, платные хвосты). Это тот же запрет, что
ADR-0001 в `trained-assist-communication-skills`.

## Как заменить или отозвать

1. Положить новое значение в источник 2 (файл) или 3 (Secret Manager) — файл
   читается при каждом вызове, перезапуск не нужен.
2. Проверить тем запросом из раздела выше.
3. Старое значение отозвать в воркере (`wrangler secret delete LLM_LADDER_TOKEN`
   в репозитории `trained-assist-llm-ladder` + передеплой) — иначе старый токен
   продолжит работать бессрочно.

Ротация ключей провайдера **не требует** ничего из этого: ею занимается воркер
лестницы.
