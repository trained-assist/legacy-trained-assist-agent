# Skills Roadmap — trained-assist-agent

Last updated: 2026-09-26

> **Migration status moved.** Where each domain skill is *served* (core vs
> domain repo) is tracked in:
> [`docs/migration/domain-skill-migration.md`](migration/domain-skill-migration.md)
> (tracked by [#1470](https://github.com/trained-assist/trained-assist-agent/issues/1470)).
> This page remains the feature/auth/inventory roadmap; it must not contradict
> the matrix.

---

## Current Skills (already implemented)

| File | Skill ID | Status | Auth |
|------|----------|--------|------|
| `00-meta.js` | — | ✅ done | — |
| `10-nalog.js` | `nalog-npd` | ✅ done | Bearer token (Chrome ext → token-relay) |
| `20-tilda.js` | `tilda-site-ops` | ✅ done | Cookie string (Chrome ext → capture) |
| `21-browser-session.js` | `browser-session` | ✅ done | — (VM Chrome always running) |

**Token storage pattern**: `~/agent-tokens/{USER_ID}/{label}` — plain file, read by skill via `USER_ID` env injected per-session in `.mcp.json`.

**Weeek token is already partially integrated** — `loadUserTokens` in `runner.js` auto-maps many token labels to env vars (GITHUB_TOKEN, FIGMA_TOKEN, etc.) but Weeek is not yet mapped. Adding `weeek` label → `WEEEK_API_TOKEN` env var is trivial.

---

## Planned Skills

### 1. Weeek CRM (`30-weeek.js`)

| Property | Value |
|----------|-------|
| Status | **partial** — all API patterns exist in flexi-crm-automation |
| Auth | Bearer token (permanent API token from Weeek settings) |
| Complexity | **low** (1 day) |
| Blocker | runner.js doesn't map `weeek` label → `WEEEK_API_TOKEN` env yet |

**Known endpoints** (extracted from flexi-crm-automation scripts):
```
GET  /crm/funnels/{funnelId}          — воронка
GET  /crm/funnels/{funnelId}/statuses — статусы в воронке
GET  /crm/statuses/{statusId}/deals   — сделки по статусу (пагинация)
GET  /crm/deals/{dealId}              — одна сделка
PATCH /crm/deals/{dealId}             — обновить поля сделки
GET  /crm/deals/{dealId}/contacts     — контакты сделки
GET  /crm/deals/{dealId}/tasks        — задачи сделки
POST /crm/deals/{dealId}/contacts     — привязать контакт
GET  /crm/contacts                    — список (query: search, limit)
GET  /crm/contacts/{id}               — один контакт
PATCH /crm/contacts/{id}              — обновить контакт
GET  /crm/organizations               — организации
GET  /crm/organizations/{id}          — одна организация
PATCH /crm/organizations/{id}         — обновить организацию
POST /crm/organizations/{id}/contacts — привязать контакт к организации
GET  /crm/custom-fields               — список доп. полей
POST /crm/custom-fields               — создать поп. поле
```

**Token expiry**: Weeek API tokens are permanent (не протухают). Это решает проблему пользователя — достаточно задать токен один раз.

**Implementation plan**:
1. `runner.js`: добавить `weeek` → `WEEEK_API_TOKEN` в `loadUserTokens`
2. `30-weeek.js`: tools: `weeek_list_deals`, `weeek_get_deal`, `weeek_update_deal`, `weeek_list_contacts`, `weeek_get_contact`, `weeek_update_contact`, `weeek_status`
3. `00-meta.js`: добавить скилл в SKILLS registry

---

### 2. GetCourse (`31-getcourse.js`)

| Property | Value |
|----------|-------|
| Status | **not-started** (existing code uses Playwright, not REST API) |
| Auth | `account` + `key` query params (permanent API key from account settings) |
| Complexity | **medium** (2 days) |
| Blocker | GetCourse public API НЕ поддерживает создание/редактирование курсов и уроков — только импорт/экспорт пользователей и заказов |

**What the public API CAN do** (https://getcourse.ru/help/api):
```
GET  /{account}/pl/api/users            — список пользователей
POST /{account}/pl/api/users/add        — добавить пользователя / обновить
GET  /{account}/pl/api/orders           — список заказов
GET  /{account}/pl/api/payments         — платежи
GET  /{account}/pl/api/groups           — группы (доступ к курсам)
POST /{account}/pl/api/groups/add-user  — выдать доступ к группе
POST /{account}/pl/api/groups/remove-user — убрать доступ
```

**What the API CANNOT do** (verified in prepare-getcourse-import.js comment):
> "В публичной документации API GetCourse описан импорт пользователей и заказов, экспорт пользователей/групп/заказов/платежей, но **не создание тренингов и уроков**."

Для создания/редактирования курсов, загрузки видео, управления ценами — нужен Playwright (браузерная автоматизация), что сложнее и ломается при обновлениях GetCourse UI.

**Recommendation**: реализовать в два слоя:
- `31-getcourse.js` — REST API инструменты (пользователи, заказы, группы/доступы)
- Управление курсами — отдельный `32-getcourse-browser.js` через браузерную сессию (browser-session skill + Playwright)

---

### 3. Video Tools (`40-video.js`)

| Property | Value |
|----------|-------|
| Status | **partial** — ffmpeg и Deepgram есть, yt-dlp нет |
| Auth | Deepgram API key (уже в secrets) |
| Complexity | **medium** (2 дня) |
| Blocker | yt-dlp не установлен на VM |

**VM tool inventory** (проверено ssh):
```
ffmpeg   ✅ v4.4.2 (установлен)
python3  ✅ (установлен)  
node     ✅ v20.20.2 (установлен)
yt-dlp   ❌ НЕ УСТАНОВЛЕН — нужно: pip3 install yt-dlp
```

**Planned tools**:
```
video_download(url, output_dir)              — yt-dlp скачать видео
video_transcribe(file_path)                  — Deepgram → JSON с таймкодами
video_find_phrase(file_path, phrase)         — транскрипт + поиск → таймкоды
video_cut_segment(file, start, end, output)  — ffmpeg нарезка
video_make_reels(file, segments[])           — ffmpeg конкатенация нескольких сегментов  
voice_transcribe(ogg_file)                   — Deepgram OGG/OGA → текст (голосовые TG)
```

**Voice messages from Telegram**: Telegram отдаёт `.oga`/`.ogg` (Opus codec). Deepgram поддерживает OGG Opus напрямую — конвертация не нужна.

**Install step before implementing**:
```bash
ssh vova@136.65.7.197 'pip3 install yt-dlp'
```

---

### 4. Wordstat / Yandex Search API (`50-wordstat.js`)

| Property | Value |
|----------|-------|
| Status | **partial** — рабочий код есть в efimova-school |
| Auth | Yandex Cloud IAM token (временный, нужен `yc` CLI или SA key) |
| Complexity | **high** (3 дня) — сложность в auth |
| Blocker | IAM токен живёт ~1ч, нужен механизм обновления |

**API** (не старый wordstat.yandex.ru, а Yandex Cloud Search API):
```
POST https://searchapi.api.cloud.yandex.net/v2/wordstat/topRequests
Body: { phrase, numPhrases, regions, devices, folderId }
Auth: Bearer {iam_token}
```

**Existing implementation** (efimova-school): `collect-wordstat-competitors.mjs` — работает, использует `yc iam create-token` для получения токена.

**Auth options**:
- A) Service Account key (JSON) → программно получаем IAM токен через SA (долгоживущий ключ, токен обновляется автоматически) — **рекомендуется**
- B) `yc` CLI установлен на VM — можно вызывать напрямую, но зависит от конфигурации YC CLI

**Limits**: 100 запросов в день бесплатно на аккаунт. Нужен лимитер на уровне скилла (хранить счётчик в ~/agent-tokens/{userId}/wordstat-usage).

**Recommendation**: Реализовать после Weeek и GetCourse (более сложный auth).

---

### 5. Yandex Metrica (`51-metrica.js`)

| Property | Value |
|----------|-------|
| Status | **not-started** |
| Auth | OAuth token (пользователь авторизует через Яндекс OAuth) |
| Complexity | **medium** (1.5 дня) |
| Blocker | Нужен OAuth app в Яндексе + процесс получения токена пользователем |

**API**:
```
GET https://api-metrika.yandex.net/stat/v1/data
  ?ids={counter_id}
  &metrics=ym:s:visits,ym:s:pageviews
  &dimensions=ym:s:trafficSource
  &date1=2026-01-01&date2=2026-08-30
  &limit=100
Header: Authorization: OAuth {token}
```

**Token flow**:
1. Пользователь открывает ссылку авторизации Яндекс OAuth
2. Получает токен (живёт долго, если не отозвать)
3. Сохраняем в ~/agent-tokens/{userId}/yandex-oauth

**Key metrics**: `ym:s:trafficSource` → organic/paid/direct/referral. Counter IDs хранятся в конфиге пользователя.

---

### 6. Google Search Console (`52-search-console.js`)

| Property | Value |
|----------|-------|
| Status | **not-started** |
| Auth | Google Service Account или User OAuth |
| Complexity | **medium** (1.5 дня) |
| Blocker | Нужен Google Cloud project + Search Console API enabled |

**API**:
```
POST https://searchconsole.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query
Body: { startDate, endDate, dimensions: ["query","page"], rowLimit: 1000 }
Auth: Bearer {oauth_token}
```

**Reuse gated-knowledge auth**: `gated-knowledge` уже имеет Google OAuth с DWD. Но Search Console нужен отдельный scope (`https://www.googleapis.com/auth/webmasters.readonly`). Возможно, нужно добавить scope к существующему SA или создать отдельный OAuth.

**Metrics**: clicks, impressions, CTR, position — по запросам и страницам.

---

### 7. Company Enrichment (`60-company.js`)

| Property | Value |
|----------|-------|
| Status | **partial** — rusprofile-http.mjs полностью готов |
| Auth | None (rusprofile — scraping); DaData — API key (paid) |
| Complexity | **low** (1 день) |
| Blocker | Нет — можно реализовать сразу с rusprofile |

**Existing implementation** (flexi-crm-automation/scripts/company-enrichment/):
- `rusprofile-http.mjs` — полноценный HTTP клиент с парсингом HTML, кэшированием (7 дней), rate limiting
- `RusprofileClient` class: `.search(query)`, `.byInn(inn)`, `.enrichByInn(inn)`, `.enrichByName(name)`
- Возвращает: `inn`, `kpp`, `ogrn`, `name`, `fullName`, `ceoName`, `statusText`, `registrationDate`, `region`, `address`, `okved`, `contacts: {phones, emails, sites}`, `finance`

**Plan**: скопировать `rusprofile-http.mjs` в `src/mcp-skills/lib/`, написать обёртку:
```
company_find_by_name(query)   — поиск → список компаний с ИНН
company_get_by_inn(inn)       — по ИНН → полные данные (руководитель, адрес, выручка, контакты)
company_enrich(inn_or_name)   — умный поиск + обогащение
```

**DaData**: добавить позже как `company_find_by_email(email)` — платная операция, нужен API key.

---

## Priority Order

| Priority | Skill | Reason |
|----------|-------|--------|
| 🔥 1 | **Weeek CRM** | Решает реальную боль (протухающие сессии), API простой, код уже есть |
| 🔥 2 | **Company Enrichment** | Код готов (rusprofile), просто обернуть — 1 день |
| ⚡ 3 | **GetCourse (users/orders)** | Частичная реализация через REST API |
| ⚡ 4 | **Video Tools** | Нужно только установить yt-dlp + написать обёртки |
| 📅 5 | **Yandex Metrica** | Auth требует настройки OAuth app |
| 📅 6 | **Wordstat** | Auth сложный (IAM token lifecycle) |
| 📅 7 | **Search Console** | Auth требует Google project настройки |

---

## Test User Setup

### Как создать тестового пользователя

Тестовый юзер создаётся через HTTP API (не нужен Telegram):

```bash
# На VM (или через curl к deployed серверу)
curl -X POST http://localhost:3000/run \
  -H "Authorization: Bearer $AGENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": 99999999,
    "username": "testuser",
    "task": "Напиши привет и список доступных скиллов",
    "context": "Тестовый пользователь"
  }'
```

Это создаёт `~/agent-data/sessions/testuser/` и первый запуск Claude.

### Токены для тестового юзера

```bash
# На VM:
mkdir -p ~/agent-tokens/99999999

# Weeek (когда реализуем): взять токен из Settings → API в weeek.net
echo "YOUR_WEEEK_TOKEN" > ~/agent-tokens/99999999/weeek

# Company enrichment: не нужен токен (rusprofile scraping)

# Nalog: нужен Chrome extension (не тестируется без него)
```

### Что можно тестить прямо сейчас (без внешних токенов)

| Скилл | Тестируемо без токенов? |
|-------|------------------------|
| `list_skills` | ✅ да — просто вызов |
| `browser_session_status` | ✅ да — проверяет CDP |
| `browser_session_url` | ✅ да |
| Company enrichment (после реализации) | ✅ да — rusprofile не требует auth |
| Video transcribe (голосовая) | ✅ да — DEEPGRAM_API_KEY уже в secrets |
| Weeek | ❌ нужен API токен |
| GetCourse | ❌ нужен account/key |
| Nalog | ❌ нужен Chrome extension |
| Metrica | ❌ нужен OAuth |
| Search Console | ❌ нужен OAuth |

### Тест MCP skills без Telegram бота

```bash
# Локально на VM — проверить что MCP сервер стартует без ошибок
USER_ID=99999999 WORK_DIR=/tmp/test node src/mcp-skills/index.js

# Должен вывести: {"jsonrpc":"2.0","result":{"protocolVersion":"2024-11-05",...}}
# после чего ждёт stdin
```

### End-to-end тест через curl

```bash
# 1. Запустить сервер локально (dev)
npm run dev

# 2. Отправить тестовую задачу
curl -s -X POST http://localhost:3000/run \
  -H "Authorization: Bearer test-secret" \
  -H "Content-Type: application/json" \
  -d '{"userId":99999999,"username":"testuser","task":"Вызови list_skills и выведи результат"}'

# 3. Смотреть логи в терминале сервера
```

---

## Implementation Notes

### Token label → env var mapping (runner.js:loadUserTokens)

Нужно добавить строки для новых скиллов:

```js
else if (label === 'weeek')          extra.WEEEK_API_TOKEN = val;
else if (label === 'getcourse')      extra.GETCOURSE_API_KEY = val;
else if (label === 'yandex-oauth')   extra.YANDEX_OAUTH_TOKEN = val;
else if (label === 'yandex-sa')      extra.YANDEX_SA_KEY = val;  // JSON, для Wordstat/Metrica
else if (label === 'gsc-token')      extra.GSC_OAUTH_TOKEN = val; // Google Search Console
else if (label === 'dadata')         extra.DADATA_API_KEY = val;
```

### Файл нумерации скиллов

```
00-meta.js           — registry
10-nalog.js          — НПД чеки
20-tilda.js          — Tilda site ops
21-browser-session.js— Remote Chrome
30-weeek.js          — Weeek CRM        ← next
31-getcourse.js      — GetCourse users  ← next
40-video.js          — Video tools      ← next
50-wordstat.js       — Yandex Wordstat
51-metrica.js        — Yandex Metrica
52-search-console.js — Google Search Console
60-company.js        — Company enrichment (rusprofile + DaData)
```
