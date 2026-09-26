# Testing sibling MCP servers (issue #1481)

Sibling skills (trained-assist-hh-skill, -freelance-skill, -engineering) are separate
repos whose `src/mcp-skills/index.js` the host mounts by path in `writeMcpConfig()`.
The host owns the contract at that junction; each rule is enforced on three layers
(consumer-driven contract: the consumer writes the check, every provider runs it):

| Layer | Where | What it catches |
|---|---|---|
| 1. Provider guard + test | each sibling repo: `src/mcp-skills/tool-result.js` (copy of host `src/mcp-tool-result.js`) + its own CI test | regression in the sibling, before its merge |
| 2. Host conformance kit | `scripts/check-mcp-conformance.js` — spawns the REAL `index.js` with a preloaded probe registry (no creds/network/deps) | any server, current or future, that lets an empty result reach the model; runs in host CI on `trained-skills` and on sibling checkouts where present |
| 3. Deploy gate | `scripts/deploy.sh` `sync_sibling_checked` — probes a sibling's new `origin/main` BEFORE the live checkout moves | a non-conforming sibling revision never goes live; the previous revision is kept, deploy of the host is not blocked |

Rules for new siblings: follow the `index.js` + `registry.js` (`listTools`/`callTool`)
shape (`scripts/check-skill-contract.js`), route tools/call through `toolResultText`,
and add the sibling to `sync_sibling_checked` in deploy.sh. When the guard text or
rules change, update the host module and every sibling copy in the same change set.
