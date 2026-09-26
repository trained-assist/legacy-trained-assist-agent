# {{domainName}} — user scenarios

Сценарии для домена **{{domain}}** по формату
[`docs/user-scenarios/README.md`](https://github.com/trained-assist/trained-assist-agent/blob/main/docs/user-scenarios/README.md):
**Контекст → Шаги → Validation → Edge cases**. План моков пишется вместе со
сценарием (моки — часть определения сценария).

## 01. Example happy path

### Контекст

- Профиль подключён, токен {{domain}} есть.
- Внешняя система доступна (в CI — записанные фикстуры).

### Шаги

1. Пользователь: «статус {{domainName}}»
   → бот вызывает `example_status`, отвечает `{ ok: true }`.

### Validation

- `tools/call` вернул `{ content: [...] }` с непустым текстом.
- LLM/агентные шаги — скриптованная фикстура; сеть — записанная фикстура.

### Edge cases

- Внешний API вернул 5xx → тул возвращает `isError`, не крашится.
- Токен отсутствует → setup-тул просит подключиться.

## План моков (CI-сценарий)

| Рубеж | Чем мокаем | Фикстура |
|-------|-----------|----------|
| LLM / агентные шаги | скриптованный ответ | `fixtures/llm/*.json` |
| Внешняя сеть | записанные HTTP-ответы (record/replay) | `fixtures/http/*.json` |
