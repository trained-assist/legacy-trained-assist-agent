# Core 07 — Контракт и тонкий relay облачных capabilities (PR1)

Issue #2061 (секции 1–6, приёмка §7), первый PR плана «небольшими PR».
Охватывает только PR1: общий tools/schema mapping, HTTP adapter к Cloudflare API,
минимальный env, auth context, timeouts, error mapping, mock Worker.

## Зачем (ценность)

Ценность: **актор (движок агента, далее — и UI/бот) вызывает облачную capability
одной канонической реализацией: результат и ошибки через тонкий relay на VM те же,
что у прямого вызова Cloudflare API, причём без спавна Agent Run на VM и без второй
бизнес-логики на VM.**

Уровень доказанности: **V2** — источник: решение владельца в issue #2061
(«Решение владельца — уточнено 03.10.2026») + приёмка §7. Это инфраструктурный
PR1 из утверждённого плана; прямой пользовательский эффект приходит пилотами PR2–4.

Инвариант PR1: relay делает ТОЛЬКО initialize/tools/list/tools/call mapping,
JSON-RPC↔HTTP transport, передачу host-issued identity/correlation, deadlines и
типизированных ошибок. Контракт/schema общий и версионированный. Генерация,
бизнес-валидация, отправка, provider retry logic и provider credentials в relay
не копируются. Паритет контракта доказывается mock-Worker-тестом.

## Шаги (сценарии)

| ID | Шаг → ценность | КОГДА…ТОГДА (EARS) | Validation | Статус |
| --- | --- | --- | --- | --- |
| SR-01 | Движок поднимает relay | КОГДА движок спавнит stdio MCP relay с минимальным env (только API base + credential своего API; полное service env не наследуется) ТОГДА relay отвечает `initialize` с контрактной версией (contract version) и не требует provider-секретов | contract-тест | planned PR1 |
| SR-02 | Список инструментов из общего mapping | КОГДА движок запрашивает `tools/list` ТОГДА relay отдаёт канонические имена и schema из общего версионированного mapping (один источник для REST и MCP), без локальной бизнес-логики | contract-тест | planned PR1 |
| SR-03 | Пользователь просит агента выполнить capability | КОГДА приходит `tools/call` (toolId, params) ТОГДА relay делает HTTP POST к Cloudflare API с auth context (host-issued identity, profileId/runId как correlation, operationId, deadline) и возвращает результат canonical handler'а без изменений — name/schema/result идентичны прямому REST-ответу | mock-Worker contract-тест (паритет REST ↔ MCP) | planned PR1 |
| SR-04 | Cloudflare недоступен / timeout / version mismatch | КОГДА HTTP превышает deadline, API отвечает 4xx/5xx или зафиксирован несовместимый contract version ТОГДА relay возвращает типизированный JSON-RPC error с safe reason (без secrets, текстов кандидатов, signed URLs), без автоматического local fallback и без повтора изменяющего вызова (после timeout mutating-вызова исход unknown) | mock-тест error mapping + timeout | planned PR1 |
| SR-05 | Не задан env/credential | КОГДА env relay (API base/токен) отсутствует ТОГДА relay стартует и на вызове отдаёт явную typed error (misconfigured), не падает при старте и не пишет значения в логи/manifest | unit-тест | planned PR1 |
| SR-06 | Контракт доказан до пилота | КОГДА CI гоняет contract-тесты против mock Worker ТОГДА паритет имён/schema/результатов, auth context, deadline и все error-маппинги зелёные | CI (staging-gate) | planned PR1 |

Дальше по плану (не в PR1): PR2 — подключение настоящего communication Worker
(#2034), PR3 — candidate send capability, PR4 — controlled rollout.

## Не-цели (сознательно вне PR1)

- Подключение реального production Worker / пилот communication (PR2, #2034).
- Candidate send capability, operationId-идемпотентность провайдера (PR3).
- Production-переключения, feature flag, rollback-поставка (PR4).
- Сервис-супервизор локальных скилов, перенос agent-data в R2/KV,
  перенос search/speech/documents (явно вне пилота, §6).
- Вторая бизнес-логика, своя лестница моделей и provider credentials в relay;
  импорт internals core в relay.
- Закрытие #2060 / #2053 как решения о decommission VM.

## Крайние случаи

- Пустой/частичный env → SR-05 (typed misconfigured, без падения старта).
- Cloudflare недоступен → SR-04 (понятная ошибка, нет скрытого fallback).
- Повтор того же `tools/call` с тем же operationId → relay лишь передаёт;
  идемпотентность доставки обеспечивает API (проверяется в приёмке, не здесь).
- Чужой profileId/candidate/artifact в params → права проверяет Cloudflare API
  (actor = host-issued identity, а не поля модели); relay не выдаёт доступ.
- Timeout изменяющего вызова → исход unknown, reconcile, ни в коем случае
  автоматический повтор через старый backend.
- Несовместимая версия контракта → явный отказ, не тихий переход на другой handler.
- Секреты: только свой API-токен в env relay; ничего в engine config/logs/manifest.

## Открытые точки (не блокируют, закрываются шагом исследования)

- Точный путь/имя модуля relay в дереве репо, имена env-переменных, формат
  контрактного эндпоинта (REST POST против MCP-over-HTTP) — определяются
  исследованием кода в шаге 2; контракт из issue #2061 при этом не меняется.
