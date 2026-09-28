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

## 8. Связанные материалы

- [docs/agent-process-isolation.md](agent-process-isolation.md) — T0-изоляция, что закрыто сейчас
- [docs/claude-oauth-refresh.md](claude-oauth-refresh.md) — паттерн «credential не покидает сервис»
- [docs/server-ops-playbook.md](server-ops-playbook.md) — какие ops реально нужны сисадмину
- [docs/instant-restart.md](instant-restart.md) — почему рестарт дёшев, но всё равно mutating
- Issues: [#1649](https://github.com/trained-assist/trained-assist-agent/issues/1649) (изоляция),
  [#1660](https://github.com/trained-assist/trained-assist-agent/issues/1660) (git-креды),
  [#1704](https://github.com/trained-assist/trained-assist-agent/issues/1704) (логирование sudo),
  [#1762](https://github.com/trained-assist/trained-assist-agent/issues/1762) (реестр слабостей —
  кандидаты §3-1 и §3-2 для записи)
