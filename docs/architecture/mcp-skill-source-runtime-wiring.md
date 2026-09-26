# Approved MCP skill sources: runtime wiring

**Статус:** предложенный дизайн, не реализация и не разрешение включать production.  
**Дата:** 2026-09-25. **Design issue:** [#1358](https://github.com/trained-assist/trained-assist-agent/issues/1358).  
**Родитель:** [#1353](https://github.com/trained-assist/trained-assist-agent/issues/1353).  
**Engineering:** [epic #1](https://github.com/trained-assist/trained-assist-engineering/issues/1), [library-first #3](https://github.com/trained-assist/trained-assist-engineering/issues/3), [PR #4](https://github.com/trained-assist/trained-assist-engineering/pull/4).

Документ завершает дизайн «PR2» из [mcp-skill-sources.md](mcp-skill-sources.md). Все новые имена функций, transport context и lifecycle ниже — предлагаемые интерфейсы. Наличие их в документе не означает наличие в коде.

## 0. Решение в одном экране

**В v1 в сессию монтируем core-owned adapter-process, а не entrypoint внешнего репозитория.** Adapter владеет provider child и его lease, но **не пишет operational SQLite и не исполняет `invokeAction` локально**.

Существующий server-процесс уже является единственным execution owner для operational data-root. Поэтому policy/idempotency/action history остаются внутри host через узкий private `ActionBroker`; adapter использует его как callback.

```text
OpenCode / Claude / Codex
  │ MCP stdio; прежнее имя mcpServerId
  ▼
core-owned adapter process
  │
  ├──── private ActionBroker IPC ────► trained-assist server (single execution owner)
  │                                   └─ invokeAction → ActionExecutions / policy / history
  │                                          │ transport dispatch/result
  │◄─────────────────────────────────────────┘
  │
  └─ MCP stdio → provider child
                  └─ private verified artifact copy
```

То есть v1 имеет **один узкий IPC только для вызова host-owned action boundary**. Это не прежний тяжёлый `SessionMcpRuntime`: host не владеет provider process, не ведёт его MCP lifecycle и не становится general proxy. Adapter всё ещё владеет provider child/journal; host остаётся единственным writer operational SQLite.

Почему не другие варианты:
- не открываем `durable-tasks/state.db` из adapter: это нарушает существующую whole-process single-owner модель и тащит `better-sqlite3`/migrations в retained adapter bundle;
- не заводим отдельную history для adapter: это создаёт второй source of truth и ломает idempotency/history parity;
- не делаем operational SQLite multi-writer contract только ради MCP: слишком большой blast radius;
- не возвращаем полный host runtime/supervisor: narrow ActionBroker решает конкретно ownership DB/policy.

Если позже появится измеримая потребность в shared provider processes или централизованном cross-run recovery, это отдельный v2.

Ключевые решения:
- `mcpServerId` — стабильное имя для engine; `providerId` — внутренняя identity.
- Один resolved generation snapshot materialize-ится на run; adapter после старта **не перечитывает active config**.
- Provider version закреплена на run; reload влияет на новые runs.
- Hash/copy — при provider lease acquire, не per call.
- `invokeAction`, consent/policy, idempotency и `action_executions` всегда выполняются host owner-процессом.
- Mutation через autonomous MCP требует host-stable operation identity + provider-side idempotency; unsafe mutation без этого не экспонируется.
- Same-UID engine не является adversarial security boundary.
- Engineering capabilities остаются сервисами: unavailable возвращается как capability error; запрет продолжать работу определяется caller/user/project policy.
- Первый реальный engine milestone — **OpenCode + fake read-only provider**: он уже first-class в runner, имеет per-invocation MCP config и `free` model profile.

## 1. Проверенная база и границы достоверности

Чтение core выполнено на commit [`3b31a0dc68ccd75da37a731787b9b233d7d21eca`](https://github.com/trained-assist/trained-assist-agent/tree/3b31a0dc68ccd75da37a731787b9b233d7d21eca). Engineering main — [`afa06896e30f101e272852b98b80e4524b06e43e`](https://github.com/trained-assist/trained-assist-engineering/tree/afa06896e30f101e272852b98b80e4524b06e43e). На момент чтения engineering PR #4 открыт, его head — `2b379a99364ccd5dd86265547ea4ec37bfd87d1c`; он не считается доставленной MCP-интеграцией. VM и установленные CLI-бинарники в рамках дизайна не запускались.

Что действительно есть:

| Файл | Факт, существенный для дизайна |
|---|---|
| `src/mcp-skill-source-registry.js` | Metadata snapshots, collisions, profile eligibility, strict artifact verification, `acquireAction`. Не session wiring. |
| `src/mcp-skill-artifact.js` | Проверка всех bytes/dependencies, private copy с повторной проверкой, замыкание `release`. Durable process-lease journal отсутствует. |
| `src/browser.js` | `writeMcpConfig` пишет per-user `.mcp.json`, напрямую монтирует HH/Freelance sibling paths. |
| `src/mcp-action.js` | Ещё один прямой путь HH; `require` внешнего registry в host и single-call child. Читает первую stdout-строку, не полноценный MCP lifecycle; `isError` отдельно не проверяет. |
| `src/action-provider-registry.js` | `validateCall` проверяет schema и trigger. Это НЕ проверка владельца ресурса и НЕ approval. |
| `src/action-invoke.js` | `options.approved` — host-side, history/idempotency есть; transport пока не получает отдельный host context. Не считать этот код полной готовой авторизацией. |
| `src/execution-owner-lock.js` + `src/server.js` | Server на старте держит whole-process exclusive execution ownership для `SYSTEM_ROOT`; второй server-owner получает отказ. Это архитектурный single-owner invariant, не просто SQLite tuning. |
| `src/action-executions.js` | По умолчанию пишет `action_executions` в общий `durableTaskDbPath()` (`SYSTEM_ROOT/durable-tasks/state.db`, WAL). Adapter не должен становиться вторым writer в обход execution owner. |
| `src/runner/claude-runner.js` | Три engine adapters уже есть; OpenCode config пишется в `cwd`. Деструктурированный `env` сам по себе не становится фактическим spawn env. |
| `src/hermes-tools-run.js` | Ещё один caller `writeMcpConfig`/engine runner, который нельзя забыть при миграции. |
| `config/mcp-skill-sources.json` | `sources: []`. |
| Engineering `provider-manifest.json` | v2 с пустым `contextFields`; текущая core schema требует хотя бы одно поле. |

Точные source links приведены в конце. Обнаруженные ограничения не исправляются этим documentation-only PR.

## 2. Состав компонентов и точное построение session config

### 2.1 Generation и materialized run snapshot

```ts
compileSourceGeneration(config, coreCatalog, deploymentPolicy): Generation
planSessionMcp(generation, hostRunBinding, coreServers): SessionMcpPlan
materializeSessionMcp(plan, runtimeDir): SessionMcpFiles
```

`compileSourceGeneration` строит immutable generation: core descriptors + `McpSkillSourceRegistry`, diagnostics и resolved external source metadata. Разные generations не смешиваются в одном mutable registry.

`planSessionMcp` выбирает effective sources для конкретного profile/run. Оно не запускает provider и не ходит в сеть.

**Критичный invariant G1/G2:** до запуска engine host materialize-ит **полный resolved generation snapshot**, а не только `generationId`/`providerId`.

```text
ResolvedGenerationSnapshot v1
  generationId + configDigest + coreCatalogDigest + coreRevision
  full source descriptors for this generation:
    id/providerId/mcpServerId/repository/revision
    manifestVersion/artifactDir/entrypoint/manifest/artifactDigest
    approvedManifest/enabled/profiles
  effective SessionMcpPlan / diagnostics
```

Snapshot хранится как immutable/content-digested per-run file (или эквивалентно embedded в RunBinding); RunBinding содержит его digest и точную ссылку. Adapter проверяет digest и использует этот snapshot весь lifetime. **После старта adapter никогда не перечитывает active `approved.json`**, поэтому config swap G1→G2 не может подмешать G2 source/policy в G1 run.

Алгоритм:
1. Host выбирает целую generation и формирует full resolved snapshot.
2. Фиксирует run identity/profile/project/task/resource bindings.
3. Резервирует core MCP names; invalid/conflicting/disabled/ineligible sources не монтируются.
4. Для доступного source engine config получает command **core-owned adapter**, не source entrypoint/sibling path.
5. Materialize RunBinding + generation snapshot + adapter config вне code cwd.
6. Перед engine spawn host регистрирует run/provider capability в ActionBroker.

Пример engine descriptor:
```json
{
  "mcpServers": {
    "engineering": {
      "command": "<trusted node>",
      "args": ["<retained core bundle>/provider-adapter.js", "--binding-file", "<run-runtime>/engineering/run-binding.json"]
    }
  }
}
```

RunBinding не содержит raw credentials. Он содержит broker endpoint/capability, resolved opaque resource bindings и digest полного generation snapshot.

Provider приобретается adapter-ом лениво на первом `tools/call`; `initialize`/`tools/list` обслуживаются approved static catalog. Optional capability failure возвращается как unavailable/degraded и логируется; сам engineering tool не принимает глобальное решение «агенту запрещено работать».

### 2.2 Каталог tools без выполнения external JS

Каталог строится из approved action names/input schemas; не делать `require` external registry ради discovery. Description в текущем action descriptor отсутствует — не предполагать обратное. Для первого wiring достаточно name + inputSchema. Если legacy descriptions нужны, они входят в статический presentation catalog проверяемого release и не расширяют permissions.

После первого запуска provider child проверить его `tools/list` против approved catalog: extra names/schema mismatch не дают новых полномочий. Credential-dependent runtime readiness — отдельный diagnostic. Для HH/Freelance cutover требуется parity fixture, а не слепое сравнение количества tools.

## 3. Доверенный host-context и единый action path

### 3.1 Источник полномочий и ActionBroker

Host создаёт RunBinding из аутентифицированного запуска **до engine spawn**:
```text
RunBinding v1
  engineRunId, rootTaskId, attemptId, nativeSessionId?
  profileId, projectId, trigger, origin, channel
  resolvedGenerationSnapshotDigest/path
  providerId, sourceRevision, artifactDigest
  repositoryBindingId?, workspaceBindingId?, resourceBindingVersion
  brokerEndpoint + run/provider-scoped capability
```

Adapter не открывает operational SQLite. В server-процессе появляется узкий `ActionBroker` (Unix socket на том же Linux host; loopback port только если platform заставит). При launch host регистрирует capability → immutable run/provider binding in-memory.

Capability payload не является security boundary против same-UID engine; он предотвращает accidental/cross-run confusion внутри managed path. Broker резолвит scope только из host registry, а profile/project/root из payload игнорирует.

**`invokeAction` остаётся in-process host function.** ActionBroker вызывает его с существующими `ActionExecutions`/policy objects. Adapter bundle поэтому не тянет `better-sqlite3`, operational DB migrations или execution-owner logic.

### 3.2 Путь `tools/call`

```text
engine tools/call
→ adapter validates MCP framing + static mounted action
→ adapter sends broker.invoke(action,args,clientCallIdentity)
→ host authenticates run/provider capability
→ host resolves RunBinding/current resource ownership/policy
→ host calls invokeAction(...)
     → ActionExecutions begin/idempotency in single-owner server
     → transport callback = broker.dispatch(...) back to THIS adapter
→ adapter dispatches to pinned provider child over MCP stdio
→ adapter returns normalized provider result to host
→ host finishes ActionExecutions and returns ActionResult
→ adapter maps ActionResult to MCP CallToolResult
```

Broker channel поэтому bidirectional, но narrow: `invoke`, `dispatch`, `dispatchResult`, cancellation/close. Он не управляет provider process lifecycle и не становится general RPC surface.

`origin='mcp'`; trigger/profile/project/approval/roots назначает host. `approved:true` из model args/_meta не имеет эффекта. Consent/policy wording теперь буквально означает **host server**, не adapter.

Timeout после provider dispatch сохраняется host-ом как unknown/outcome-unknown; adapter не делает самостоятельный retry mutation.

### 3.3 Как context доходит до provider handler

**Протокол фиксируем явно:**
- engine ↔ core adapter = **MCP stdio**;
- core adapter ↔ provider child = **MCP stdio**;
- host context передаётся только на втором hop через versioned `params._meta['trained-assist/host-context']`.

Adapter удаляет одноимённое входное `_meta` поле от engine и формирует своё из RunBinding/resolved resource binding. Provider подтверждает поддержку extension в negotiated experimental capability. Provider-side adapter передаёт context вторым параметром handler (`handler(args, ctx)`); library code принимает resolved binding напрямую.

Host context не является manifest v2 `contextFields`: domain fields и authority context — разные понятия.

Для legacy HH/Freelance допускается фиксированный **per-run** `USER_ID`/`WORK_DIR` из RunBinding; env не меняется между calls. Provider process не переиспользуется между profiles/projects/resource bindings и не получает новые workspace mutation actions до поддержки invocation context.

Для текущего `engineering_prepare_task(repo_path, task)` — временная compatibility: adapter принимает `repo_path` только при exact match разрешённому read binding после canonical/symlink checks. Будущие mutation tools используют opaque repository/workspace IDs + host-resolved context, не arbitrary roots.

Поддельные `repo_path`, `profileId`, `approved:true`, `_meta` или workspace ID другого task покрываются negative tests.

### 3.4 Граница защиты

Managed adapter предотвращает accidental mixing generations/runs и не доверяет LLM arguments как authority. Он **не защищает от самого coding engine**, если engine имеет shell под тем же Linux UID.

Следовательно:
- runtime file modes/copies — hygiene и determinism, не security sandbox;
- same-UID engine теоретически может читать чужой run directory;
- для недоверенного/multi-tenant engine нужен separate UID/container/VM или brokered boundary;
- дополнительный custom IPC в v1 сам по себе эту проблему не решает.

## 4. Provider lease: adapter владеет child и journal

### 4.1 Владелец процесса

V1 не вводит отдельный `SessionMcpRuntime`/supervisor service. **Один core adapter-process на `(engineRunId, providerId, generationId, resourceBindingVersion)`** является владельцем:
- provider private execution-copy;
- provider child process;
- bounded call queue;
- lease journal;
- MCP client state к provider.

Параллельные первые calls внутри adapter используют single-flight. V1 сериализует calls внутри одного provider instance; это не глобальный limit agents. Lease не совпадает с workspace lease и не решает #706.

Acquire sequence:
```text
adapter start
→ validate pinned generation/source/profile
→ atomic lease ownership
→ full verify approved artifact
→ private copy
→ post-copy verify
→ spawn provider child
→ MCP initialize/initialized/tools-list parity
→ ready
```

### 4.2 Single-writer journal

Journal должен иметь одного writer **по конструкции**.

Для каждого lease:
1. adapter атомарно создаёт lock directory / ownership record (`mkdir` или equivalent create-if-absent);
2. record содержит `leaseGeneration`, run/provider IDs, host/boot identity, adapter PID+start identity, provider PID+start identity, process group, copy path, lifecycle/timestamps;
3. обновление record: temp file → fsync → atomic rename; только holder текущего `leaseGeneration` пишет;
4. новый adapter того же run/provider не steal-ит lock по TTL. Сначала reconcile recorded OS identity; ambiguous live/unknown → `needs_reconcile`, без второго provider child;
5. normal release снимает lock только после доказанного завершения provider process group и durable final record.

Это не task DB и не business source of truth; journal нужен только для lifecycle/recovery provider copies/processes.

### 4.3 Закрытие и crash semantics

| Событие | Поведение |
|---|---|
| Engine/adapter normal EOF, stop, timeout | Запретить новые calls, отменить queue, close provider stdin, bounded wait → TERM → KILL; release после подтверждённого exit. |
| Provider crash | In-flight outcome нормализовать; не auto-replay mutation. Новый verified child — только после final/reconciled old lease. |
| Adapter crash, provider child жив | Новый adapter не стартует второй child вслепую. Startup reconcile по bootId/PID/start identity/process group; ambiguity → retain + unavailable/needs_reconcile. |
| Host reboot | Старые process identities не живы; unresolved actions остаются unknown; private copy reclaim после reconciliation. |
| PID reuse / identity unavailable | Не signal/delete только по PID или возрасту. Retain. |
| Copy есть без valid record | Orphan retained; explicit reconcile. |

Provider не должен daemonize descendants вне managed process group в v1. Parent-death magic не считается достаточной гарантией; normal shutdown управляется adapter, hard-crash recovery — conservative reconciliation.

**Осознанный trade-off v1:** recovery не живёт как отдельный host service после смерти adapter. Мы принимаем это ради меньшей инфраструктуры. Если реальные инциденты покажут необходимость always-on central supervisor, он становится v2 и использует те же journal/RunBinding/contracts.

### 4.4 Кто владеет reaper/reconcile

В v1 владелец фонового reconcile — **тот же trained-assist server process, который успешно держит `acquireExecutionOwner(SYSTEM_ROOT)`**. Второй server не может одновременно стать reaper owner.

Порядок:
1. после получения execution-owner lock и до обычного task recovery host делает startup scan provider lease journal;
2. затем запускает low-frequency reconcile timer;
3. adapter остаётся единственным normal writer своего live lease record;
4. host-reaper может перевести orphan/finalize cleanup только после доказательства, что adapter/provider process identities не живы; для takeover journal используется новый reconcile generation/CAS;
5. live/ambiguous/PID-reuse/unknown identity → retain + `needs_reconcile`, без signal/delete;
6. reaper никогда не трогает workspace/code/user data и не пытается повторять action.

Если server не смог получить execution-owner lock, он не запускает reaper. Отдельный daemon/reaper service в v1 не нужен.

### 4.5 Deadlines по классам actions

Начальные implementation defaults, не SLA:
- MCP handshake/provider startup: 10 s;
- обычный read action: 45 s;
- idempotent mutation/long engineering action: 120 s;
- shutdown: 5 s graceful + 5 s TERM before KILL.

Override задаёт **host/deployment policy по action/provider**, не LLM argument. Client timeout Claude/Codex/OpenCode должен быть >= внутреннего deadline + transport margin; это проверяется real CLI smoke.

Timeout после dispatch mutation → `unknown/OUTCOME_UNKNOWN`, без auto-replay. Progress не отменяет absolute deadline.

**TTL только инициирует reconcile. Workspace/code/data этот reaper не удаляет.**

## 5. Проверка артефакта и производительность

Не кэшировать разрешение исполнения по pathname, mtime или одному названию revision.

Разделить:

1. **Generation discovery snapshot.** Metadata, статический tools catalog и последнее состояние проверки. Ключ включает config digest, source artifact digest, validation-policy/core-catalog revision. Это кэш для списка/diagnostics, с `verifiedAt`, не spawn authority.
2. **New process acquisition.** Каждый новый child требует source verification и post-copy verification. Подмена release после discovery обязана обнаруживаться. Уже работающий child читает свою private copy, а не release pathname.
3. **Per-call path.** Schema/trigger/consent/resource binding/history; без повторного обхода `node_modules`. Доверие ограничено lifetime private copy в принятой same-UID trust boundary.

Публичное строгое поведение текущего `availability()` можно сохранить для явной проверки. Новый planner использует отдельно именованный status snapshot, чтобы незаметно не ослабить старые tests/callers. Одновременные cold acquisitions bounded; hashing/copy выполнять вне основного request event loop.

Стоимость одного нового provider process приблизительно `2 × V(B) + C(B)` (два полных обхода и копирование B bytes), а не `N_calls × V(B)`. Дополнительные activation checks считаются отдельно. Не обещать миллисекунд до измерений.

Метрики: verified bytes/files/ms, copy bytes/ms, startup time, active leases, retained/orphans, calls per process. Acceptance: после запуска 100 calls к одному provider не дают 100 full artifact scans; новый spawn после подмены bytes отклоняется. Не использовать hardlinks как «быструю копию»: текущий artifact verifier их отвергает и они нарушают выбранную независимость bytes.

## 6. Поколения, storage, activation и rollback

### 6.1 Расположение

Пример структуры на persistent local filesystem; реальные roots задаёт deploy, не LLM:

```text
<persistent-root>/mcp-skills/
  approved.json                 # единственный authoritative active config
  approved.json.<digest>.previous
  releases/<source>/<release>/  # immutable prepared providers
  runs/<runId>/                 # session configs/binding references
  executions/<leaseId>/         # resource journal + private provider copy
  core-bundles/<revision>/       # retained adapter code
```

`MCP_SKILLS_ROOT` задаётся явно, вне live repo. `MCP_SKILL_SOURCES_CONFIG` — путь к active config, не enable-flag; execution/run roots тоже host config. V1 **не строит general SessionMcpRuntime IPC**, но использует один private local Unix socket для узкого ActionBroker callback в single-owner server.

Незаполненный deployment path использует checked-in пустой config. Явно заданный, но недоступный path — ошибка, не молчаливый переход к sibling mounts. Релизы и runtime records не должны лежать в MCP execution-copy или workspace/code.

### 6.2 Один writer и atomic activation

Существующий `activateConfig` уже делает validate/fsync/rename и previous backup. Добавить deployment lock **на весь read-modify-validate-publish интервал** и проверку ожидаемого digest active config, чтобы два admin updates не затёрли друг друга. Долгий prepare релиза делается заранее; publication сериализован.

Host loader читает файл целиком, строит и валидирует новую generation, проверяет enabled releases и только затем атомарно меняет указатель. `fs.watch`/signal — лишь уведомление; источник истины — bytes/digest файла. Маленькая периодическая сверка восстанавливает потерянное уведомление. Одни source не добавляются по одному в уже активный registry.

Если новая generation invalid — оставить последнюю рабочую, показать `config_reload_failed` и attempted digest. На cold start без last-good поколения отказать external sources, оставить core доступным, показать конфигурационную ошибку. Не скрывать invalid_metadata/conflict за пустым success.

Run, стартовавший на границе swap, захватывает **либо G1, либо G2**, включая manifests/catalog/bindings; смесь запрещена. Нельзя после валидации action из G1 отправить её child из G2.

### 6.3 Обычный disable, resume и аварийный stop

Обычные `enabled/profiles` changes применяются к новым engine runs. Уже запущенные работают в закреплённой generation до штатного завершения. Для немедленного прекращения использовать существующий явный stop соответствующих tasks/runs, не вводить скрытый kill при reload.

Resume того же durable task сохраняет workspace и native session ID. Источники/версии брать из сохранённого run snapshot при условии текущего допуска профиля. Новая активная конфигурация не должна незаметно заменить версию возобновляемой задачи. Если доступ отозван или требуемый retained release недоступен — explicit unavailable, сохранить состояние; не fallback в sibling и не начать с пустой сессией. Обновление provider версии посреди задачи — отдельный видимый handoff после остановки старого экземпляра.

Rollback — публикация полной предыдущей конфигурации через тот же `activate`, с теми же validations/lock. Работающий G2 не переводится на G1 под ногами. Previous config, необходимые releases/core bundles сохраняются до конца rollback window **и** пока на них ссылаются live leases или resumable task snapshots. При будущем GC active и referenced releases не удалять. V1 не включает автоматическое удаление releases.

## 7. Env и паритет Claude / Codex / OpenCode

### 7.1 Три разных окружения

- **Engine env:** текущая auth/session инфраструктура coding engine; исправление всей её least-privilege модели — A2/#1353, не обещание этого wiring.
- **Stdio adapter env:** минимальный bootstrap: RunBinding path, generation/runtime roots, ActionBroker endpoint + run/provider-scoped capability. Adapter не пересылает своё унаследованное env provider-у автоматически.
- **Provider env:** core adapter формирует allowlisted env с нуля, не `{...process.env}` и не общий `mcpToolEnv`. Profile data paths и только необходимые secret bindings берутся host-side. Никаких `NODE_OPTIONS`, `NODE_PATH`, arbitrary preload или Git credential variables от модели.

Legacy `USER_ID`, `WORK_DIR` и нужные пути совместимости задаются host policy. Credentials не попадают в engine MCP config, tool arguments, Task Packet или diagnostics. На HH/Freelance onboarding отдельно перечислить реально требуемые env/file accesses; существующий общий `mcpToolEnv` не считать готовой least-privilege политикой. Provider, которому нужны hardcoded HOME paths, не переключать до адаптации/проверки этих зависимостей. Runtime permissions/secret references задаются deploy-owned policy, а не редактируемым project manifest. Retained adapter bundle **не содержит operational DB ownership/migrations и не открывает `durable-tasks/state.db`**; `better-sqlite3`/`ActionExecutions` остаются host-side.

### 7.2 Одна карта — три serializers

`SessionMcpPlan.mcpServers` — общий logical input. Использовать один generator, не три независимых фильтра источников.

| Engine | Renderer |
|---|---|
| Claude | Абсолютный per-run `--mcp-config`; strict config mode на поддержанной версии, чтобы не подмешивались старые mounts. |
| Codex | Per-invocation `-c mcp_servers.<id>...`; явное выключение inherited managed IDs, которых нет в plan. Не изменять общий `~/.codex/config.toml`. |
| OpenCode | Per-run JSON вне `cwd`; runtime override precedence проверяется на pinned CLI version. Не позволять project/global config или profile overrides восстановить старую команду. |

Current code использует старый OpenCode shape `{mcp: {id: {type:'local', command:[...]}}}`. Не переносить вслепую инструкции другого major version: serializer и config precedence тестируются на реально установленном binary. `OPENCODE_CONFIG` сам по себе не доказывает последний приоритет — официальная документация описывает также project/inline layers.

Для каждого managed server namespace нужно и положительное правило (в plan → наш adapter), и отрицательное (не в plan → inherited mount не возникает). Остальные MCP допускаются только как явно разрешённые core/catalog entries; недоказуемое effective configuration на этом host блокирует rollout, а не разрешается «по предположению». Не менять HOME/CODEX_HOME ради изоляции конфигов так, чтобы потерять native auth/session storage.

Acceptance сравнивает фактический effective каталог `(mcpServerId, actionName, inputSchema)` и реальный marker-вызов всех трёх движков, а не только JSON renderer snapshot. Тест с нарочно добавленным старым HH/sibling server в global/project config обязателен.

`writeMcpConfig` перестаёт совмещать browser state, per-user path и external-provider lifecycle. Выделить core server descriptor builder; `materializeSessionMcp` вызывается до построения engine argv. Per-run `.mcp.json`, OpenCode config, RunBinding и logs лежат в `runs/<runId>/`, не в code cwd. `user.workDir` остаётся user-data root; `codeCwd` отдельный. Не мутировать общий объект user при конкурентных runs.

Все exits — success, throw до engine spawn, timeout, stop, resume fallback — завершают/reconcile adapter/provider lifecycle; private copy не удаляется до доказанного завершения provider child. Обновить callers в `runner/index.js` и `hermes-tools-run.js`. Codex `-C` и `spawn.cwd` согласованы; на native resume, где `-C` отсутствует, настоящий process cwd остаётся правильным. Не рассчитывать, что переданный `env` уже применяется существующим `runEngineProcess`.

## 8. Protocol, ошибки и повторные вызовы

V1 имеет два MCP stdio hops и один narrow host callback:

```text
engine --MCP stdio--> core adapter --private broker JSON-RPC--> host invokeAction
                         |
                         +--MCP stdio--> provider child
```

ActionBroker — internal/private transport, не публичный MCP server и не provider protocol.

Оба соединения имеют initialize/version negotiation → initialized, ping, tools/list, tools/call, bounded framing/output, cancellation и shutdown semantics. Unsupported sampling/elicitation/resources/tasks не объявляются и не проксируются автоматически.

Provider может остаться на поддерживаемом `2024-11-05`; версию не объявлять «новейшей» без implementation. Adapter выполняет provider handshake до первого `tools/call`. JSON-RPC IDs/notifications/pages разбираются корректно. Stdout — protocol only, logs — stderr. Проверить ping/EOF на реальных adapters.

`isError:true` — failure, не success. Нормализовать весь CallToolResult, включая structuredContent при поддержке; legacy text parsing остаётся explicit compatibility adapter.

| Событие | Семантика |
|---|---|
| Malformed request / unknown tool | protocol/service error. |
| Forbidden scope / approval required | existing contract code; provider не вызван. |
| `isError:true` | action failure/tool error. |
| Unavailable до dispatch | `PROVIDER_UNAVAILABLE`, effect не начат. |
| Timeout/disconnect после dispatch | `unknown / OUTCOME_UNKNOWN`; effect мог состояться. |
| Stop до dispatch | queued call отменён без effect. |

### 8.1 Mutation retry invariant

LLM/MCP client может повторить tool call новым JSON-RPC request ID. Поэтому request ID **не является** business idempotency key.

Для autonomous MCP v1:
- `effect=read` + `retrySafety=read_only` — обычный safe path;
- mutation (`write`, `external_message`, `destructive`) экспонируется только если integration умеет получить **stable operation identity из host context** и provider/transport реально dedupe-ит её;
- предпочтительно descriptor имеет `retrySafety=idempotent`; `unsafe` mutation без durable operation identity через autonomous MCP v1 **не монтируется**;
- key не берётся из model args как authority. Он выводится host-side из root task/action-specific operation identity/resolved binding;
- одинаковая logical operation → одинаковый key даже при новом JSON-RPC ID/LLM retry; другие canonical args под тем же key → conflict;
- timeout after dispatch не даёт права «просто повторить».

`engineering_spawn_workspace` соответствует этому через operation key/rootTask identity. Для других mutation actions нужен аналогичный declared strategy до onboarding.

Общая exactly-once семантика не обещается: effect ledger/outbox/provider-specific idempotency остаются частью capability. Не вводить auto-replay mutations ради «прозрачного» MCP recovery.

Небольшие обязательные fixes action boundary: host-only context; `isError`/unknown mapping; корректный same-key race; schema-valid response на running execution. `running` не выдавать как готовый ActionResult — вернуть controlled in-progress/conflict semantics без второго dispatch.

## 9. B2: manifest contract и независимые блокеры

**Выбор для нынешнего engineering provider: валидный manifest v1.** Сейчас он объявляет только actions; фиктивное domain context field ради `minItems:1` не нужно. В engineering packaging PR выставить `version:1` и убрать v2-only `contextFields`/`connections`; `manifestVersion` source должен совпасть. Не ослаблять core v2 schema ради этого случая.

Если позднее engineering действительно объявит domain context/collections, перейти на валидный v2 отдельным release. Это не host security context из §3. История других v2 providers не меняется.

Данный PR документирует решение; сам engineering manifest/features не меняет. Lockfile, минимальный CI и reproducible artifact build (B3) остаются prerequisites настоящего activation, но не library-first Track A.

Невалидный manifest на cold load → `invalid_metadata`, source без actions. Попытка activation invalid/conflicting поколения не меняет active config. Runtime diagnostics должны объяснять это, не запускать непроверенный fallback.

## 10. Миграция HH/Freelance и non-MCP callers

### 10.1 Единственная authority после cutover

Конечное состояние: нет filesystem-presence onboarding, `require` внешнего sibling registry и direct external spawn ни в `browser.js`, ни в `mcp-action.js`. `mcpServerId` остаются `hh-skills` и `freelance-skills`; approved action names/input contracts также сохраняются. Не определять source через regex/prefix имени action.

Для обоих providers до cutover подготовить exact release, complete manifest/catalog mapping, explicit profile allowlist, env/path policy, readiness fixtures и smoke. Новая feature сама по себе не включает providers всем профилям.

Промежуточный PR может сохранять старый launch path только для **ещё не мигрировавших** HH/Freelance identities. Если источник уже заявлен admin-конфигом, даже disabled/invalid, legacy path для него недопустим. Profiles вне allowlist не получают sibling fallback. Конфиг с синтаксической ошибкой не возвращает legacy path; используется last-good generation или external unavailable.

Поэтому canary существующего HH делать на отдельном staging/test deployment, а production cutover — целой проверенной конфигурацией с нужным явным списком profiles. Не делать скрытый per-profile rollback на старый clone. После cutover удалить оба legacy code paths; смена config обратно не должна «воскресить» filesystem mount.

### 10.2 Последовательность

1. Реализовать wiring с пустым sources и fake provider tests; production не включать автоматически.
2. На test profile подключить artifact-compatible read-only engineering action и первым реальным engine проверить **OpenCode**: `OpenCode → adapter → ActionBroker/invokeAction → provider child → history`.
3. Затем доказать parity Claude/Codex на том же marker provider; только после этого готовить HH/Freelance parity с реальными paths/credentials и без production write в smoke.
4. Перед cutover сохранить прежнюю managed конфигурацию и releases. Legacy runs доживают; новые получают managed config. На время перехода старые процессы не переписывают config новых runs.
5. Удалить direct sibling launch/import и обновить все их callers/tests. Старые source checkouts не удалять в этом PR.

Миграция старого `dev_workspace_setup`, его token-in-origin и нового workspace lifecycle остаётся D1/#1353, не предмет этой дизайн-задачи.

### 10.3 Non-MCP остаётся first-class

Library/CLI engineering вызываются непосредственно из trusted worker и не требуют LLM/MCP. Shared multi-user core **не импортирует** user-scoped provider handlers in-process.

**Quick actions / cron / domain production path не переводится на новый managed transport до PR4 cutover.** PR1–PR3 могут добавить registry/adapter path для fake/test/canary sources, но существующий HH/Freelance traffic остаётся на старом маршруте до parity acceptance.

Только в PR4:
- `action-transport.js` и managed branch `runMcpTool` начинают выбирать migrated external source через registry;
- invocation-scoped adapter/lease закрывается после call;
- core-local legacy tools остаются отдельным core route;
- direct sibling fallback для migrated provider удаляется.

Так blast radius quick actions отделён от ранних runtime PR.

## 11. Controls и наблюдаемость

Не вводить `ENABLE_ENGINEERING_MCP`, `USE_NEW_REGISTRY` и отдельный consent toggle. Source `enabled`/`profiles` управляет mount; deployment paths и budgets не являются скрытыми feature modes. Default config пуст.

| Operator status | Detail reason |
|---|---|
| `off` | no_source / disabled / ineligible |
| `available` | metadata + last artifact readiness valid; current phase: discovered / starting / ready |
| `degraded` | optional provider unavailable, reload failed при last-good generation, credential needed, retained cleanup |
| `unavailable` | invalid_metadata / conflict / artifact_missing / artifact_mismatch / binding_missing / protocol_error / spawn_failed / required capability missing |

`available` установки не означает «авторизован любой action» и не доказывает provider credentials. Показывать phase, checkedAt, active/attempted generation и конкретную причину. Один source может быть unavailable, а весь run degraded; эти уровни не смешивать.

В existing readiness/journal добавить безопасный summary: run/task/source/provider/server IDs, revision/digest, generation, lifecycle phase, lease ID, acquisition/start/call/stop timings, error class и retained reason. В action history — correlation к lease/generation; не дублировать task и token accounting.

Ни tokens, ни полные env, ни user-supplied args в exception logs. RunBinding/resource references и credentials логируются только как безопасные IDs/digests; secret values/paths redacted. Дополнительный dashboard для первой версии не нужен.

## 12. Четыре implementation-PR и приёмка

Это план будущих PR. Design PR не включает runtime changes. Source packaging engineering (B2/B3) остаётся отдельной dependency.

### PR1 — Generation / session plan / RunBinding contracts

Core: pure generation compiler, reserved core names, `SessionMcpPlan`/`RunBinding` schemas, adapter descriptor/materialization, status snapshot, exact config generation, process-level acquireProvider integrity API. Никакого production mount.

Acceptance: empty config; invalid/disabled/ineligible; collisions/core precedence; G1/G2 snapshot; discovery без external JS; deterministic plan; B2 v1 fixture; RunBinding не принимает authority из model args; engineering #3/#4 не блокируется.

### PR2 — Core adapter + ActionBroker + provider child + journal + первый real milestone

Реализовать core-owned adapter-process: MCP server для engine и MCP client/supervisor для provider. Host server добавляет narrow ActionBroker и **единолично** выполняет `invokeAction`/ActionExecutions; adapter не открывает operational SQLite. Добавить single-writer provider lease journal, bounded protocol, allowlisted provider env, post-copy verification, idempotency/unknown semantics.

Сначала deterministic fake-provider E2E без LLM. Затем обязательный первый real-engine milestone — **OpenCode + fake read-only marker provider**:

```text
OpenCode
  → adapter
  → ActionBroker
  → host invokeAction / action_executions
  → adapter transport callback
  → provider child
  → history/result
```

Почему OpenCode первый:
- он уже first-class engine в текущем runner;
- per-invocation `OPENCODE_CONFIG` уже есть;
- проект уже имеет `free` ladder из OpenRouter `:free` моделей;
- marker-tool prompt можно гонять без business mutation и без платной модели.

Blocking unit/integration tests adapter/broker/provider остаются model-free. Реальный OpenCode smoke можно гонять в CI/staging при наличии `OPENROUTER_API_KEY`, используя bounded fallback по free ladder; внешнюю quota/provider недоступность отличать от wiring regression, чтобы бесплатный внешний endpoint не стал единственным доказательством корректности CI.

Acceptance: fake path/profile/approval/_meta; full resolved generation pinned; broker capability/scope; MCP handshake/ping/list/call; ActionExecutions пишет только host owner; timeout/isError; journal lock/same-key race; adapter/provider crash; server reaper ownership; PID reuse; repeated calls не rehash; source swap before new spawn rejected; OpenCode real CLI marker smoke; no production provider activation.

### PR3 — Claude/Codex parity + engine-run callers

Добавить тот же SessionMcpPlan/adapter descriptor в Claude/Codex, сохранить OpenCode path из PR2; вынести generated configs из code cwd; обновить `runner/index.js`, `claude-runner.js`, `hermes-tools-run.js`; negative inherited-server tests.

Acceptance: одинаковый marker provider на всех 3 engines; concurrent sessions не перетирают configs; correct cwd/native resume; global/project legacy config не resurrect server; launch/stop/resume cleanup; deadlines согласованы с установленными CLI versions. Read-only engineering canary — только после B2/B3-ready release.

### PR4 — HH/Freelance parity + quick-action cutover + rollout

Только здесь переводить production quick actions/catalog на registry managed transport; убрать sibling mounts/imports после parity. Env/path compatibility, setup/readiness, serialized activation/reload/rollback runbook.

Acceptance: preserved `hh-skills`/`freelance-skills` names/actions; profile isolation; 3-engine smoke; artifact unavailable не resurrect sibling; no direct external require/spawn after cutover; old/new runs не mix generations; rollback не удаляет release/native ID/workspace; full CI/staging unchanged.

### Дополнительные сквозные тесты

| Тест | Ожидаемый результат |
|---|---|
| Два первых calls одного run/provider одновременно | Один child/lease, ограниченная очередь; два независимых actions не теряют identity. |
| Два profiles, один provider release | Разные processes/context/runtime files; общий release только immutable. |
| Fake repo path через symlink, `..`, чужой workspace ID | Reject до child call; no file read/write вне binding. |
| Request пытается сменить `trigger` на user или передать approval | Host context не меняется; policy test ловит отказ. |
| Child сообщает extra tool или иную schema | Новые полномочия не появляются. |
| Child выдаёт текст в stdout до JSON / слишком большой ответ | Controlled protocol error и bounded memory, не первая случайная строка как success. |
| Timeout после фактического write, ответ потерян | Unknown outcome, нет автоматического повторного write. |
| Config swap одновременно с acquire | Child использует один pinned generation/digest. |
| Source заменили после discovery и во время copy | Post-copy validation отклоняет непроверенные bytes. |
| Старый child жив после deploy/rollback | Его copy не удаляется; новый run использует выбранное поколение. |
| Reaper видит старый mtime при живом process identity | Не удаляет. |
| Invalid config reload / два admin updates | Last-good сохраняется; stale writer получает conflict. |
| Engineering read-only B2 не исправлен | invalid_metadata, source не появляется как рабочий tool. |
| Нет workspace binding, а tools доступны | Чтение/мутация repo не получают fallback root. |
| Повторный rootTask в GTD | Этот дизайн не объявляет #706 закрытым; отдельный ownership gate по-прежнему нужен. |

## 13. Покрытие 12 челленджей и отклонённые альтернативы

| № из #1358 | Решение | Отклонённая альтернатива / оставшийся риск |
|---|---|---|
| 1. Source → server | §2, explicit mcpServerId + core precedence | prefix-based routing / direct entrypoint: bypass и смена client names. |
| 2. Lease lifetime | §4, adapter-owned lease + single-writer journal + conservative recovery | Always-on supervisor/service отложен в v2; TTL deletion/release-after-call ломают live child. |
| 3. Verification cost | §5, metadata snapshot + full verify на new child | mtime/path trust или hashing на каждом call. Private copy стоит disk/IO, измеряем. |
| 4. Generations | §6, immutable snapshot, atomic pointer swap | mutable singleton registry: old/new policy mix. |
| 5. Host context | §3, full resolved generation + RunBinding; narrow ActionBroker keeps invokeAction/DB in host; adapter-generated provider `_meta` | multi-process operational DB writer rejected; same-UID hostile engine remains outside security boundary. |
| 6. Controls | §11, enabled/profiles + explicit status | ещё один enable/approval framework, скрытая деградация. |
| 7. Engines | §7, shared plan + version-tested serializers | три selector-а и только JSON unit tests; inherited configs требуют negative tests. |
| 8. Migration | §10, staged cutover без fallback, preserved names | indefinite dual authority / mount по существованию папки. Реальные env зависимости ещё требуют parity tests. |
| 9. Non-MCP | §10.3, library/CLI first-class; quick-action cutover только PR4 | MCP-only architecture; ранний blast radius на production HH/Freelance. |
| 10. B2 | §9, engineering v1 до появления настоящих domain fields | фиктивное contextField или ослабление v2 schema. Packaging ещё не сделан этим PR. |
| 11. Storage/deploy | §6.1–6.2, persistent roots, single writer, retained helpers | runtime state в git checkout; два admin writers без CAS. |
| 12. Rollback | §6.3/§10, whole-config activate и retention | deletion/reinstall/native-session reset; in-flight force upgrade. |

### Что намеренно не строим

HTTP MCP gateway для внешних клиентов, **general** host-runtime/SessionMcpRuntime IPC в v1 (узкий ActionBroker callback остаётся), always-on provider supervisor service, общий OS sandbox, новый task scheduler/WIP gate, новые domain features, workspace/fast_verify реализацию, массовую чистку git/worktrees, новый approval UI и изменение branch protection. V1 сознательно выбирает один adapter-process + его provider child вместо нового сервисного стека.

## 14. Источники и проверка реализации

### Repository facts: pinned sources

- [PR1 authority/lifetime](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/docs/architecture/mcp-skill-sources.md)
- [Source registry](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/src/mcp-skill-source-registry.js), [artifact implementation](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/src/mcp-skill-artifact.js), [existing tests](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/tests/mcp-skill-source-registry.test.js)
- [Admin preparation/activation](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/scripts/prepare-mcp-skill-artifact.js), [source schema](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/contracts/mcp-skill-sources.schema.json)
- [Browser/session config](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/src/browser.js), [engine adapters](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/src/runner/claude-runner.js), [Hermes caller](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/src/hermes-tools-run.js)
- [Action invocation](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/src/action-invoke.js), [transport](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/src/action-transport.js), [single-call MCP path](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/src/mcp-action.js)
- [Execution owner lock](https://github.com/trained-assist/trained-assist-agent/blob/main/src/execution-owner-lock.js), [ActionExecutions](https://github.com/trained-assist/trained-assist-agent/blob/main/src/action-executions.js), [operational DB path](https://github.com/trained-assist/trained-assist-agent/blob/main/src/data-paths.js)
- Existing architectural precedent for child→core loopback capability transport: `docs/specs/domain-module-actions-cron-web-surface-v2.md`.
- [Action registry](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/src/action-provider-registry.js), [action/provider schema](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/contracts/action-v1/contract.schema.json), [legacy handler ctx](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/src/mcp-skills/registry.js)
- [Engineering manifest at reviewed main](https://github.com/trained-assist/trained-assist-engineering/blob/afa06896e30f101e272852b98b80e4524b06e43e/provider-manifest.json)

### Внешние ограничения: primary documentation

- [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle): negotiation, initialization, transport shutdown и deadlines. В этом дизайне поддержанный subset версионируется отдельно.
- [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports): JSON-RPC/stdout/stderr. ActionBroker — private internal callback transport between adapter and single-owner host; он не объявляется публичным MCP transport.
- [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools): tools/list, CallToolResult, tool execution errors.
- [Node 22 child processes](https://nodejs.org/download/release/v22.0.0/docs/api/child_process.html): signal delivery не равна exit; descendants и process group требуют отдельного управления.
- [Linux proc](https://www.kernel.org/doc/html/v6.9/filesystems/proc.html): process identity/start_time; это сведения для conservative recovery, не атомарный fencing primitive.
- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference), [Codex configuration](https://developers.openai.com/codex/config-reference), [OpenCode config](https://opencode.ai/docs/config/), [OpenCode MCP](https://opencode.ai/docs/mcp-servers/): механизмы конфигурации. Совместимость именно установленных версий подтверждается smoke, не выводится из актуальности веб-страницы.

Архитектурные решения, локальные deadlines, имена новых функций и PR-разбивка — предложения этого документа. Их корректность проверяется перечисленными implementation tests; выполненные runtime tests этим design PR не заявляются.
