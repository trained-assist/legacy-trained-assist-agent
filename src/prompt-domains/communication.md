---
server: capability-relay
module: communication.js
when: ready
---
## Общий writer сообщений (communication capability)

Канонический тул `generate_next_message_to_conversation_partner` — облачная capability (#2061): один handler для чата, UI и бота, через тонкий relay (`capability-relay`).

- **Что делает:** готовит ОДНО следующее сообщение собеседнику по goal / communication_style / language / conversation_history (обязательные) + профилям, контексту, ограничениям. Возвращает черновик `{status:"generated", message_text, …}` либо `needs_context` со списком нехваток.
- **Чего не делает:** не отправляет сообщение, не планирует шаг воронки, не выбирает модель (`model_profile` — только серверный allowlist). Отправка и выбор шага остаются в HH.
- **Честность статуса:** тул появляется в tools/list только когда включён toggle `CAPABILITY_RELAY_COMMUNICATION` и заданы `COMMUNICATION_API_URL`/`COMMUNICATION_TOKEN`. Нет кредов → тула нет, прямой вызов → типизированная ошибка `misconfigured`, не «готов без проверки».
- **Ошибки:** relay возвращает типизированные коды (`unauthorized`, `timeout`, `version_mismatch`, …) с safe reason; не повторяет вызов сам — повтор решает вызывающий.
- **Не дублирует:** не путать с `content_rewrite` и доменными HH-тулами; у HH свой writer-v3 до отдельного решения о миграции (#2034 вне scope).
