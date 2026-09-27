Goal: Land #1573 — refresh the engineering-playbook master plan (slice A) and auto-offer the `development` playbook at dev-task start in the main bot (slice C).

- [ ] Slice A doc-refresh PR https://github.com/trained-assist/trained-assist-agent/pull/1574 — CI green
- [ ] Slice A doc-refresh PR https://github.com/trained-assist/trained-assist-agent/pull/1574 — merged to main
- [ ] Slice A doc-refresh PR https://github.com/trained-assist/trained-assist-agent/pull/1574 — deployed to prod (docs-only; verified live)
- [ ] Slice C PR (auto-offer at dev-task start) — CI green
- [ ] Slice C PR — merged to main
- [ ] Slice C — deployed to prod, verified live (dev task offers `development`; no-playbook profile unchanged)

Goal: headless /action + cron transport resolves and executes approved MCP sources (adapter/broker), falling back to sibling then core (#1533).

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1575
- [ ] Merged to main
- [ ] Deployed to prod — verified live
