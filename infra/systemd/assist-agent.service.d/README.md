# assist-agent — systemd drop-ins (host-specific part of the unit)

`systemd/assist-agent.service` is the unit shared by every VM. What differs per
machine — storage roots, identity, public origins, capacity — belongs in a
drop-in under `/etc/systemd/system/assist-agent.service.d/`, so a **new VM
boots from code** instead of from someone's hand-edited `/etc` (epic #1789 P1,
issue #2114 P0.2).

| File | What it holds | Installed by |
|------|---------------|--------------|
| `10-host-storage-roots.conf` | `AGENT_DATA_DIR`, `USERS_DIR`, `AGENT_TOKENS_DIR` — identical on every host, so one copy serves all | `scripts/setup.sh` (new VM), or manually |
| `../host/<vm-name>.conf` | `VM_NAME`, `AGENT_PUBLIC_URL`, `HH_PLATFORM_URL`, `CRON_SCHEDULER_ROLE`, `MAX_CONCURRENT_TASKS` — one file per host, installed as `20-host-identity.conf` | `scripts/ops/install-host-config.sh <vm-name>` |

Per-host values live in `infra/systemd/host/<vm-name>.conf`, **not** in the
directory above: a file that is copied to *every* box cannot hold what differs
between them. That mistake is what this split exists to prevent — the shared
unit carried `VM_NAME=gcp-main` and GCP's public URLs, so VM2 started as
`gcp-main`, minted connect-links pointing at the host being shut down, and
inherited `CRON_SCHEDULER_ROLE=primary` (every cron job, twice).

## Install / rollback (manual)

```bash
# what is on this host right now
bash scripts/ops/install-host-config.sh --list

# install this host's identity/origins/cron role (backs up any hand-written copy)
sudo bash scripts/ops/install-host-config.sh gcp-main          # or contabo-vm2

# storage roots only (already identical everywhere)
sudo install -D -m0644 infra/systemd/assist-agent.service.d/10-host-storage-roots.conf \
  /etc/systemd/system/assist-agent.service.d/10-host-storage-roots.conf

# rollback
sudo rm /etc/systemd/system/assist-agent.service.d/20-host-identity.conf
sudo systemctl daemon-reload && sudo systemctl restart assist-agent

# verify both layers are what you expect
systemctl cat assist-agent
```

Editing a value: change it **here**, reinstall, `daemon-reload`, restart.
Never edit the copy under `/etc` by hand — the next install overwrites it.
`test/host-unit-config.test.cjs` fails the build if a per-host value returns to
the shared unit, or if a host's drop-in drifts from
`infra/env-manifest.json → systemd_env_vars.<vm-name>`.

## Adding a host

1. `infra/env-manifest.json → vms.<key>`: vm_name, ip, sslip, service, ssh_user.
2. `infra/systemd/host/<vm_name>.conf`: identity, origins, cron role, capacity.
3. `infra/env-manifest.json → systemd_env_vars.<vm_name>`: the same values, described.
4. `infra/nginx/<site>.conf` + a `DEPLOY_ENV` branch in `scripts/deploy-nginx.sh`
   if the host needs a public door.
5. `node --test test/host-unit-config.test.cjs` — it checks 1–3 agree.

## Engine isolation is a separate drop-in

`AGENT_RUN_AS_USERS` / `AGENT_ENV_ALLOWLIST` (issue #1649) are *not* set here:
the slot users must exist first, otherwise every engine run dies at
`sudo -n -u <slot>` while the service itself boots normally. Run
`scripts/ops/agent-isolation-setup.sh`, which creates the users, the sudoers
rule and the ACLs, then writes its own `agent-isolation.conf` drop-in.
