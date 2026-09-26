# create-domain-skill

Scaffolds a `trained-assist-<domain>-skill` repo that already follows
[`docs/domain-skill-repo-test-rules.md`](../../docs/domain-skill-repo-test-rules.md):
three CI layers (L1 contract, L2 behavior, L3 guards), a deterministic
staging-gate, `@trained-assist/mcp-skill-testkit` wired in, `staging/suites.json`
and a `docs/user-scenarios/<domain>/` stub.

```bash
node packages/create-domain-skill/bin/create-domain-skill.mjs demo \
  --name "Demo" --repo trained-assist/trained-assist-demo-skill --dir ./trained-assist-demo-skill
```

Flags:

| Flag | Meaning |
|------|---------|
| `--name` | Human domain name used in docs (`{{domainName}}`) |
| `--repo` | `org/repo`, defaults to `trained-assist/trained-assist-<domain>-skill` |
| `--dir` | Target directory (default `./trained-assist-<domain>-skill`) |
| `--overwrite` | Allow writing into a non-empty target |

The generated repo passes `mcp-skill-conformance` out of the box; run
`npm install && npm test && npm run test:staging` inside it to verify.
