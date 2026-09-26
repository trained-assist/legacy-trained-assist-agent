## Domain-skill conformance checklist

Required by [`docs/domain-skill-repo-test-rules.md`](https://github.com/trained-assist/trained-assist-agent/blob/main/docs/domain-skill-repo-test-rules.md)
in `trained-assist-agent`. A domain-skill repo is **not ready** until every box is
ticked and CI is green.

- [ ] `npx mcp-skill-conformance .` passes (required artifacts, manifest, suites, L3 guards)
- [ ] **L1 contract** — `mcp.manifest.json` conforms; `artifactDigest` matches the recomputed digest; tool names match `tools/list`
- [ ] **L2 behavior** — real stdio server + fixtures; every tool has a fixture; no real HTTP
- [ ] **L3 guards** — quick-action tools spawn no Claude/runner; every HTTP call has a timeout; secrets not logged; paths via resolver
- [ ] `staging/suites.json` is non-empty and green (no `skipped`/`todo`)
- [ ] scenario + mock plan added/updated under `docs/user-scenarios/{{domain}}/`
- [ ] `checklist.md` present and current

## Описание

<!-- Что изменилось и зачем -->

## Тип изменения

- [ ] fix
- [ ] feat
- [ ] refactor / chore
