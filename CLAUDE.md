# Repository instructions

Start with [AGENTS.md](AGENTS.md), [README.md](README.md) and the relevant original source/contract. Shared target architecture: https://github.com/trained-assist/trained-agent-architecture/blob/main/ARCHITECTURE.md.

Документы содержат действующие требования, контракты и инструкции. Планы выполнения, статусы, ревью прошлых версий и evidence ведутся в GitHub issues/PR/Project. Целевая модель не является утверждением о текущем deployment; его готовность проверяется по конкретным SHA и приёмке.

## Development rules

- Dedicated feature branch/worktree before code; install/verify `.githooks/` with `scripts/install-git-hooks.sh`. Do not push directly to main/master.
- Preserve the repository's immutable-PR rule: do not amend/force-push another submitted PR; use an independent PR for follow-up changes.
- Save pushed checkpoints and open a draft PR for incomplete work. Read-only review does not create empty code PRs.
- Keep host-issued identity, generation fencing and explicit credential scope. Do not source complete host env or use ambient credentials for a Run.
- Reuse the canonical domain capability through its contract; do not copy domain code back into core.
- Engine success, workspace publication, cleanup and delivery are independent. Unknown outcome requires reconcile before retry.
- Test with synthetic profiles/scoped fixtures. Do not kill shared process trees, reset storage or redeploy services to fix an unrelated test.
- Issue/PR/CI owns work status. Open the current issue before implementation; historical plans are not executable instructions.

Retiring GCP VM is not a development or fallback target. Use the own Agent Run API and serverless by default; a necessary persistent service belongs on the existing French VM. Other Google services remain allowed. Exit coordination: https://github.com/trained-assist/trained-agent-architecture/issues/145.
