# assist-agent — systemd drop-ins (host-specific part of the unit)

`systemd/assist-agent.service` is the unit shared by every VM. What differs per
machine — storage roots, public URLs, the engine run-as pool — belongs here, as
a drop-in under `/etc/systemd/system/assist-agent.service.d/`, so a **new VM
boots from code** instead of from someone's hand-edited `/etc` (epic #1789 P1).

| File | What it holds | Installed by |
|------|---------------|--------------|
| `10-host-storage-roots.conf` | `AGENT_DATA_DIR`, `USERS_DIR`, `AGENT_TOKENS_DIR` + documented per-host vars (`VM_NAME`, `MAX_CONCURRENT_TASKS`, isolation switches) | `scripts/setup.sh` (new VM), or manually |

## Install / rollback (manual)

```bash
# install
sudo install -D -m0644 infra/systemd/assist-agent.service.d/10-host-storage-roots.conf \
  /etc/systemd/system/assist-agent.service.d/10-host-storage-roots.conf
sudo systemctl daemon-reload && sudo systemctl restart assist-agent

# rollback
sudo rm /etc/systemd/system/assist-agent.service.d/10-host-storage-roots.conf
sudo systemctl daemon-reload && sudo systemctl restart assist-agent

# verify both layers are what you expect
systemctl cat assist-agent
```

Editing a value: change it **here**, reinstall, `daemon-reload`, restart.
Never edit the copy under `/etc` by hand — the next install overwrites it.

## Engine isolation is a separate drop-in

`AGENT_RUN_AS_USERS` / `AGENT_ENV_ALLOWLIST` (issue #1649) are *not* set here:
the slot users must exist first, otherwise every engine run dies at
`sudo -n -u <slot>` while the service itself boots normally. Run
`scripts/ops/agent-isolation-setup.sh`, which creates the users, the sudoers
rule and the ACLs, then writes its own `agent-isolation.conf` drop-in.
