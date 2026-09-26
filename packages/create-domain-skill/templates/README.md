# {{repository}}

{{domainName}} domain skill — an MCP server (stdio JSON-RPC) served by the
trained-assist Agent Control Plane. Follows
[`docs/domain-skill-repo-test-rules.md`](https://github.com/trained-assist/trained-assist-agent/blob/main/docs/domain-skill-repo-test-rules.md).

## Layers

| Layer | Command | What it proves |
|-------|---------|----------------|
| L1 contract | `npm run test:contract` | manifest conformance, artifact digest, tool-name parity |
| L2 behavior | `npm run test:behavior` | real stdio server + fixtures, no network |
| L3 guards | `npm run conformance` | required artifacts, mandatory suites, static guards |
| staging-gate | `npm run test:staging` | isolated deterministic replay |

## Develop

```bash
npm install
npm test
npm run test:staging
npm run manifest:sync   # refresh revision + artifactDigest before a release
```

Add tools under `src/mcp-skills/tools/NN-name.js`; the registry auto-discovers
them. Record a fixture for every tool and list it in `staging/suites.json`.
