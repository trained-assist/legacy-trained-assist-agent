# Контекст S4a+S4b: конструктор плейбуков (эпик #1851, D1 и D2)

Карта для дизайна. Сценарий: docs/user-scenarios/engineering/02-custom-playbook-authoring.md.

## Точки входа

| Что | Где |
|---|---|
| Промпт Hermes (мета-паттерны) | src/playbook-authoring.js:76 (AUTHORING_PROMPT) |
| Сборка/ремонт черновика: один вызов + 1 repair с ошибкой валидатора | src/playbook-authoring.js authorAndValidate (~239) |
| draft / edit / save | src/playbook-authoring.js (~285-355); save вызывает validatePlaybook и пишет ~/users/<p>/playbooks/<id>.json |
| MCP-тулы playbook_draft/edit/save/get/health | src/mcp-skills/tools/102-playbooks.js (health: строка 93) |
| Схема Playbook v1 | contracts/playbook.schema.json (additionalProperties:false на корне и на step; корень: id, version, scope, title, goal_template, user_value_template, defaults, requires, inputs, stages, hooks) |
| Валидация схемы | src/playbook-store.js validatePlaybook (~70); ВЫЗЫВАЕТСЯ И В _load (~160) при каждом resolve/list |
| Подстановка {var} | src/playbook-store.js substitute (~79): неизвестный {var} остаётся как есть |
| Реестр валидаторов | src/playbook-validators.js:621 createDefaultRegistry — ключи: ci_green, ci_and_staging_green, merged, pr_merged, merged_and_deployed, pr_opened, file_exists, command_exit_zero, credential_present, http_ok, task_done, fanout_joined |
| Неизвестный ключ при исполнении | evaluateValidation: inconclusive "no-validator" → в режиме programmatic шаг никогда не пройдёт; в +llm уходит LLM-судье |
| Каталог step-types | сиблинг trained-assist-engineering: library/step-types.json (23 типа; поля title, purpose, execution_kind, executor_role, minimum_model_level, validation, substeps). В ядре на него нет ссылок |
| Путь к сиблингу | src/playbook-store.js REPO_PARENT (~26) + DEFAULT_SIBLING_REPOS (~38) |
| Достижимость, гейт dispatch | src/playbook-reachability.js:171; маршруты A1/A2/B/C/E/F; для profile-плейбука F не считается (launcherDir только не для profile) → всегда D=FAIL |
| Секции контекста запуска | src/runner/index.js:2239 (playbookSuggestionSection) и :2249 (baseContext) |
| Готовый образец блока «плейбуки в промпте» | src/dev-task-playbook-suggestion.js buildDevPlaybookSuggestion: PlaybookStore({profileId}), try/catch → '' (opt-in-safe) |

## Что переиспользуем
- Ключи реестра: Object.keys(createDefaultRegistry()). Фабрики без сетевых вызовов, дёшево. Один источник правды для промпта Hermes и для проверки на draft/save.
- step-types.json читать через REPO_PARENT/<sibling>/library/step-types.json; нет файла → каталог пустой, не ошибка (профили без сиблинга).
- Repair-цикл authorAndValidate: новая семантическая проверка кидает ошибку внутри try → Hermes получает её текст и чинит. Отдельный цикл не нужен.
- PlaybookStore({profileId}).list() → профильные плейбуки для блока в промпте; шаблон — buildDevPlaybookSuggestion.
- Для health: checkPlaybookReachability уже получает profileId и знает pb.source === 'profile'.

## Реальные ограничения
- validatePlaybook вызывается в PlaybookStore._load. Новые семантические правила (неизвестный ключ, {var} без inputs) нельзя класть туда: сломается загрузка уже сохранённых плейбуков у всех. Правила — отдельная функция в authoring, только на draft/edit/save.
- Схема additionalProperties:false: when_to_use добавить в properties корня, необязательным. Старые файлы остаются валидными. Схему читают также сиблинги в своём CI (ядро в .core), поэтому поле только добавляется.
- Agent-шаги могут иметь произвольные ключи validation (их проверяет LLM-судья, так работают все системные плейбуки: use_case_value_and_steps_written и т.п.). Строгость только для execution_kind programmatic.
- Programmatic-шаг с instructions схемой разрешён, и системные плейбуки это могут использовать. Отклонять только неизвестный ключ; инструкции — правило промпта, не отказ (решить на дизайне).
- Блок профиля — только для profile-уровня (system/sibling уже маршрутизируются prompt-domains). Не для internalGtd-ранов, как playbookSuggestionSection. Ограничить размер (N плейбуков, длина when_to_use).
- Нет when_to_use → в блок не попадает, dispatch по-прежнему fail: поле и есть маршрут.

## История
- #1372 P0/P1 (PR #1385, #1389, #1394, #1402): реестр, authoring, бюджет 6000 токенов. Проверок реестра в authoring не было с самого начала.
- #1756: reachability. Профильный маршрут не предусматривали.
- #1573 slice C: dev-task-playbook-suggestion — прецедент инъекции.
- Внешний ресерч не нужен: всё есть внутри.

## Открытые вопросы для дизайна
1. Инструкции в programmatic-шаге: отклонять или только запрещать в промпте? Рекомендация: запрещать в промпте, при save предупреждать.
2. Куда инъектировать блок: в системный промпт (как ПРОЕКТ) или в baseContext (как playbookSuggestionSection)? Задача говорит «системный промпт профиля»; reachability статичен и зависит только от поля.
