# Domain Skill Repo — Test & CI Rules

Правила тестов и CI для **доменных skill-репозиториев** — `trained-assist-<domain>-skill`
(recruiting, engineering, sales, freelance, …). Основной репо (`trained-assist-agent`,
Agent Control Plane) владеет этими правилами и предоставляет переиспользуемый harness.

> **Обязательный минимум (с 2026-09-28)** — то, без чего доменный репо нельзя
> монтировать в прод; всё остальное в этом документе — рекомендуемый полный контур,
> а не блокер переноса:
>
> 1. `npm run check` — каждый модуль `src/mcp-skills/tools/*.js` загружается.
> 2. Юнит-тесты перенесённой логики (`node --test` / vitest), без сети и LLM.
> 3. В CI: `node <core>/scripts/check-mcp-conformance.js .` — тот же MCP-контракт,
>    которым `scripts/deploy.sh` проверяет сиблинг перед обновлением в проде.
> 4. Таймауты на внешний HTTP, токен-файлы `0o600`, никаких `require` кода ядра
>    (к ядру — только HTTP с `AGENT_SECRET`).
>
> Эталон минимума — `trained-assist-sales-skill`. Почему минимум, а не «всё
> обязательно»: полный контур (L1–L3 + replay + фикстура/политика на каждый тул)
> делал каждый перенос тула дороже самого переноса, а скаффолд под него
> (`create-domain-skill`) так и не заработал (зависел от неопубликованного npm-пакета)
> и удалён. Рецепт переноса: `docs/how-to-move-a-tool-to-a-domain-repo.md`.

Область документа: **как тестировать доменный skill**, а не как его писать
(это `docs/skill-spec-template.md`, `docs/how-to-add-skill.md`).

---

## 0. Главный принцип: тестируй на шве контракта, мокай ровно две вещи

Доменный skill — это MCP-сервер (stdio JSON-RPC). Его внешняя граница — не
внутренние функции, а три стабильных контракта:

1. **MCP-конверт** — `initialize` / `tools/list` / `tools/call`.
2. **Манифест источника** — `contracts/mcp-skill-sources.schema.json`.
3. **Наблюдаемые исходы сценария** — файл создан, API вызван, текст содержит X
   (секции «Validation» / «Проверяемые инварианты» в `docs/user-scenarios/<domain>/*.md`).

**Мокать можно ровно два рубежа, и ни один из них — не твой сервис:**

| Рубеж | Чем мокаем | Почему |
|-------|-----------|--------|
| LLM / агентные шаги | скриптованные ответы / фикстуры | недетерминизм и цена |
| Внешняя сеть (HH, GDrive, Weeek, сайты, платежи) | записанные HTTP-фикстуры (record/replay) или `fakeProvider` | недоступность, гео-блоки, квоты |

Всё между ними — твой MCP-сервер, registry, handlers, манифест — работает
**по-настоящему**. Именно это даёт уверенность «на верхнем уровне», не заглядывая
во внутренности.

> **Анти-правило: mock-регистратор / mock-сервис не строится.** Регистратор
> (`src/mcp-skills/registry.js`) — детерминированный загрузчик; если его
> замокать, тест проверяет мок, а не систему, и мок-реализация дрейфует от
> настоящей (тот же класс проблемы, что «single execution owner» у
> `ActionBroker`). Регистратор трогай **только** на staging — и там запускай
> настоящий, не мок.

---

## 1. Три слоя CI — рекомендуемый полный контур (обязательный минимум — см. начало)

### L1. Contract (герметичный, без сети/LLM)

- `mcp.manifest.json` валиден против `contracts/mcp-skill-sources.schema.json`.
- `revision` — 40-hex SHA; `artifactDigest` — sha256 артефакта и совпадает с
  пересчитанным.
- Паритет имён: множество тулов в манифесте **равно** множеству в `tools/list`
  реального сервера (ни лишних, ни пропавших).
- Имена не коллизят с core-сервером (`writeMcpConfig` не должен ничего
  перекрывать — см. `src/browser.js`, `mergeAdapterServers`).

### L2. Behavior (герметичный: реальный сервер + фикстуры)

- Сервер поднимается как **настоящий subprocess** по stdio и опрашивается
  JSON-RPC. В CI нет вызова handler'ов напрямую в обход MCP.
- Для **каждого** тула есть фикстура: `{ name, validArgs, expectedEnvelope }`.
  Проверяется, что `tools/call` возвращает `{ content: [...] }`, а ошибка —
  `isError`, а не краш процесса.
- Внешний мир — записанные фикстуры. Ни одного реального HTTP-запроса.
- Ассерты — только по контракту, **никогда** по внутренним функциям, порядку
  приватных вызовов или точному тексту LLM.

### L3. Guards (статический grep, зеркало core-гейтов)

- Quick-action-тулы **не** спавнят Claude/`runner.js` (в core это жёсткий гейт в
  `ci.yml`; доменный репо обязан иметь свой эквивалент).
- Каждый внешний `fetch`/HTTP-вызов — с таймаутом (`AbortSignal.timeout`).
- Секреты не логируются; токен-файлы — `mode 0o600`.
- Пути профиля — через резолвер (`data-paths`-эквивалент), не хардкод `os.homedir()`.

---

## 2. Детерминированный replay-гейт (модель `staging-gate`)

Core уже владеет эталоном — `scripts/staging/run.mjs` + `scripts/staging/isolation-guard.cjs`,
запускаемый как `npm run test:staging` в job `staging-gate`. Доменный репо
перенимает **тот же** паттерн (Phase 1 — вендорит harness, Phase 2 — общий
пакет, см. §6):

**Гейт соответствия (как проверить, что доменный репо следует правилам).**
Одна команда — из доменного репо, через devDependency test-kit:

```bash
npx mcp-skill-conformance .        # или: node node_modules/@trained-assist/mcp-skill-testkit/bin/mcp-skill-conformance.js .
```

Она проверяет обязательные артефакты §5, conformance манифеста против
`contracts/mcp-skill-sources.schema.json`, непустой mandatory-набор
`staging/suites.json` (или `scripts/staging/suites.json` — раскладка репо, что
вендорили Phase 1 runner) без ссылок на несуществующие файлы, и L3-гейты
(quick-action-тулы не спавнят Claude; у серверного `fetch` есть таймаут; секреты
не логируются; пути через резолвер). Файл, который только генерирует HTML с
клиентским JS, помечается комментарием `mcp-skill-conformance: browser-fetch` —
явное, ревьюируемое исключение из правила таймаута. Из core тот же чек доступен
как `node scripts/check-domain-skill-repo.mjs <repo>`.

Пока пакет не опубликован в registry, доменный CI берёт кит из публичного core
(sparse checkout `packages/mcp-skill-testkit` на **запиненном SHA**) и запускает
`bin/mcp-skill-conformance.js` отдельной джобой `conformance`, которую требуют
`ci` и `staging-gate`. Поднять пин = осознанно принять новые правила гейта.

**Чек в PR-шаблоне.** Каждый доменный репо несёт `.github/PULL_REQUEST_TEMPLATE.md`
с conformance-чеклистом (канон —
`packages/mcp-skill-testkit/assets/PULL_REQUEST_TEMPLATE.md`). PR не готов, пока чеклист не пройден и CI не зелёный.

- **Изоляция всех data-root'ов** в temp: `HOME`, `TMPDIR`, `USERS_DIR`,
  `AGENT_DATA_DIR`, `AGENT_TOKENS_ROOT`. Guard преload'ится в каждый процесс
  через `NODE_OPTIONS=--require` (наследуется форками и детьми).
- **Fail-fast:** прод-креды в env → abort.
- **Outbound — loopback-only:** Telegram / OpenRouter / GitHub / внешние API
  бросают `STAGING_OUTBOUND_BLOCKED`. Тесты, которым нужен бот, используют
  локальный fake на loopback.
- **Манифест прогона:** `sourceSha256`, `dirty`, isolation-детали,
  `outboundBlocked[]` — артефакт CI для аудита «что именно гонялось».

Mandatory-набор сценариев — `suites.json`; прогон с `skipped`/`todo`/пустой
набор **не может** аппрувить релиз (см. проверки в `run.mjs`).

---

## 3. Сценарии — источник истины поведения

- Каждый домен пишет `docs/user-scenarios/<domain>/*.md` по формату из
  `docs/user-scenarios/README.md`: `Контекст → Шаги → Validation → Edge cases`.
- **План моков пишется вместе со сценарием** — моки это часть определения
  сценария, не постфактум (образцы: CI-планы моков в
  `docs/user-scenarios/engineering/01-development-playbook.md` §«CI-сценарий»,
  `.../freelance/...`, `.../exhibition/...`).
- Каждый шаг имеет наблюдаемый ассерт. Всё, что не наблюдаемо, — не тест-кейс.
- Два класса сценариев, разметить явно:
  - **mandatory** — в гейте (`suites.json`), детерминированный replay;
  - **exploratory** — вне гейта, может использовать LLM-судью, не блокирует релиз.

---

## 4. CI vs Staging — где живёт LLM-судья

| | CI (каждый PR) | Staging (post-merge) |
|---|---|---|
| Режим | **детерминированный replay** | живой прогон / канарейка |
| LLM | скриптованные фикстуры | cheap-LLM судья, живой Hermes |
| Сеть | loopback-only (guard) | sandbox-аккаунты платформ |
| Монтирование | не запускается (L1/L2 его не требуют) | sibling-чекаут рядом с ядром, как в проде |
| Вердикт | pass/fail по контракту | качество/поведение, алертинг |

**Правило: LLM-судья — это staging, а не CI.** Судья-LLM в CI даёт
недетерминированный, флейки-гейт. В CI «судья» — это зафиксированная фикстура
ожидаемого вывода.

Staging домена не поднимает мок-регистратор: домен монтируется так же, как в проде — sibling-чекаут рядом с ядром (`src/browser.js`). Отдельного sealed/dual-пути нет (удалён 2026-09-27).

---

## 5. Обязательные артефакты в доменном репо

```
trained-assist-<domain>-skill/
  mcp.manifest.json          # против contracts/mcp-skill-sources.schema.json
  src/mcp-skills/            # tools/, registry-совместимый entrypoint (stdio JSON-RPC)
  docs/user-scenarios/<domain>/*.md   # сценарии + план моков
  scenarios/<name>/          # шаги replay + expected-фикстуры (вход в гейт)
  fixtures/                  # записанные HTTP-ответы платформ, скрипты LLM
  staging/suites.json        # mandatory-набор для replay-гейта
  .github/workflows/ci.yml   # jobs: contract, behavior, guards, staging-gate
  checklist.md               # см. §7
```

---

## 6. Harness — один на всех, не переизобретать

Core отдаёт переиспользуемый **test-kit**. Phase 1: репо вендорит harness-файлы
(`run.mjs` + `isolation-guard.cjs` + `suites.json`); Phase 2: извлекается в
`@trained-assist/mcp-skill-testkit` (devDependency). Интерфейс фиксируем сразу:

```js
startMcpServer({ entrypoint, env, workDir }) → { call, stop }   // stdio JSON-RPC
assertManifestConforms(manifestPath, schemaPath)                // L1
expectToolContract(call, tools, fixtures)                       // L2
fakeProvider({ tools, flags })                                  // внешний мир, детерминированно
replayFixtures(dir)                                             // HTTP record/replay
// + preload isolation guard (NODE_OPTIONS=--require)
```

Готовые кирпичи в core, которые kit оборачивает: `tests/helpers/mcp.js`
(поднять реальный сервер), `tests/fixtures/providers/fake-provider-mcp.js`
(детерминированный внешний провайдер), `scripts/staging/*` (изоляция + гейт).

---

## 7. Определение готовности (DoD) доменного репо

PR-first (см. `docs/REPO-HYGIENE-PLAYBOOK.md`): ветка → PR → зелёный CI →
squash-merge. После `gh pr create` — `checklist.md`:

```markdown
Goal: <одна строка>

- [ ] CI green on <PR URL>
- [ ] Merged to main
- [ ] Deployed / mounted to staging — verified live
```

Репозиторий **не считается готовым**, пока:
- [ ] L1/L2/L3 зелёные, mandatory `suites.json` непустой;
- [ ] нет network-outside-loopback и прод-кред во время CI (guard доказывает);
- [ ] есть сценарий + план моков на каждый поддерживаемый happy-path;
- [ ] manifest-паритет имён тулов с core соблюдён;
- [ ] quick-action-тулы не спавнят Claude;
- [ ] staging-канарейка проверена (источник реально монтируется, не мок).

---

## 8. Что отклонено (явно, чтобы не вернулось)

- **Mock-регистратор / mock-сервис как отдельный сервис** — параллельная
  реализация, дрейфует; вместо неё — conformance по манифесту + реальный сервер.
- **Прямой вызов handler'ов в обход MCP в CI** — тестирует не тот контракт.
- **LLM-судья в CI** — недетерминированный гейт.
- **Второй writer в SQLite/журнал** — single execution owner остаётся в core.
- **Ручной прогон вместо гейта** — сценарий без детерминированного replay не
  является тестом.

---

## Связанные документы

- `docs/user-scenarios/README.md` — формат сценария и планируемый runner
- `docs/user-scenarios/GOALS.md` — скоуп/out-of-scope
- `docs/CICD-REVIEW-2026-09-14.md` — состояние пайплайнов и дыры (staging-гейт)
- `docs/REPO-HYGIENE-PLAYBOOK.md` — branch-per-session, immutable PRs, hooks
- `contracts/mcp-skill-sources.schema.json` — формат `mcp.manifest.json` доменного репо
- `scripts/staging/run.mjs`, `scripts/staging/isolation-guard.cjs` — эталон replay-гейта
- `tests/helpers/mcp.js`, `tests/fixtures/providers/fake-provider-mcp.js` — кирпичи kit
