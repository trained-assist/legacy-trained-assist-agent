# Edge-Case Test Plan: Engineering Playbooks

Цель: поймать баги, которые не ловятся обычным прогоном. Каждый тест — это **отдельный сценарий** с подготовленным битым входом или нестандартной ситуацией.

---

## Категория 1: Битые/неполные входы

| # | Тест | Что ломаем | Ожидаемое поведение |
|---|------|-----------|---------------------|
| 1.1 | **Пустой goal** | `goal: ""` | Отказ на compilation, не на execution |
| 1.2 | **Goal с template injection** | `goal: "{goal} и ещё {input} и { nonexistent }"` | Substitute не подставляет несуществующие плейсхолдеры, goal не ломается |
| 1.3 | **Невалидный JSON в playbook** | Ломаем JSON-файл плейбука (запятая, скобка) | PlaybookStore.list() не крашится,报 ошибку в diagnostics |
| 1.4 | **Шаг без validation** | Убираем `validation` из шага | validateItem бросает "item validation required" |
| 1.5 | **Шаг без execution_kind** | Убираем `execution_kind` | validateItem бросает "invalid execution_kind" |
| 1.6 | **Agent-шаг без role/level/budget** | `execution_kind: "agent"` без executor_role | compilePlaybook → COMPILE_INVALID |
| 1.7 | **Неизвестный validator key** | `"validation": {"typo_key": true}` | Шаг компилируется (LLM fallback), но в runtime inconclusive |
| 1.8 | **Wait на agent-шаге** | `"execution_kind": "agent", "wait": {...}` | validateItem: "wait is only allowed on programmatic steps" |
| 1.9 | **Невалидный hook event** | `"on_unknown": [...]` в stage | validateHooks бросает |
| 1.10 | **Очень длинный goal** | 10000+ символов | План создаётся, prompt не обрезается |

## Категория 2: Битое состояние БД/файлов

| # | Тест | Что ломаем | Ожидаемое поведение |
|---|------|-----------|---------------------|
| 2.1 | **Дубликат task_id** | Пытаемся создать план с тем же UUID | Идемпотентность или отказ |
| 2.2 | **Task с несуществующим profile_id** | profile_id = "nonexistent_user" | Отказ, не краш |
| 2.3 | **Несуществующий item_id в skip** | `task_item_skip(item_id: "00000000-...")` | `{error: "item not found"}` |
| 2.4 | **Skip已完成шага** | Skip шага со status='done' | Отказ ("only pending or waiting") |
| 2.5 | **Wake шага не в waiting** | `task_item_wake` на pending шаг | Отказ или no-op |
| 2.6 | **Повторный complete** | Два раза `task_item_complete` на один шаг | Второй = no-op или error |
| 2.7 | **Concurrent modification** | Два tick одновременно на один plan | Только один получает claim |
| 2.8 | **Битый evidence_json** | Невалидный JSON в evidence | Не крашит settlement, fallback на raw text |

## Категория 3: GitHub/API edge cases

| # | Тест | Что ломаем | Ожидаемое поведение |
|---|------|-----------|---------------------|
| 3.1 | **Нет GitHub токена** | Удаляем `~/agent-tokens/<user>/github` | pr_opened → inconclusive('no-github-token'), не краш |
| 3.2 | **PR не существует** | `pr_opened` с URL несуществующего PR | inconclusive('pr-not-found') |
| 3.3 | **PR закрыт (не смержен)** | Мёржим PR, потом проверяем ci_green | state='closed', merged=false → fail или inconclusive |
| 3.4 | **CI нет (no check runs)** | PR без CI workflows | inconclusive('no-check-runs') |
| 3.5 | **CI красный** | PR с failing checks | fail с evidence |
| 3.6 | **Rate limit GitHub API** | 100 запросов подряд | graceful degradation, не exception в loop |
| 3.7 | **Невалидный remote URL в git** | remote URL без github.com | gitRemoteRepo → null, fallback на other resolution |
| 3.8 | **Ветка удалена после PR** | PR смержен, ветка удалена | merged validator всё равно находит PR |

## Категория 4: Recovery/restart edge cases

| # | Тест | Что ломаем | Ожидаемое поведение |
|---|------|-----------|---------------------|
| 4.1 | **Crash mid-step (kill -9)** | SIGKILL opencode процесс | Step → failed, retry на следующем tick |
| 4.2 | **Crash при settlement** | Kill после reply, до записи evidence | Resume с ПРОДОЛЖЕНИЕ prompt |
| 4.3 | **3 неудачных попытки** | 3 раза crash подряд | Step → failed terminal, plan → blocked или continue |
| 4.4 | **Restart при waiting** | Kill во время task_item_wait | Poll возобновляется после restart |
| 4.5 | **Resume без контекста** | Сервер перезапустился, сессия потеряна | Fresh run с prompt из planText |
| 4.6 | **Два тика подряд** | Kick два раза с интервалом 1с | Второй tick — no-op (уже running) |

## Категория 5: Валидация и финализация

| # | Тест | Что ломаем | Ожидаемое поведение |
|---|------|-----------|---------------------|
| 5.1 | **Финализация без всех validations** | Один шаг skipped без reason | Blocked или rejection |
| 5.2 | **acceptance_criteria с несуществующим validator** | `{ci_green: true}` но нет PR | Gate не проходит |
| 5.3 | **Все шаги skipped** |.skip() на каждом | План финализируется? |
| 5.4 | **Plan с 0 шагов** | Пустой stages array | COMPILE_INVALID |
| 5.5 | **Plan с 1 шагом** | Один agent-шаг | Компилируется, выполняется, финализируется |
| 5.6 | **Level escalation** | bachelor → master → doctor | При 3 fails escalating |

## Категория 6: Промпт/контекст

| # | Тест | Что ломаем | Ожидаемое поведение |
|---|------|-----------|---------------------|
| 6.1 | **Промпт > context budget** | 50+ шагов в плане | Digest обрезается, prompt не ломается |
| 6.2 | **Предыдущий шаг без ИТОГ ШАГА** | Step N не оставил итог | Digest пустой, следующий шаг работает |
| 6.3 | **ИТОГ ШАГА с special chars** | Markdown injection, code blocks | Prompt не ломает формат |
| 6.4 | **Step instructions содержат {template}** | `{goal}` в instructions | Substitute подставляет |
| 6.5 | **Одновременные планы одного профиля** | 2 плана, один user | Независимые workspace, не смешиваются |

---

## Как запускать

### Базовые прогоны (3 раза)
```bash
#feature
AGENT_SECRET="$S" node scripts/e2e/playbooks-e2e.js start \
  --playbook feature --goal "добавить в todo-cli команду stats" \
  --remote http://136-65-7-197.sslip.io:8080

# debugging
AGENT_SECRET="$S" node scripts/e2e/playbooks-e2e.js start \
  --playbook debugging --goal "найти и починить баг: todo list падает при пустом файле" \
  --remote http://136-65-7-197.sslip.io:8080
```

### Эджкейс-тесты (через отдельные сессии)
Каждый эджкейс = отдельная сессия через Session Manager с промптом:
"Выполни план X с битым входом Y. Проверь что система корректно обрабатывает ошибку."

### Метрики успеха
- Все 3 базовых прогона завершены (15/15 + 13/13 + 15/15)
- Ни один эджкейс не крашит процесс ( graceful error )
- Recovery работает при crash mid-step
- Loop guard срабатывает при зацикливании
