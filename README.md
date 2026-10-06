# trained-assist-agent

Compatibility implementation и источники данных/контрактов Trained Assist. Репозиторий содержит session/runtime adapters, host APIs, domain integration, credentials и инструменты миграции. Его прежняя GCP схема не является целевой архитектурой платформы.

Документы содержат действующие требования, контракты и инструкции. Планы выполнения, статусы, ревью прошлых версий и evidence ведутся в GitHub issues/PR/Project. Целевая модель не является утверждением о текущем deployment; его готовность проверяется по конкретным SHA и приёмке.

## Границы

Новая orchestration модель — [control plane](https://github.com/trained-assist/trained-assist-control-plane); isolated execution и persistence — [Runner](https://github.com/trained-assist/ai-agent-runner); каналы — [TG](https://github.com/trained-assist/trained-assist-tg-bot) и [Web](https://github.com/trained-assist/trained-assist-web). Shared contracts — [ARCHITECTURE](https://github.com/trained-assist/trained-agent-architecture/blob/main/ARCHITECTURE.md).

Существующие compatibility APIs и migration primitives меняются адресно, без расширения ответственности ядра. Доменные capability имеют одну бизнес-реализацию и тонкие адаптеры; инструмент UI доступен без Agent Run. Фактическую доступность определяют schema/code/host binding и deployment evidence, а не старый список VM.

## Источники

- [docs](docs/README.md) — локальные durable contracts и migration procedures.
- `src/` — действующая реализация; `contracts/` — явные интерфейсы.
- `scripts/profile-repo.mjs`, `scripts/profile-migrate/` — provisioning/import utilities; создание repo не доказывает накопительное сохранение профиля.
- Persistent workspace: [Runner #95](https://github.com/trained-assist/ai-agent-runner/issues/95); архив/profile migration: [#1916](https://github.com/trained-assist/trained-assist-agent/issues/1916), [#1921](https://github.com/trained-assist/trained-assist-agent/issues/1921).

## Проверка и работа

```bash
npm ci
npm run check
npm test
```

Проверки работают в local/sandbox окружении и не разрешают production deployment. Запускайте только относящиеся к изменению suites; команды/варианты — package.json. Во всех публикациях сохраняйте scope, operation/run IDs и generation; unknown внешнюю мутацию сверяйте до retry. Credentials не попадают в argv, prompt, Git и logs.

Feature branch/worktree и PR обязательны. Перед работой проверить `.githooks/` через `scripts/install-git-hooks.sh`; открытые PR не переписываются чужой сессией. Не менять чужие процессы, endpoints, shared credentials или deployments. Source/deployed SHA и evidence фиксируются в issue.

Retiring GCP VM is not a development or fallback target. Use the own Agent Run API and serverless by default; a necessary persistent service belongs on the existing French VM. Other Google services remain allowed. Exit coordination: https://github.com/trained-assist/trained-agent-architecture/issues/145.
