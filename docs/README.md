# docs/ — Index

Durable reference only. Plans, checklists, audits and reviews live in GitHub issues
(README rule: "This repo is for durable documents — plans and checklists are not").

| File | Description |
|------|-------------|
| [credential-store-migration.md](credential-store-migration.md) | Credential store encryption design (AES-256-GCM envelope) + the completed migration record |
| [llm-ladder-token.md](llm-ladder-token.md) | Где взять `LLM_LADDER_TOKEN`: три источника в порядке приоритета, выдача локально, проверка, отличие от `OPENCODE_LADDER_TOKEN` |
| [domain-skill-repo-test-rules.md](domain-skill-repo-test-rules.md) | Binding test & CI rules for domain skill repos (mcp-skill-testkit, 3 CI layers, replay gate) |
| [how-to-add-skill.md](how-to-add-skill.md) | Step-by-step guide: create a new MCP skill `.js` file in `src/mcp-skills/tools/` |
| [narrow-wide-bot-architecture-spec.md](narrow-wide-bot-architecture-spec.md) | Architecture sketch: agent-assistant + specialized bot pattern (narrow vs wide scope) |
| [skill-spec-template.md](skill-spec-template.md) | Template to fill in before implementing a new skill (external system analysis, API map) |
| [test-mode.md](test-mode.md) | Gateway test mode contract (`delivery:"log"`): no Telegram sends, answer in run-finished, log-mark released on run finish (regression R2) |
