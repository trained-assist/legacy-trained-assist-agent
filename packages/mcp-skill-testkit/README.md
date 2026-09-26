# @trained-assist/mcp-skill-testkit

Reusable harness for testing **domain-skill MCP servers**
(`trained-assist-<domain>-skill`). It wraps the bricks the core repo already uses,
so a domain repo stops vendoring them. The rules it serves live in
[`docs/domain-skill-repo-test-rules.md`](../../docs/domain-skill-repo-test-rules.md).

Add it as a devDependency:

```json
{ "devDependencies": { "@trained-assist/mcp-skill-testkit": "^0.1.0" } }
```

## API

```js
import {
  startMcpServer,        // spawn a real stdio MCP server
  fakeProvider,          // deterministic external-world provider
  replayFixtures,        // HTTP record/replay (nock)
  assertManifestConforms,// L1: manifest vs mcp-skill-sources.schema.json
  expectToolContract,    // L2: every tool returns a valid envelope
  checkDomainSkillRepo,  // the conformance gate (also a CLI)
} from '@trained-assist/mcp-skill-testkit';
```

### `startMcpServer({ entrypoint, env, workDir, args, timeoutMs })`

Spawns `entrypoint` as a subprocess with stdio JSON-RPC 2.0 and auto-runs
`initialize`. Returns `{ call(method, params), stop(), proc }`.

### `fakeProvider({ tools, flags })`

Returns `{ entrypoint, command, argv, flags, tools, env, start() }`.
`argv` is what you hand to a provider adapter; `start()` boots it as a real
server. Flags: `--fail-tool`, `--exit-on-call`, `--hang-on-call`, `--echo-env`.

### `replayFixtures(dir)`

Loads `*.json` fixtures from `dir` and installs them with nock, blocking
non-loopback outbound. Each fixture:

```json
{ "host": "api.hh.ru", "method": "get", "path": "/vacancies",
  "status": 200, "headers": {}, "response": {} }
```

Returns `{ fixtures, restore(), assertDone(), pendingMocks() }`.

### `assertManifestConforms(manifestPath, schemaPath?)`

Validates a manifest against `schema/mcp-skill-sources.schema.json` (a copy is
shipped so no core checkout is needed). Pass `schemaPath` to pin a core revision.

### `expectToolContract(call, tools, fixtures)`

For each `{ name, validArgs, expectedEnvelope?, expectError? }`, asserts
`tools/call` returns `{ content: [...] }`, or `isError` (never a crashed
process). Aggregates all violations into one thrown error.

### Isolation preload

```js
const guard = require.resolve('@trained-assist/mcp-skill-testkit/isolation-guard');
// NODE_OPTIONS=--require=<guard> with STAGING_ROOT etc. set
```

### Conformance CLI

```bash
npx mcp-skill-conformance /path/to/domain-skill-repo
```

Checks required artifacts, manifest conformance, a non-empty mandatory suite set
and the L3 static guards (no Claude spawn in tools, HTTP timeouts, no secret
logging, no inline `os.homedir()`).
