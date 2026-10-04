# Core — Регистрация communication-skills MCP (общий writer сообщений)

**Домен:** ядро агента — sibling-MCP интеграция
**Суть:** Общий writer следующего сообщения доступен из чатов и из HH-адаптера через host contract ядра, а не как отдельный процесс/ручной вызов
**Зависимость:** скилл trained-assist-communication-skills работает на main (generate + evaluate, contract v1.1); issue: trained-assist-agent#2034, ТЗ: trained-agent-architecture#125

---

## Контекст (начальный state)

- Скилл trained-assist-communication-skills смержен: `generate_next_message_to_conversation_partner` + `evaluate_message_quality`, MCP entrypoint (initialize/tools/list/tools/call), живой прогон на общей лестнице `conversation` проходил.
- Ядро НЕ знает про этот сервер: MCP config, профильная доступность, каталоги и prompts его не регистрируют.
- Рекрутер работает с вакансией и кандидатами; HH-пути генерации (`/hh/generate-message`, batch/regenerate, фоновые черновики) пока используют собственный writer hh-скила.

---

## Ценность

Рекрутер (и агент в его чате) получает черновик следующего сообщения, написанный ОДНИМ общим writer'ом — тем же кодом пользуются прямой вызов из чата и все HH-пути; генерация отделена от отправки и от выбора шага воронки. Уровень V: **V4** — ТЗ и эпик согласованы владельцем (trained-agent-architecture#125), скилл уже построен и проверен вживую.

---

## Шаги сценария

### S1 — Сервер зарегистрирован в конфиге ядра

**КОГДА** установлен feature toggle (communication writer включён для профиля recruiter) **ТОГДА** core MCP config содержит sibling-server trained-assist-communication-skills, и deploy conformance check проходит (entrypoint не импортируется в процесс core — только внешний запуск по контракту host/broker).

### S2 — Тул виден нужному профилю

**КОГДА** агент в сессии профиля recruiter делает tools/list через host **ТОГДА** `generate_next_message_to_conversation_partner` присутствует со своей схемой (goal/communication_style/language/conversation_history обязательные), а для профиля без включения тул отсутствует; visibility и availability объявлены отдельно от LLM provider readiness (без writer credentials работоспособность не заявляется).

### S3 — Реальный вызов через host

**КОГДА** хост выполняет initialize → tools/list → tools/call (реальный вызов, не мок) **ТОГДА** handler отвечает типизированным результатом `{status:"generated", message_text, generation, usage, timing}` либо `needs_context` с `missing_fields`; схемы/ошибки/таймауты непустые; пустой успешный ответ не возвращается никогда (ошибка API → isError с кодом).

### S4 — Artifact ref читается безопасно

**КОГДА** передан task-scoped artifact ref на файл (например, выгрузка истории) **ТОГДА** broker/host резолвит его в пределах задачи, произвольные host path/URL не исполняются; тест с новым случайным маркером файла подтверждает чтение (и отказ для чужого пути).

### S5 — HH-адаптер зовёт через подтверждённый runtime path

**КОГДА** HH adapter формирует вызов (employer→sender, applicant→partner, цель→goal, данные вакансии→context, стиль→communication_style отдельным блоком) **ТОГДА** вызов доходит до handler'а тем же host/broker-путём, что и S3; второго владельца durable-state не появляется.

### S6 — Нет конфликтов с существующими инструментами

**КОГДА** тул зарегистрирован **ТОГДА** он не дублирует aliases content-rewrite (`content_rewrite`) и доменных HH tools; generate next message не отправляет сообщение и не планирует следующий шаг воронки (граница из ТЗ: отправка/план остаются в HH).

### S7 — Откат флагом

**КОГДА** toggle выключен **ТОГДА** тул недоступен профилю, fallback явно помечен в diagnostics; откат не меняет отправленные сообщения и не требует миграции данных.

---

## Не-цели (этот план НЕ делает)

- Перевод HH-путей генерации на общий writer (отдельный план: trained-assist-hh-skill#125).
- Бенчмарк и аналитика (trained-assist-free-models-benchmark#11).
- Изменения кода самого скила communication-skills.
- Отправка сообщений или выбор шага воронки — остаются в HH.

## Крайние случай

- Нет writer credentials / LLM provider readiness → тул не заявляет работоспособность (отдельное объявление readiness).
- Пустая история → валидно (первое сообщение), не ошибка.
- Роль в истории неоднозначна → `validation/needs_context`, роли не выдумываются.
- Toggle выключен → тул отсутствует в tools/list, а не падает при вызове.

---

## Проверяемые инварианты

1. Интеграция доказывается реальным host tools/list + tools/call, а не правкой config/skill-catalog.json (resolver shadow-only).
2. Один handler используется MCP и host adapter'ом; entrypoint соседнего репо не импортируется в процесс core.
3. Регистрация не зависит от HH token — writer не вызывает HH API.
4. Ladder/модель берутся из общего провайдера, независимая копия лестницы не создаётся.
5. Есть явный feature toggle и rollback (откат = выключить флаг).
