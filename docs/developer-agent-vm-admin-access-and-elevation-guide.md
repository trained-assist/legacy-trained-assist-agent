# Доступ разработчика-агента к админке ВМ: угрозы, бест-практисы и схема выдачи

Гайд отвечает на один вопрос: **как выдать агенту-разработчику (dev/engineering раны на GCP-ВМ)
сисадминские возможности — смотреть логи, рестартить сервис, чинить прод — не превращая его в
root и не давая остальным профилям подобраться к чужим ключам.**

Контекст: после T0-изоляции ([#1649](https://github.com/trained-assist/trained-assist-agent/issues/1649),
[docs/agent-process-isolation.md](agent-process-isolation.md)) все раны идут под слот-пользователями
`ta-agent-N`, у которых по умолчанию **нет** ни sudo, ни `journalctl`, ни доступа к `/home/vova`.
Это правильно для пользовательских профилей, но инженерные раны (разработка, багфикс самого
trained-assist-agent) теперь тоже слоты — и им нечем работать как сисадмину.

Проверки ниже выполнены на хосте `gcp-main` (136.65.7.197) **2026-09-28**; код — по текущему `main`.

---

## 1. Кто есть кто (модель угрозы)

| Агент | Unix-идентичность | Права | Доверие |
|---|---|---|---|
| Слот-ран профиля (`ta-agent-N`, группа `ta-agents`) | unprivileged | нет sudo (password required), нет журнала (exit 1), нет `/home/vova` (750), metadata закрыта firewall'ом по gid | **нулевое** — это и есть изоляция |
| Сервис-юзер `vova` (systemd `assist-agent`) | `vova`, член `adm`/`google-sudoers` | `NOPASSWD: ALL` (полный root), читает `secrets.env`, `~/.ssh`, `~/.git-credentials` | **полное** — это брокер |
| **MCP-серверы** (trained-skills, playwright, сиблинги) | запускаются **как `vova`** ([src/agent-mcp-bridge.js](../src/agent-mcp-bridge.js) — `spawn` без смены uid) | весь env сервиса (`AGENT_SECRET` и пр.), достижим metadata-эндпоинт (firewall матчит только gid `ta-agents`) | **полное** — и это главная лазейка, см. §3 |
| Человек-разработчик (сессии на Mac) | локальный `vova` на macOS + SSH-ключ `~/.ssh/trained-assist-gcp-vm_vova_ed25519` (0600) → `vova@ВМ` → `sudo` | полный | ключ лежит **вне ВМ** — слоты и MCP его не видят |
| Внешние профили бота (другие люди) | те же слоты и та же MCP-поверхность | что разрешено их рантайму | **враждебны по умолчанию** (промпт-инъекция из чужого чата) |

Ключевой тезис: **изоляция слотов защищает от прямого root, но не от capability-поверхности
MCP**, потому что MCP-тулы исполняются доверенной стороной (`vova`). Всё, что `vova` может
прочитать или вызвать, — это то, до чего может дотянуться любой профиль через свои MCP-тулы.

---

## 2. Прямые ответы на вопросы

### 2.1 «Положим админ-ключ в Google (Secret Manager / SA) — безопасно ли для Вовы?»

**Сейчас — нет.** Пока открыты дыры из §3, цепочка выглядит так:

```
агент любого профиля
  → MCP-тул website_request (исполняется как vova, firewall его не блокирует)
    → GET http://169.254.169.254/.../token  (+ заголовок Metadata-Flavor через параметр headers)
      → токен VM service account (scope cloud-platform)
        → Secret Manager API: versions/access на любой секрет, доступный SA
```

Подтверждено на хосте: как `vova` metadata отдаёт токен; `gcloud secrets versions access
latest --secret=AGENT_SECRET` и `--secret=TELEGRAM_BOT_TOKEN` от имени VM SA **выполняются**
(per-secret IAM; `secrets.list` при этом запрещён). То есть **любой админ-ключ, положенный в
Secret Manager и доступный VM SA, сегодня читается агентом любого профиля** — включая чужих
пользователей бота.

Про «личные Google-креды Вовы» — однозначно **нет**: персональный OAuth/аккаунт не скоупится,
не отзывается точечно, утечка = весь аккаунт и все проекты, плюс ToS-проблемы (личные креды
не должны жить на серверах). Долгоживущий JSON-ключ SA — тоже анти-бест-практис (GCP:
«avoid long-lived service account keys», вместо них short-lived token / WIF / impersonation).

### 2.2 «Другие юзеры без админских прав не получат его?»

**Прямым путём — не получат** (слот не читает ни `secrets.env`, ни `~/.ssh`, ни metadata:
проверено: `ls /home/vova` → Permission denied, `journalctl` → exit 1, `curl metadata` под
слотом → REJECT). **Но косвенным путём — получат**, пока открыты MCP-дыры из §3: любой
профиль может вытащить через MCP-тулы всё, что доступно `vova`, — включая
`/home/vova/secrets.env` (600 `vova:vova`) и токен SA.

Вывод: безопасность ключа определяется не местом хранения (GCP vs диск), а **тем, кто может
достичь идентичности, которая его читает**. Сегодня идентичность `vova` достижима из каждого
профиля через MCP.

### 2.3 «Сможет ли сам агент стать админом ВМ (перезагрузить, логи, настройки)?»

Если ему выдан credential, дающий эти права — **да, по определению**: обладание ключом и есть
это право. Именно поэтому схема ниже выдаёт **не credential, а capability**:

- credential лежит в месте, куда агент не имеет доступа (не в env, не в файлах профиля);
- агент получает **узкий, фиксированный набор операций** («прочитай журнал», «перезапусти
  assist-agent»), а не shell и не ключ;
- каждая операция **логируется** с `USER_ID`/`TASK_ID`;
- опасные операции требуют **подтверждения человека** (JIT / break-glass).

Это ровно паттерн, который в репо уже применён к Claude OAuth
([docs/claude-oauth-refresh.md](claude-oauth-refresh.md)): *refresh-токен не покидает сервисный
дом — агент получает только короткоживущую capability*. Админ-доступ должен устроиться так же.

### 2.4 «Ты юзер какой-то особый?»

Текущее состояние (проверено):

- **Эта сессия** (Session Manager на Mac) работает локально под `vova` на macOS и ходит на ВМ
  по SSH-ключу `~/.ssh/trained-assist-gcp-vm_vova_ed25519` (права 0600) → на ВМ пользователь
  `vova` → `sudo NOPASSWD: ALL`. Это «ключик, который лежит в другом месте» — **вне ВМ**, поэтому
  слоты и MCP-процессы его не видят. Для человека это рабочий путь, его и оставляем (Уровень 0).
- **Раны, рождённые на ВМ** (профильные и инженерные `/run`), ключа не имеют: они спавнятся под
  слотом и по дизайну не должны иметь постоянного root. Именно им нужна схема из §5.

---

## 3. Текущие каналы эскалации (проверено 2026-09-28)

До выдачи любой админки эти дыры закрываются — иначе «ключ в Google» = «ключ у всех».

| # | Канал | Где в коде | Что даёт | Статус |
|---|---|---|---|---|
| 1 | **Arbitrary file read** MCP-тулом: `file_path` не валидируется, читается как `vova` | [src/mcp-skills/tools/94-tg-send.js:152-161](../src/mcp-skills/tools/94-tg-send.js) — `tg_send_file` только `existsSync`, без проверки, что путь внутри `workDir` | выгрузка **любого** файла `vova` в чат: `secrets.env` (600), `.git-credentials`, `~/.ssh/*`, `agent-tokens/*` чужих профилей | open |
| 2 | **SSRF** MCP-тулом: `path` может быть полным URL + произвольные `headers` | [src/mcp-skills/tools/98-api-from-website.js:111-145](../src/mcp-skills/tools/98-api-from-website.js) — `urlPath.startsWith('http') ? urlPath : …`, `...extraHeaders` | запрос **куда угодно** от имени `vova`: metadata → токен SA → Secret Manager (подтверждённый доступ к `AGENT_SECRET`, `TELEGRAM_BOT_TOKEN`) | open |
| 3 | Firewall закрывает **только слоты** | `scripts/ops/agent-isolation-setup.sh`: `-m owner --gid-owner ta-agents` | MCP-серверы (gid `vova`) свободно достают metadata; так и задумано для `04-cron`/`50-gdrive`, но это же делает доступным токен SA | by design, требует компенсаций |
| 4 | Полный env сервиса в MCP-серверах | [src/agent-mcp-bridge.js](../src/agent-mcp-bridge.js) `env: {...engineEnv}`; `mcpToolEnv` содержит `AGENT_SECRET` | любой тул, умеющий читать env/файлы, экспортирует секреты | by design для T0, сузить по мере надобности |

**Prereqs (закрыть до выдачи админки):**

1. `tg_send_file`/`tg_send_photo`: разрешать только пути внутри `WORK_DIR` профиля (+, при
   необходимости, `/tmp` с префиксом рана). Отклонять `/home/vova`, `/proc`, чужие профили.
2. `website_request`: `path` — только относительный путь к `site.url` (один origin);
   жёстко блокировать `169.254.0.0/16`, `127.0.0.0/8`, `10.0.0.0/8`, `metadata.google.internal`
   даже внутри origin. Фиксится в одном файле, тест — отрицательный.
3. (желательно) секреты не раздавать MCP-серверам пачкой, а отдавать по запросу через
   run-token-брокер — как это уже делает claude-refresh-брокер.

---

## 4. Бест-практисы (рессёрч)

| Источник | Суть | Что берём |
|---|---|---|
| [Microsoft: Least privilege for AI agents (2026-07)](https://www.microsoft.com/en-us/security/blog/2026/07/16/least-privilege-for-ai-agents-identity-access-and-tool-binding/) | identity на агента, task-scoped авторизация, привязка прав к инструментам, а не к «пользователю» | право = свойство **тула и профиля**, не unix-юзера |
| [Google Cloud PAM](https://cloud.google.com/iam/docs/pam-overview) / best practices | no standing privilege, just-in-time выдача, approval-workflow, аудит | опасные операции = JIT с подтверждением |
| [agent-sudo (Z7Lab)](https://github.com/Z7Lab/agent-sudo) | root-owned gatekeeper: агент выполняет **allowlist** админ-команд, а не `sudo` | allowlist + wrapper-скрипты с валидацией аргументов |
| [sudoers(5)](https://man7.org/linux/man-pages/man5/sudoers.5.html) | `Cmnd_Alias`, без wildcard в аргументах, логирование в syslog | обёртки в `/usr/local/sbin`, каждый вызов пишется в журнал |
| [GCP: SA keys best practices](https://cloud.google.com/iam/docs/best-practices-for-managing-service-account-keys) / [Secret Manager best practices](https://cloud.google.com/secret-manager/docs/best-practices) | не хранить экспортированные ключи, per-secret IAM, короткоживущие токены | никаких JSON-ключей на ВМ; ключ вообще не должен существовать |
| [GCP: service accounts best practices](https://cloud.google.com/iam/docs/best-practices-service-accounts) | узкие роли, no personal creds, разделение обязанностей | dev ≠ user ≠ service — три разные идентичности |

Общий знаменатель: **no standing privilege + capability вместо credential + аудит + человек
на опасном шаге.**

---

## 5. Рекомендуемая схема: три уровня elevation

```
Уровень 0  человек (Mac)      SSH-ключ вне ВМ → vova → sudo            [уже работает]
Уровень 1  dev-агент READ      MCP-тул sys_admin: только диагностика    [новый, profile-gated]
Уровень 2  dev-AGENT WRITE     те же тулы mutating + approve оператора  [новый, JIT]
Уровень 3  break-glass         reboot / apt / правка unit-файлов        только человек по SSH
```

### Уровень 0 — человек (уже работает, не менять)

SSH-ключ `~/.ssh/trained-assist-gcp-vm_vova_ed25519` живёт на Mac, **не на ВМ**. Ни слот, ни
MCP до него не дотягиваются. Так и остаётся: человек = полный доступ, без изменений.

### Уровень 1 — dev-агент, диагностика (read-only)

Новый MCP-тул `sys_admin` в `src/mcp-skills/tools/` (прецеденты server-side exec в
`62-business-analyst.js` (pandoc), `95-video-analysis.js`):

- **Gate по профилю**: `isReady: () => DEV_PROFILES.includes(process.env.USER_ID)`, где
  `DEV_PROFILES` из env сервиса (по образцу `WEEEK_SESSION_PROFILES`,
  [src/server.js:1373](../src/server.js)). В `mcpToolEnv` уже есть `USER_ID`. Профиль вне
  списка **не видит тул вообще** (не получает даже schema) — это и есть «ключ», привязанный к
  аккаунту разработчика, а не к unix-юзеру.
- **Только фиксированные команды**, исполняются `execFile(argv)` (не shell), как `vova`:
  - `journalctl -u assist-agent -n <N>` (N ≤ 500, санитизация),
  - `systemctl status assist-agent|nginx`,
  - `ss -ltn`, `df -h`, `uptime`, `free -m`, `nginx -t`,
  - `tail` по `/var/log/nginx/*.log`.
- **Аудит**: каждый вызов → строка в журнал (`syslog`/`logger` или append в
  `$AGENT_DATA_DIR/sysadmin-audit.log`) c `USER_ID`, `TASK_ID`, командой.
- Никаких credential: тул исполняет ** доверенная сторона** (`vova` и так имеет sudo),
  слот остаётся без прав. Ключа, который «лежит в другом месте», физически не существует —
  есть только capability, выданная по идентичности профиля.

### Уровень 2 — mutating-операции с подтверждением (JIT)

Тот же тул, отдельный allowlist, но каждая операция сначала уходит оператору
(`OPERATOR_CHAT_ID`, [src/secrets.js:123](../src/secrets.js)) кнопкой
«✅ Выполнить / ❌ Отклонить» (паттерн callback-кнопок уже есть в `answer-actions`):

- `systemctl restart assist-agent` — рестарт дёшев ([docs/instant-restart.md](instant-restart.md)),
  но он прерывает чужие codex/opencode-раны → кнопка, а не автоП;
- `systemctl reload nginx`, `fuser -k <port>` (port ∈ числовой allowlist);
- `systemctl reload assist-agent` после правки drop-in.

После approve команда исполняется сервисной стороной, результат возвращается в ран, всё в аудит.
Агент **никогда не получает** возможность вызвать mutating-операцию напрямую.

### Уровень 3 — break-glass (человек, не агент)

`reboot`, `apt upgrade`, правка unit-файлов, чтение `secrets.env` руками — **вне** выдачи агенту.
Это ровно то, что делает человек по SSH (Уровень 0). Если однажды очень понадобится агенту —
это отдельный design-review, а не «просто добавить в allowlist».

### Альтернатива: unix-пул dev-слотов (обсуждена, не primary)

Отдельный пул `ta-dev-*` + sudoers-allowlist wrapper-скриптов (`/usr/local/sbin/ta-ops-*`),
выдаваемый только ранам из `DEV_PROFILES` (сплит пула в `agent-isolation.js`).

- **Плюс**: работает и из обычного shell агента, не только через MCP-тул.
- **Минус**: requires код в lease-логике (пул сейчас общий для всех профилей — отдать слоту
  sudo нельзя, потому что завтра тот же слот достанется чужому профилю!); больше surface
  (sudoers + обёртки + валидация); обход MCP не закрывает §3-дыры — их надо чистить в любом
  случае.
- Вердикт: **делать вторым шагом**, если level 1–2 не хватит. Главное правило: elevation
  нельзя вешать на текущий общий пул `ta-agent-*` — только на отдельный пул, назначаемый
  по профилю.

### Почему НЕ предлагается «просто дать GCP-креды»

| Вариант | Почему нет |
|---|---|
| SA с ролями типа `compute.admin` / `instanceAdmin` | `instances.setMetadata` = добавить себе SSH-ключ = полный root на ВМ; `stop/start` = перезагрузка. Это и есть «стать админом ВМ», только через API |
| Экспортированный ключ SA в файле/секрете | долгоживущий standing privilege; доступен через §3-каналы; анти-бест-практис GCP |
| Личный Google-креды Вовы | не скоупятся, не отзываются точечно, утечка = весь аккаунт |
| GCP вообще для локальных ops | `journalctl`/`systemctl` — локальные операции, GCP-роли их не дают; GCP нужен только если реально нужны cloud-логи/апи, и тогда — отдельный узкий SA без ключей, **после** закрытия §3 |

---

## 6. Что делать владельцу (порядок шагов)

1. **Закрыть §3-дыры** (prereqs) — до любой выдачи админки:
   - валидация путей в `tg_send_file` (+ тест: `/home/vova/secrets.env` → отказ);
   - origin-lock в `website_request` (+ тест: `http://169.254.169.254/...` → отказ).
2. **Ввести `AGENT_DEV_PROFILES`** в env `assist-agent` (systemd drop-in; список профилей
   разработчика, напр. `kobzevvv,vova` — по решению владельца) по образцу
   `WEEEK_SESSION_PROFILES`.
3. **Реализовать тул `sys_admin`** (level 1: read-only, gate по `USER_ID`, аудит).
4. **Level 2**: mutating-операции + approve-кнопка оператору.
5. **Verification** (негативные тесты обязательны):
   ```bash
   # чужой профиль не видит тул
   sudo -n -u ta-agent-1 su -  # ран для НЕ-dev профиля: тул отсутствует в listTools
   # слот по-прежнему без прав
   sudo -n -u ta-agent-1 sudo -l            # → password required
   sudo -n -u ta-agent-1 journalctl -u assist-agent -n 1 ; echo $?   # → 1
   # metadata по-прежнему закрыта для слота
   sudo -n -u ta-agent-1 curl -s -m2 http://169.254.169.254/ ; echo $?  # → REJECT
   # prereqs закрыты
   # (ran) tg_send_file(/home/vova/secrets.env) → error; website_request(169.254...) → error
   ```
6. **Ретро-ревизия**: раз в квартал пересматривать allowlist level 1–2 и аудит-лог.

Rollback: убрать `AGENT_DEV_PROFILES` из drop-in и перезапустить сервис — тул исчезает для
всех профилей (gate в `isReady`).

---

## 7. Антипаттерны (чего не делать)

- ❌ `NOPASSWD: ALL` слотам, группе `ta-agents` или «временно для теста» — общий пул слотов
  делится между всеми профилями, это мгновенная эскалация для любого пользователя бота.
- ❌ Личные Google/SSH-креды владельца на ВМ или в секрете, доступном VM SA.
- ❌ Экспортированный JSON-ключ SA где-либо на ВМ.
- ❌ Админ-ключ в env MCP-сервера: env читается через `/proc/<pid>/environ` любым тулом,
  который умеет читать файлы от `vova`.
- ❌ Полагаться только на firewall слотов как на единственную границу: MCP — trusted side,
  и capability-поверхность надо ограничивать осознанно (§3, §5).
- ❌ «Просто дать root на время раны» (sudo timestamp, `su`) — lapse = полная компрометация,
  нет ни allowlist, ни аудита по команде.

---

## 8. MCP от имени юзера: перебор всех вариантов (рисеч)

Вопрос владельца: «Может ли MCP исполняться от имени юзера, с которым работает? Можно же
спавнить отдельный процесс в среде юзера — тяжело ли это? А если методы не энаблены — может,
и не тяжело? И при энаблинге можно ли перезапустить процесс с включённым разделом?»

### 8.0 Как устроено сейчас (факты, проверено 2026-09-28)

- Бридж спавнит **отдельный процесс MCP на каждое соединение** движка
  ([src/agent-mcp-bridge.js](../src/agent-mcp-bridge.js) `handleConnection` → `spawn`), убивает
  на закрытии сокета/`unregisterRun`. То есть lifecycle = per-run/per-connection **уже есть** —
  вопрос не «процесс или нет», а **под каким uid и с каким env**.
- Процесс запускается от **сервис-юзера `vova`** с **полным сервисным env**
  (`env: {...engineEnv, AGENT_RUN_TOKEN}` — engineEnv = service-side env до allowlist) плюс
  `mcpToolEnv` (`USER_ID`, `AGENT_SECRET`, `HOME=/home/vova`, ключи INN/GOOGLE и т.д.,
  [src/browser.js:140-162](../src/browser.js)).
- Env тулов **захватывается на уровне модуля** при `require`
  (`const USER_ID/CHAT_ID/BOT_TOKEN = process.env...` в ~15 тулах) — это и есть причина,
  почему процесс обязан быть пер-ран: каждый ран даёт свой `USER_ID`/`AGENT_CHAT_ID`/
  `AGENT_RUN_TOKEN`.
- Реестр читает `SKILLS_RESOLVED` один раз на старте
  ([src/mcp-skills/registry.js:16](../src/mcp-skills/registry.js)); `require` модулей происходит
  **до** проверки hidden (строки 23-24) — скрытые модули загружаются, просто не регистрируются.

**Замеры (хост gcp-main, 16GB RAM):**

| Процесс | RSS | Старт |
|---|---|---|
| trained-skills (`mcp-skills/index.js`) | 58MB | 0.48s |
| hh / engineering / freelance / sales / documents / speech (сиблинги) | 41-47MB каждый | ~0.5s |
| bridge-client (движок ↔ сокет) | ~39MB × N серверов (8 шт = 311MB) | — |
| `npx @playwright/mcp` (глобально установлен) | — | **1.58s** |
| Итого MCP-флот активного рана | **≈640MB** (8 клиентов + 7 серверов) | |
| Свободно RAM | 10.7GB из 16GB | load ~3 |

Вес доминирует **Node baseline'ом (~40MB/процесс)**, а не кодом тулов → главный рычаг =
**количество процессов**, а не «тяжело ли среда».

### 8.1 Механика: спавн «в среде юзера» дёшев, но…

`sudo -n -u ta-agent-N node …` из бриджа — это ~10 строк (`registerRun` запомнить слот,
spawn через sudo). Сudoers **уже разрешает** `vova → ta-agent-* NOPASSWD: ALL`, и env через
sudo проходит (в sudoers есть `Defaults>ta-agent-* !env_reset`). Механически — да, можно.
Дальше четыре блокера, проверенных на хосте:

| # | Блокер | Что ломается | Фикс |
|---|---|---|---|
| 1 | **environ-утечка (главный)**: `/proc/<pid>/environ` = `0400 owner`, `hidepid=0` (проверено). Если uid MCP = uid движка → **движок читает env MCP** | `AGENT_SECRET`, бот-токены, `OPENROUTER/DEEPGRAM/FAL…` напрямую в движок. Сегодня спасает только разница uid (проверено: слот не читает environ vova) | (а) отдельный uid для MCP — но тогда это уже «не в среде юзера»; либо (б) **вывести секреты из env MCP** на серверный брокер по run-token |
| 2 | **Firewall по gid** (`-m owner --gid-owner ta-agents`): MCP-as-slot получает те же ограничения, что движок | metadata закрыта → `04-cron` (GCP Scheduler), `50-gdrive` (refresh токена) падают; localhost-порты закрыты (`BLOCK_PORTS=…8080…9222:9299…`) → `05-session` extend-timeout (8080), `21-browser-session` (CDP) падают | брокер этих 4 вызовов через bridge-сокет (`AGENT_RUN_TOKEN` уже есть; extend-timeout уже принимает run-token — [src/mcp-skills/tools/05-session.js:146](../src/mcp-skills/tools/05-session.js)) |
| 3 | **Token-файлы**: `~/agent-tokens` 750/770 `vova:vova` | 11 тулов с токенами (gdrive, getcourse, nalog, tilda, sites, video…) падают | per-run ACL на `agent-tokens/<profile>` — механика гейтов уже есть, но это расширяет зону, доступную слоту |
| 4 | **HOME**: `HOME=/home/vova` (750) | npm/`npx` кэш, `.cache/ms-playwright` (700 vova) недоступны | HOME → `profile/.agent-home` (уже существует), пер-профильные кэши |

**Главный нюанс:** блокер №1 — не обходится настройкой. Если env MCP остаётся полным,
uid слота для MCP = отдать движку все секреты через `/proc`. Значит безопасный вариант
«MCP в среде юзера» = uid слота **+ обязательный вывод секретов из env на серверный
брокер** (run-token RPC по bridge-сокету). Это уже mini-проект, а не правка spawn'а.

**Но выгода структурная:** при uid=слот **§3-1 и §3-2 умирают сами**: слот не читает
`secrets.env`/`.ssh`/`.git-credentials` (600/700) и firewall режет SSRF→metadata для gid
`ta-agents`. Сравнение с планом §3 (фикс двух тулов): фикс двух тулов дешевле и закрывает
сегодняшние дыри, но не защитит от **следующего** тула с той же ошибкой (touch points vs
defense in depth).

### 8.2 Все варианты

| Вариант | Суть | Плюсы | Минусы | Вердикт |
|---|---|---|---|---|
| **A. uid=слот + серверный брокер привилегий** | spawn через `sudo -u`, секреты и metadata/localhost-вызовы — только через bridge-RPC по run-token | §3-1/§3-2 закрываются **структурно**; env чистый; audit единый | брокер на 4+ вызова, HOME/tokens ACL, env-рефакторинг тулов | **Целевая архитектура**, если хотим isolation, который ломается не только валидацией |
| **B. отдельный общий uid `ta-mcp`** | третий uid: не слот (environ защищён от движка), не vova (не читает 600-файлы) | cron/gdrive/CDP работают (не в gid ta-agents); environ цел | §3 остаётся на уровне тулов; **stale-ACL риск**: один uid на все профили — утечка, если гейт где-то не отозван | Компромисс, если A дорог |
| **C. per-profile mcp-юзеры** | свой юзер на каждый профиль | максимум изоляции | ~80+ профилей: useradd/ACL/журнал на каждый → management hell | Overkill |
| **D. in-process MCP** (реестр в сервере, shim в `.mcp.json`) | убирает все доп. процессы (≈600MB/ран) | ноль спавна, ноль памяти на процессы | требует рефакторинг тулов с module-load env на per-call ctx (≈15 файлов); краш тула = краш сервера; playwright всё равно отдельно | Только если пер-ран спавн станет дорогим |
| **E. статус-кво + фикс двух тулов (§3 prereqs)** | uid не меняем; path-validate в `tg_send_file`, origin-lock в `website_request` | дёшево, ничего не ломает | закрывает сегодняшние дыри, но не будущие (нет defense in depth) | **Сейчас — сразу** |
| **F. sandbox (bwrap / systemd-run --sandbox)** | namespace-изоляция процесса | сильная изоляция без смены uid | в репо нет ни инфраструктуры, ни опыта; тяжело для стека | Не для этого кода |

**Рекомендация:** **E сейчас** (это prereqs §3, они нужны при любом раскладе) → **A как
этап 2**, если захотим structural isolation. B — запасной компромисс. C и F — нет. D — отложить.

### 8.3 «Тяжело ли?» и «а если методы не энаблены?»

- Сам процесс — **не тяжёлый**: 0.48s старт, 45-58MB; вклад тулов минимален, ~40MB — это
  сам Node. Проблема не вес процесса, а **N процессов × M параллельных ранов** (сейчас
  MCP-флот одного рана ≈ 640MB, свободно 10.7GB — терпимо, но масштабируется линейно).
- **Выключенные секции — главный реальный рычаг веса**: скрытые siblings **вообще не
  монтируются** в `.mcp.json` ([src/browser.js:193-195](../src/browser.js)) → их процесс не
  спавнится. Профиль без hh/eng/freelance/sales/documents/speech экономит **≈269MB** на ран
  (6 × 41-47MB) и по одному старту на каждый.
- Две микро-дыры в этом рычаге:
  1. `registry.js` делает `require` **до** проверки hidden (строки 23-24) → скрытые модули
     всё равно загружаются. Фикс в 2 строки: вычислять `hidden` по имени файла до `require`.
  2. **Playwright монтируется всегда** (base config, [src/browser.js:174](../src/browser.js),
     не зависит от секций каталога) → 1.58s `npx` на **каждый** ран, даже если браузер не
     нужен. Кандидат на гейтинг секцией — самая дорогая единица спавна.

### 8.4 «При энаблинге — перезапустить процесс с включённым разделом?»

- **Между ранами — перезапуск не нужен, он уже происходит автоматически.** Конфиг
  (`.mcp.json` + `SKILLS_RESOLVED`) переписывается на каждый ран
  ([src/runner/index.js:1989](../src/runner/index.js) → `writeRunMcpConfig`), бридж спавнит
  свежий процесс на соединение → новый раздел подхватывается **следующим раном**. Комментарий
  в registry прямо фиксирует это design'ом: «the MCP server process is started per run, so it
  always inherits the current flag».
- **Внутри рана — практически нельзя.** stdio-протокол: при смерти ребёнка бридж закрывает
  сокет, движок MCP-сервер не переподключает → сервер потерян до конца рана. Возможные пути:
  1. MCP-специя `notifications/tools/list_changed`: сервер дозагружает модуль и шлёт
     нотификацию → клиент перечитывает список. Поддержка в claude/opencode **не проверена**
     (flag: needs test); в [src/mcp-skills/index.js](../src/mcp-skills/index.js) сейчас
     `notifications` без id просто игнорируются.
  2. Lazy-load: `tools/call` для неизвестного имени пытается дозагрузить модуль + тот же
     list_changed. Работает только при поддержке клиентом.
  3. Практичный дефолт: **для долгих интерактивных сессий — рестарт сессии** (движок читает
     `.mcp.json` на старте); для одноразовых `/run`-ранов — ничего не делать, всё само.
- Итог: «включил секцию → подхватится следующим раном» уже работает **бесплатно**;
  mid-run включение — отдельная фича с зависимостью от поддержки list_changed клиентами.

### 8.5 Резюме ответа

Да, отдельный процесс «в среде юзера» спавнится почти даром (механика уже готова), но
**«среда юзера» ≠ «uid юзера»**: безопасный пер-профильный процесс = отдельный uid **плюс**
вывод секретов из env, брокер metadata/localhost и гейты — это этап, а не правка. Дешевле
сначала закрыть §3-дыры (вариант E), а uid-переезд делать как этап 2 по варианту A. Вес
секциями уже управляется (siblings не спавнятся), осталось починить require-before-hidden и
погейтить playwright; перезапуск при энаблинге между ранами не требуется — он уже есть.

---

## 9. Связанные материалы

- [docs/agent-process-isolation.md](agent-process-isolation.md) — T0-изоляция, что закрыто сейчас
- [docs/claude-oauth-refresh.md](claude-oauth-refresh.md) — паттерн «credential не покидает сервис»
- [docs/server-ops-playbook.md](server-ops-playbook.md) — какие ops реально нужны сисадмину
- [docs/instant-restart.md](instant-restart.md) — почему рестарт дёшев, но всё равно mutating
- Issues: [#1649](https://github.com/trained-assist/trained-assist-agent/issues/1649) (изоляция),
  [#1660](https://github.com/trained-assist/trained-assist-agent/issues/1660) (git-креды),
  [#1704](https://github.com/trained-assist/trained-assist-agent/issues/1704) (логирование sudo),
  [#1762](https://github.com/trained-assist/trained-assist-agent/issues/1762) (реестр слабостей —
  кандидаты §3-1 и §3-2 для записи)
