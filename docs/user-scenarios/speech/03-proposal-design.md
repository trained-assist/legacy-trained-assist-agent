# Speech Ф0 — proposal / design / срезы / проверка / откат

**Что это.** Шаг `propose-change` плана `95a7ec89` (Step 4/15). Наименьшее изменение,
закрывающее сценарий `01-speech-transcribe.md` (Ф0 «репка с 1 инструментом»), с заранее
определённым способом проверки и откатом. Документ должен быть достаточен, чтобы
другой агент реализовал Ф0 без вопросов.

**Вход:** `speech-epic-2026-09-28.md`, `speech-tooling-inventory-2026-09-28.md` (проект
`dev-agent-engines-mcp-gtd`), `01-speech-transcribe.md`, `02-requirements-flags.md`
(этот репозиторий).

**Обязательный процессный контекст (проверен на диске, не по памяти):**
- `docs/how-to-move-a-tool-to-a-domain-repo.md` — рецепт выноса (эпик #1470).
- `docs/domain-skill-repo-test-rules.md` — **обязательный минимум с 2026-09-28**:
  `npm run check`, юнит-тесты без сети/LLM, в CI `node <core>/scripts/check-mcp-conformance.js .`,
  таймауты на внешний HTTP, файлы токенов `0o600`, никаких `require` к ядру.
- Эталон формы: **`trained-assist-sales-skill`** (лёгкий), а не hh-skill (тяжёлый L1–L3 + replay).
- Гейты, которые реально запускает прод: `scripts/check-mcp-conformance.js` и
  `scripts/check-skill-schedule.js` (`scripts/deploy.sh:114-115`), плюс
  `scripts/check-skill-contract.js` из задачи.

---

## 1. Proposal

### 1.1 Зачем (сценарий + ценность)
Пользователь присылает голосовое/аудио/видео или файл/ссылку — распознавание выполняет
**один** общий инструмент `speech_transcribe`. Сейчас один и тот же вызов
`Deepgram nova-2 + language=ru + smart_format=true` скопирован в 6 мест (инвентарь §1);
ядро (`95-video-analysis.js`) содержит и движок (как распознавать), и обвязку (ffmpeg,
ledger, чейн в `interview_analyze`). Ценность Ф0 — платформенная: будущие фазы (роли,
словарь, конспект звонка, единый стандарт для шлюза) расширяют **один контракт**, а не
правят каждое место. Внешней пользовательской ценности вынос не добавляет (V1) —
единственная измеримая ценность: **не деградировать** текущее распознавание.

### 1.2 Что меняется
1. Появляется новый **публичный** sibling-репозиторий `trained-assist-speech-skill`
   (форма `trained-assist-sales-skill` + манифесты из формы hh-skill) с тремя
   инструментами: смысловой `speech_transcribe` + сервисные `speech_set_key`,
   `speech_status`.
2. Ядро `src/mcp-skills/tools/95-video-analysis.js` теряет **движок** распознавания:
   `deepgramTranscribe`, `loadDeepgramKey`, `keyDir`, `KEY_FILE` удаляются; ядро
   делегирует в сиблинг через `siblingLib` и оставляет себе ffmpeg-обвязку (`-vn`,
   mono 16k, opus 24k), durable-ledger и чейн в `interview_analyze`.
3. Ядро регистрирует сиблинг в шести местах (см. §2.6).
4. `video_set_deepgram_key` остаётся в ядре как тонкая обёртка-алиас над
   `speech_set_key` (обратная совместимость T6).

### 1.3 Влияние
| Область | Влияние |
|---|---|
| Модули ядра | `95-video-analysis.js` (правка), `src/skill-siblings.js`, `config/skill-catalog.json`, `scripts/deploy.sh`, `src/playbook-store.js`, `.github/workflows/ci.yml`, тесты (см. §2.6) |
| Внешний контракт | `video_analyze_batch` / `video_analysis_status` — **не меняется** (T7/T10) |
| Новый контракт | `speech_transcribe` / `speech_set_key` / `speech_status` (MCP, новый sibling-сервер `speech-skills`) |
| Данные | путь ключа **не меняется** (`~/agent-tokens/<USER_ID>/deepgram/key.txt`) → миграции нет; добавляется `calls.json` рядом (метаданные вызовов, PII нет) |
| Другие сервисы | Deepgram (тот же endpoint/параметры), tg-bot шлюз, `misha-bot.js`, `server.js` — **не трогаем** (Ф4/эпик) |
| Риск для прода | ядро начинает зависеть от внешнего репозитория; закрыто жёстким требованием checkout'а в `deploy.sh` (§2.6) + типизированной ошибкой + staging |

---

## 2. Design (наименьшее изменение)

### 2.1 Новый репозиторий `trained-assist-speech-skill`
Орг `trained-assist`, **public** (см. §2.8). Структура — по sales-skill + имена из задачи:

```
package.json                  # scripts: check, test, build:manifest, manifest:check
src/mcp-skills/index.js       # stdio JSON-RPC сервер (копия sales-skill; serverInfo name 'trained-skills')
src/mcp-skills/registry.js    # авто-discover tools/, SERVER_ID='speech-skills', setupTools, hiddenModules(SKILLS_RESOLVED)
src/mcp-skills/tool-result.js # непустой ответ на пустой результат (agent#1481)
src/mcp-skills/tools/10-speech.js   # ЕДИНСТВЕННЫЙ файл тулов: speech_transcribe/set_key/status
src/data-paths.js             # tokensRoot(): AGENT_TOKENS_DIR || AGENT_TOKENS_ROOT || ~/agent-tokens (своя копия, ядро не require'им)
src/deepgram/client.js        # единственный клиент Deepgram (таймаут, ретрай, host-override)
src/audio/source.js           # локальный путь / http(s) / Яндекс.Диск → локальный файл; MIME; видео-гард
src/audio/mime.js             # расширение+магия → Content-Type; отказ на видео-контейнерах
scripts/build-manifest.cjs    # provider-manifest.json + action-provider-manifest.json (POLICY, DEFAULT_POLICY)
scripts/speech-smoke.cjs      # live-смоук: пара intake audio↔transcript, similarity ≥ 0.9
provider-manifest.json        # генерируется
action-provider-manifest.json # генерируется
tests/contract/*.test.js      # контракт MCP-конверта, вход/выход, ошибки, ключ, mime, source
tests/unit/*.test.js          # парсинг ответа Deepgram, нормализация, calls.json
tests/helpers/stub-deepgram.cjs  # loopback-заглушка Deepgram
docs/skill-ci.md              # что именно проверяет CI скила (по sales-skill + core-гейт)
.github/workflows/ci.yml      # npm ci → npm run check → npm test → manifest:check → core check-mcp-conformance.js
.gitignore, README.md
```
Каждый `tools/*.js` экспортирует `{ tools, isReady, setupTools }` (контракт
`scripts/check-skill-contract.js`). Все три имени — один префикс `speech_`.

`isReady: () => true` **всегда** (инструмент виден и без ключа, чтобы Юзер мог его
настроить); отсутствие ключа даёт типизированную ошибку, а не «Unknown tool».

### 2.2 Контракт `speech_transcribe`
Вход:
```json
{ "source": "…", "language": "ru", "model": "nova-2", "keywords": [], "diarize": false }
```
- `source` (required): локальный путь | http(s) URL | публичная ссылка Яндекс.Диска.
- `language` (optional, default `"ru"`): язык или `"auto"` → `detect_language=true`.
- `model` (optional, default `"nova-2"`; в Ф0 не используется как выбор движка, оставлен параметром вызова).
- `keywords` (optional, **default `[]`**), `diarize` (optional, **default `false`**) —
  зарезервированы под Ф1/Ф2. В Ф0 при `diarize === true` или непустом `keywords`
  инструмент возвращает **типизированную ошибку** `feature_disabled` (НЕ молчаливый
  no-op): пользователь не должен думать, что диаризация применилась.

Выход (ровно эти поля):
```json
{ "text": "…", "duration": 312.4, "language": "ru", "cost_hint": {…} }
```
- `text` — непустая строка; та же выборка, что в ядре сейчас:
  `results.channels[0].alternatives[0].paragraphs?.transcript || alternatives[0].transcript`.
- `duration` — `metadata.duration` (сек, number | null, если Deepgram не отдал).
- `language` — фактический язык запроса (`"ru"`/переданный/`"auto"`).
- `cost_hint` — `{ model, duration_sec, note }`; **цену не выдумываем**: для Nova-2 она
  не публикуется, поэтому в `note` прямо это написано (+ ориентир Nova-3 $0.258/час из
  эпика). Никаких «примерно $0.0012».
- `segments`/`speakers` в Ф0 **отсутствуют**; их форма проектируется в Ф1 (challenge B).

Параметры запроса к Deepgram — **точно как сейчас в ядре** (чтобы не деградировать T10):
`model=nova-2`, `smart_format=true`, `punctuate=true`, `paragraphs=true`,
`language=ru` (или `detect_language=true` при `language="auto"`). Шлюз
(`trained-assist-tg-bot`) сейчас зовёт без `punctuate/paragraphs`, но берёт тот же
`alternatives[0].transcript` — сравнение в смоуке нормализуется (см. §5, R3).

Таймаут HTTP: 300 000 мс на попытку; **1 ретрай** на сетевой сбой/таймаут/5xx (пауза
1 с), затем ошибка `upstream_error`. Тестовая задвижка: host переопределяется
`DEEPGRAM_API_HOST` (default `api.deepgram.com`) — чтобы контрактный тест мог поднять
loopback-заглушку без секрета и без сети. Задвижка задаётся только env-ом сервиса,
наружу не торчит.

Ошибки — типизированные, без стектрейса (`{error, hint}` — как сейчас в ядре):
`key_missing`, `feature_disabled`, `unsupported_source` (видео-контейнер: `.mp4 .mkv
.mov .avi .wmv .flv .m4v .mpeg .mpg`), `unsupported_format` (не распознали тип),
`source_unavailable` (404/таймаут скачивания), `audio_empty` (Deepgram вернул пустой
текст), `upstream_error`.
`source = URL/Яндекс.Диск` качается во временный файл и **удаляется в `finally`**
(Шаг 2 сценария).

**Аудио-only** (T9, challenge A): ffmpeg в маленькую репку НЕ тащится; прямой видео-вход
→ `unsupported_source` с подсказкой «передайте аудио; видео декодирует
`video_analyze_batch`».

### 2.3 `speech_set_key` / `speech_status`
- `speech_set_key({key})` → пишет `tokensRoot()/<USER_ID>/deepgram/key.txt` **mode 0o600**
  (тот же путь, что у ядра T4/R2 — миграции нет), отвечает `{saved:true, path, hint}`.
  `USER_ID` — из env (MCP-раннер кладёт его в env сервера: `src/browser.js:142`).
- `speech_status()` → `{key_present, last_calls: []}`; без ключа не бросает (T5),
  `hint` намекает вызвать `speech_set_key`. `key_present` — только факт, **не значение**.
- `last_calls` — durable журнал **метаданных** (не текста): `tokensRoot()/<USER_ID>/deepgram/calls.json`,
  `[{at, ok, duration_sec, chars, error?}]`, кольцо на 50 записей, атомарная запись.
  Пишется из `speech_transcribe`. PII в журнал не попадает (только длина текста).

### 2.4 Легаси-алиас `video_set_deepgram_key` (T6)
Живёт **в ядре**, в `95-video-analysis.js`, как 3-строчная обёртка над
`speech_set_key`. Причины: (1) имя осмысленно только вместе с `video_analyze_batch`
(ядро и так описывает их рядом); (2) имена тулов **не должны** дублироваться между
репо — `mcp-action.js` считает это CONFLICT, а `check-skill-contract.js` ругается на
несколько префиксов в одном репо; (3) если сиблинга на хосте нет, ядро отдаёт понятную
ошибку `speech_skill_unavailable`, а не «Unknown tool».
`video_analysis_status.deepgram_key_set` и `hint` берутся из `speech_status().key_present`.

### 2.5 Делегирование в ядре
В `95-video-analysis.js`:
```js
const { presentSiblings } = require('../../skill-siblings');
const { siblingLib } = require('../../domains/sibling-lib');
const SPEECH_TOOL_MODULE = 'src/mcp-skills/tools/10-speech.js';

function speechTools() {                       // guard как hhAvailable(): нет checkout — понятная ошибка
  if (!presentSiblings().some(s => s.id === 'speech')) {
    return { error: 'speech_skill_unavailable',
      hint: 'Sibling trained-assist-speech-skill не подключён на хосте (deploy.sh ensure_sibling).' };
  }
  return siblingLib('speech', SPEECH_TOOL_MODULE).tools;
}
```
- `video_analyze_batch`: ключ проверяется через `speech_status`; вместо
  `deepgramTranscribe(key, audioBuf, lang)` → `speech_transcribe({ source: audioPath, language })`
  (передаём **путь**, а не буфер: чтение файла — забота скила).
- `resolveSource`/`extractAudio`/ledger/`interviewAnalyze` — без изменений.
- Никакого `https.request` к Deepgram, `keyDir`, `KEY_FILE`, `loadDeepgramKey` в файле
  не остаётся (это и проверяет Шаг 3 сценария грепом).
- Если `speech_transcribe` недоступен, `video_analyze_batch` кладёт ошибку в
  `r.error`/ledger (как сейчас) — пачки не «съедаются» молча.

### 2.6 Регистрация сиблинга (все точки обязательны; часть пинится тестами)
| # | Файл | Что добавить |
|---|---|---|
| 1 | `src/skill-siblings.js` | `{ id:'speech', repo:'trained-assist-speech-skill', mcpServerId:'speech-skills' }` |
| 2 | `config/skill-catalog.json` | `servers`: `"speech-skills": {"kind":"sibling","repo":"trained-assist-speech-skill"}`; в секцию `recruiting/interview` — `"siblings": ["speech-skills"]` |
| 3 | `scripts/deploy.sh` | `SPEECH_SKILL_DIR="${SPEECH_SKILL_DIR:-$AGENT_HOME/trained-assist-speech-skill}"` + `ensure_sibling trained-assist-speech-skill "$SPEECH_SKILL_DIR"` + жёсткая проверка checkout'а (как documents-skill, `deploy.sh:157-158`): без него ядро не умеет распознавать → деплой отказывает, предыдущий релиз продолжает работать |
| 4 | `.github/workflows/ci.yml` | репо в **оба** цикла клонирования сиблингов (строки 28 и 61) |
| 5 | `src/playbook-store.js` | репо в `DEFAULT_SIBLING_REPOS` (требует `test/sibling-wiring.test.cjs`) |
| 6 | `tests/skill-contract.test.js` | репо в цикл `checkMcpConformance` (когда CI его клонирует) |
Тесты, которые нужно обновить под 1–5 (сами поймают пропуск):
`test/sibling-wiring.test.cjs` (4 проверки), `test/skills-resolve.test.cjs`
(ожидаемые массивы `res.siblings` в legacy-режиме и `preview.hides.siblings`),
`test/live-dir-deploy.test.cjs` (авто-пин `ensure_sibling <repo> "$X_DIR"`).
Почему не проще: это ровно те шесть «точек загрузки», из-за которых
documents-skill стоял построенным, но недоступным (`test/sibling-wiring.test.cjs`, шапка).

### 2.7 Видимость: почему секция `recruiting/interview`
Сервер монтируется в `.mcp.json` только если его называет секция каталога
(`src/skills/resolve.js`: `section.siblings` / `<server>/<file>` в `modules`). Ставим
`speech-skills` в `recruiting/interview` — та же секция, где уже лежит
`95-video-analysis.js` и `hh-skills/99-interview-analysis.js`. Значит доступность
речевого инструмента ровно совпадает с доступностью видео-цепочки: легаси-профили видят
всё, профили с `skills.json` получают речь тогда же, когда интервью-инструменты
(в т.ч. дефолт аудитории `recruiter → enabled: ["recruiting"]`).
**Почему не заводить отдельную секцию `speech`:** новая секция с `always:false` не
включается ни у одного профиля с `skills.json`, кроме тех, кто явно её включит → речь
молча исчезла бы у части профилей. Выделение в свою секцию — правка только каталога,
когда Ф4/Ф5 сделают речь самостоятельным доменом (обратимо, дёшево).

### 2.8 Правка решения R4: репозиторий **public**, не private
`02-requirements-flags.md` (R4) записал «private» — это гипотеза шага 1, а не указание
владельца. Факты с диска: все пять существующих сиблингов **публичные**
(`git ls-remote https://github.com/trained-assist/trained-assist-{hh,sales,documents}-skill.git`
работает анонимно), и оба CI-цикла клонируют их **без токена** — приватный репозиторий
сделал бы обязательный `staging-gate` красным, а `GITHUB_TOKEN` доступа к чужому репо в
орге не даёт (нужен был бы отдельный PAT). Владелец просил «по образцу hh-skill» —
поэтому **public**. Секретов в репо нет by design (ключ живёт в `agent-tokens`).

### 2.9 Манифесты действий
`scripts/build-manifest.cjs` по образцу hh-skill: `POLICY` на 3 тула + консервативный
`DEFAULT_POLICY` (`write`/`requiresApproval:true`/`unsafe`/`user`), чтобы новый тул не
унаследовал разрешительную политику просто по факту существования.
- `speech_transcribe` — `effect:'write'`, `requiresApproval:false`, `retrySafety:'idempotent'`,
  `allowedTriggers:['user']` (не делаем распознавание планируемым из cron в Ф0).
- `speech_set_key` — `write` / `false` / `idempotent` / `['user']`.
- `speech_status` — `read` / `false` / `read_only` / `['user','cron','durable_task']`.
`provider-manifest.json` (с `description`) и `action-provider-manifest.json` (без
`description` — строгий core-дескриптор) генерируются; CI: `npm run manifest` и
`git diff --exit-code` (манифесты не могут разъехаться с реестром тулов).
Единственное следствие: провайдер `speech` регистрируется в cron-реестре
(`src/cron-runtime.js`), планируемых действий — ноль (`check-skill-schedule.js` →
`PASS (schedulable defaults: none)`).

### 2.10 Почему не проще (отклонённые альтернативы)
1. **Оставить движок в ядре, а «инструмент» сделать обёрткой в скиле** — дубль
   движка (ровно проблема, которую убираем); цель Ф0 не достигнута.
2. **Скил декодирует видео сам (ffmpeg внутри)** — +2 состояния × сценарии, внешняя
   зависимость в маленькой репке, риск рассинхрона параметров декодирования; ценность Ф0
   не растёт (все реальные пути и так дают аудио). Отклонено (T9).
3. **Проактивно реализовать `diarize`/`keywords`** — Ф1/Ф2, в Ф0 только задел контракта;
   молчаливое игнорирование флага запрещено (§2.2).
4. **Отдельная секция каталога `speech`** — молча теряет видимость у части профилей (§2.7).
5. **`action-provider-manifest.json` не выпускать** — экономит 1 файл, но лишает
   провайдера явной политики (`effect`/`retrySafety`/триггеры) и расходится с формой из
   задачи; цена нулевая (§2.9).
6. **Читать глобальный `DEEPGRAM_API_KEY` из секретов как фолбэк** — соблазнительно
   (у профиля может не быть своего ключа), но это ломает per-user изоляцию (T13):
   глобальный секрет общий для всех профилей. Отклонено; для смоука используем
   документированный `DEEPGRAM_KEY`-override на один прогон.

---

## 3. Spec delta (`docs/user-scenarios`)

**ДОБАВЛЯЕТСЯ:** `docs/user-scenarios/speech/03-proposal-design.md` (этот файл).

**МЕНЯЕТСЯ:** `01-speech-transcribe.md`
- Шаг 0: зафиксировано, что `speech_set_key` пишет файл с mode `0o600`; `speech_status`
  читает durable `calls.json` (метаданные, без текста).
- Шаг 1: явно — `diarize:true` / непустой `keywords` в Ф0 → типизированная ошибка
  `feature_disabled` (не молчаливый no-op); `cost_hint` не выдумывает цену.
- Шаг 2: видео-контейнер → `unsupported_source`; временный файл удаляется в `finally`.
- Шаг 4: **исправлена пара «аудио ↔ транскрипт»**. На диске общего префикса нет:
  `trained-assist-tg-bot` кладёт файлы как
  `sha256(chat.id:message_id:file_unique_id[:suffix])`, у аудио `suffix=''`, у
  транскрипта `suffix='transcript'` (`src/lib/intake-files.js:7-12`) — проверено:
  97 аудио / 97 транскриптов, пересечение по префиксу = 0. Правило пары:
  **аудио с наибольшим mtime ≤ mtime транскрипта** (проверено на текущем профиле:
  все 97 пар, Δ 0.1–0.5 с, неоднозначных нет). Порог similarity ≥ 0.9 (R3) остаётся.
- Validation: смоук сравнивает с **реальным** транскриптом из `media/intake` по правилу
  выше, а не по совпадению хеша.
- Открытые вопросы: **R4** «private» → **public** (обоснование — §2.8 этого документа).

**БЕЗ ПРАВОК:** `02-requirements-flags.md` — формулировки требований T1–T15 остаются в
силе; уточнения по T2/T3/T6/T9/T12/T13/T14 живут в §2 этого документа и в исправленном
сценарии `01`. Новых или снятых требований нет.

**УДАЛЯЕТСЯ:** ничего.

---

## 4. Срезы (порядок, у каждого — свой тест)

| # | Срез | Тест (обязательный) |
|---|---|---|
| **S1** | Скелет репо `trained-assist-speech-skill` (public): `package.json` (`check`/`test`), `src/mcp-skills/{index,registry,tool-result}.js` (SERVER_ID=`speech-skills`), `src/data-paths.js`, `docs/skill-ci.md`, CI (check → test → manifest:check → core `check-mcp-conformance.js`), `scripts/build-manifest.cjs`, пустой `tools/10-speech.js` | `npm run check`; `node <core>/scripts/check-skill-contract.js .` → PASS; `node <core>/scripts/check-mcp-conformance.js .` → PASS |
| **S2** | `speech_set_key` + `speech_status` + `calls.json` (кольцо 50, атомарно) | `tests/contract/keys.test.js`: файл создан с `0o600` по ожидаемому пути; `status()` без ключа → `{key_present:false,last_calls:[]}` без исключения; изоляция по `USER_ID` (чужой `USER_ID` → своего ключа не видит) |
| **S3** | `speech_transcribe`: `src/audio/{mime,source}.js`, `src/deepgram/client.js`, гарды, ретрай, `calls.json` | `tests/contract/transcribe.test.js` (loopback-заглушка через `DEEPGRAM_API_HOST`): дефолт `language=ru`; в query есть `model=nova-2`, `smart_format=true`; `diarize:true` → `feature_disabled`; `.mp4` → `unsupported_source`; URL скачан и tmp-файл удалён; ответ = `{text,duration,language,cost_hint}`; `segments`/`speakers` отсутствуют; 5xx → 1 ретрай → `upstream_error`; пустой текст → `audio_empty` |
| **S4** | Регистрация сиблинга в ядре (§2.6, 6 точек) + обновление ожиданий в `test/skills-resolve.test.cjs` | `test/sibling-wiring.test.cjs` (4 проверки), `test/live-dir-deploy.test.cjs`, `npm run check` |
| **S5** | Делегирование в `95-video-analysis.js` (§2.5) + алиас `video_set_deepgram_key` | Юнит: с замоканным `sibling-lib` и без него (typed `speech_skill_unavailable`); грепом — в файле нет `deepgramTranscribe`/`loadDeepgramKey`/`keyDir`; контракт-тест: набор полей ответа `video_analysis_status` неизменен; повторный `video_analyze_batch` не увеличивает число вызовов скила (ledger) |
| **S6** | `scripts/speech-smoke.cjs` в репо скила: пара intake-файлов по правилу §3, нормализация (регистр/пунктуация/пробелы), similarity (взвешенный Ле−венштейн/токенный Dice ≥ 0.9), печать обеих длин + similarity, exit 0/1 | Оффлайн-часть (выбор пары + нормализация + метрика) гоняется на реальных `media/intake` без ключа; live-часть требует ключ |
| **S7** | Два PR + релиз: PR в скил → merge; PR в ядро (S4+S5) → зелёный CI и staging → merge → деплой | Зелёный CI/staging на актуальной версии PR (правило домена); staging — обязателен, красный/скипнутый блокирует мерж |

Порядок жёсткий: S1→S2→S3 (один PR скила; S6 можно в тот же PR), затем S4→S5 (один PR
ядра — регистрация без делегирования бесполезна, делегирование без регистрации
сломано, поэтому одним PR), затем S7.

---

## 5. План проверки

Целевой уровень: **S** — сценарий целиком на реальном файле/реальном хосте, а не
«модуль загружается» (проект испытаний: `docs/TESTING-PLAYBOOKS.md`).

| Шаг сценария | Проверка | Где |
|---|---|---|
| Шаг 0 (ключ) | `speech_set_key` → файл `0o600` и непуст; `speech_status().key_present===true`; алиас `video_set_deepgram_key` резолвится и пишет туда же | `tests/contract/keys.test.js` (скил) + юнит ядра на алиас (S5) |
| Шаг 1 (локальный файл) | `{text,duration,language,cost_hint}`; `text` непуст и не отказ; дефолт `language=ru`; без `diarize/keywords` нет `segments/speakers` | `tests/contract/transcribe.test.js` + loopback-заглушка |
| Шаг 2 (URL/Яндекс.Диск) | tmp-файл после вызова отсутствует; недоступный источник → типизированная ошибка | `tests/contract/transcribe.test.js` |
| Шаг 3 (чейн ядра) | в `95-video-analysis.js` нет `deepgramTranscribe`/`loadDeepgramKey`; набор полей `video_analysis_status` неизменен; повторный вызов не ходит в Deepgram | юнит ядра (S5) + `git grep` в CI-гейте ядра |
| Шаг 4 (смоук) | реальный `<hash>-audio.ogg` → `speech_transcribe` → similarity ≥ 0.9 с парным транскриптом (правило §3); exit 0 | `scripts/speech-smoke.cjs` — ручной прогон на хосте (нужен ключ профиля) |
| Негативы | нет ключа → `key_missing` (не 500); нет checkout'а скила → `speech_skill_unavailable`; видео → `unsupported_source` | тесты S3/S5 |
| Регрессия | `video_analyze_batch`/`video_analysis_status`: внешние поля не менялись | контракт-тест S5 + staging |

**Смоук-зависимость (важно для шага смоука):** у профиля может **не быть** своего
ключа Deepgram — голосовые в Telegram распознаёт шлюз своим глобальным секретом, а
MCP-путь ключа не требует. Проверить `speech_status()`; если ключа нет — взять ключ у
владельца (или прогнать смоук с env-оверрайдом `DEEPGRAM_KEY=<ключ>` на один прогон,
в файл не писать). Это внешняя зависимость шага, а не ошибка реализации.

---

## 6. Риски и откат

| Риск | Смягчение |
|---|---|
| R-a. Сиблинг отсутствует/битый в проде → видео-чейн мёртв | жёсткий отказ деплоя без checkout'а (§2.6 п.3); typed `speech_skill_unavailable`; ошибка по каждому видео в ledger, пачка не «съедается» молча; staging обязателен |
| R-b. similarity < 0.9 из-за разных параметров шлюза (`paragraphs` vs plain) | нормализация в смоуке (регистр/пунктуация/пробелы) → ожидаемо ≈1.0; при системном расхождении сначала выясняем причину в тексте, порог НЕ понижаем молча; R3 остаётся риском до первой гонки |
| R-c. Смоук не может пойти: у профиля нет ключа | Шаг 0 у сценария (set_key) или env-оверрайд на один прогон (§5) |
| R-d. Двойное имя тула (алиас) → CONFLICT/невидимость | алиас только в ядре, в скиле только `speech_*`; `check-skill-contract.js` + `mcp-action` ловят дубль |
| R-e. MCP-таймаут 45 с у длинных файлов (общий для всех action-тулов, `src/mcp-action.js`) | Не новое: так же ведёт себя `video_analyze_batch`. Чейн ядра зовёт handler **в процессе** (без 45 с). Прямой вызов длинного файла моделью — известное ограничение Ф0, зафиксировано в описании тула |
| R-f. Манифесты разъедутся с реестром тулов | CI скила: `npm run manifest` + `git diff --exit-code` |
| R-g. Новая видимость/секция ломает профили с `skills.json` | речь в существующей секции `recruiting/interview` (§2.7) → гейтинг не меняется; откат — строка каталога |

**Откат.**
1. Ядро: `git revert` merge-коммита → `95-video-analysis.js` возвращает собственный
   Deepgram-движок; релиз — обычный деплой (симлинк `agent-master` на предыдущий релиз
   или revert + редеплой). Флага не нужно: изменение обратимо одной ревизией.
2. Сиблинг: revert в его репо; на ядро влияет только после его следующего деплоя.
3. Данные: **миграции нет** — путь ключа не менялся. Побочные файлы
   (`calls.json`) можно удалить, они не читаются никем, кроме `speech_status`.
4. Порядок откатов: сначала ядро (вернуло движок себе), потом скил — в обратном
   порядке ядро на ревизии без делегирования всё равно работает.
5. Жёсткое требование checkout'а в `deploy.sh` снимается тем же revert'ом ядра.
