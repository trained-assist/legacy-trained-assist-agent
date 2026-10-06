# Repository entry point

## Legacy status and work priority

This repository is **legacy / migration-only**. Do not spend time on general Sandbox-Driven Engineering rollout, broad feature work, architectural refactors, or new runtime responsibilities here. Work only on current-user safety/continuity, inventory/export/ownership transfer, or the smallest change directly required by an accepted migration/retirement/security issue. Do not break current legacy operations without an explicit issue and migration plan. This does not cancel necessary local tests or any concrete migration work already authorized by its owning issue. Canonical status and scope: [trained-assist-architecture/ARCHITECTURE.md, section 9](https://github.com/trained-assist/trained-agent-architecture/blob/main/ARCHITECTURE.md#9-репозитории-и-ownership); retirement gate: [issue #145](https://github.com/trained-assist/trained-agent-architecture/issues/145).

Google Cloud VM `alesa-personal-assistent/us-central1-a/alesa-vm` (instance ID `7077705867419574607`) is being retired. Do not add processes, cron, agent runs, sandbox or dependencies on it. Access is limited to inventory, export, reconciliation and shutdown. Use serverless and the own Agent Run API by default; use the existing VM in France only when a persistent process or local resource is required. Other Google services remain permitted. See [the exit issue](https://github.com/trained-assist/trained-agent-architecture/issues/145).

The GCP deploy workflows and old README architecture are migration history. Do not reactivate them. Coordinate shared endpoints, credentials, writers and the French VM with the integrator before changing them.


## Sandbox-Driven Engineering

Останавливаться до безопасной dev/test-проверки или отказываться от неё из-за вероятности ошибки — вредно для инженерной работы. Не завершайте задачу одним чтением кода, если Environment Contract даёт безопасный путь исполнения. В заявленных изолированных local/dev/test/staging ресурсах самостоятельно запускайте/развёртывайте, подавайте реалистичный input, проверяйте output/logs/state, исправляйте ошибки и повторяйте сценарий. Ошибка в sandbox — evidence, а не повод закончить работу или попросить лишнее подтверждение. Production — отдельная защищённая граница; работайте с ним только по Promotion to Production path этого репозитория.


## Environment Contract

### Development / Test / Staging
Local repository tests (`npm test`) and local fixtures are available. No supported staging clone of the legacy agent, user directories, profile credentials, or Telegram/webhook delivery is declared. Do not create a staging environment by pointing at production state or the retiring VM. The RU `alesa-vm` retirement boundary in this file remains binding; do not deploy, restart, mutate, or run new tasks there.
**Agent permissions:** local tests and isolated fixtures allowed. Network tests against legacy users/providers and deploy/restart on production hosts prohibited. Use architecture-approved new serverless/Runner sandboxes for new development.

### Production / Promotion
The legacy live agent/API and its per-user data are production and protected. GCP `alesa-personal-assistent/us-central1-a/alesa-vm` is being retired and limited to inventory/export/reconciliation/shutdown per architecture issue #145. No promotion path for new code is declared here; do not reactivate historical GCP deployment workflows. Production changes require a separately approved, owner-operated migration path.

### Testability Contract / Sandbox Gaps
Legacy end-to-end verification against a realistic safe user/account is unavailable because no isolated legacy staging service is declared and the former VM is being retired. Local test evidence does not prove Telegram/Web integration. Persisted cross-project migration gap: trained-agent-architecture#145 and rollout #185. Continue safe local work; do not use this gap to avoid tests that can run locally or in the new isolated services.
