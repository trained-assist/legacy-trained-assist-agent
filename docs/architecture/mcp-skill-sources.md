# Approved MCP skill sources (issue #1271, PR1)

This slice is additive: the production MCP routing/config remains unchanged.
The default config has no sources. PR2 must replace direct external MCP
launches with the core managed adapter and call acquireAction at spawn; a
discovery result alone is never permission to launch an executable.

## Authority and lifetime

ActionProviderRegistry owns action policy. McpSkillSourceRegistry owns release
identity and per-profile installation eligibility. An approved source includes
the complete static provider manifest and the SHA-256 of artifact-manifest.json.
Both belong to the admin-owned config, independently of executable storage.
Runtime does not import provider JS or execute git/npm.

Config schema: contracts/mcp-skill-sources.schema.json. Config version 1 accepts
manifest v1 and v2. mcpServerId is explicit, independent of providerId: migration
must preserve existing client names (in particular hh-skills).

Each immutable registry instance represents one config generation. Invalid
source metadata is rejected without actions. For duplicate source IDs, provider
IDs, server IDs or action names, ALL conflicting sources are rejected, regardless
of config order. Core providers win over external sources. A rejected source
cannot partly register actions. Diagnostics distinguish invalid_metadata/conflict.

Valid approved metadata registers even when its artifact is absent, corrupted or
disabled. Unknown action is ACTION_NOT_FOUND; an approved but unavailable action
is PROVIDER_UNAVAILABLE. listTools(profileId) omits unavailable/ineligible sources.
profiles is an explicit allowlist; empty means no access. Availability is installation
readiness only; provider credential readiness and invokeAction policy remain
separate gates in PR2/PR3. Globally approved never means enabled for all profiles.

## Prepare, activate, roll back

Use a clean checkout with its GitHub origin and HEAD matching the approved repo
and exact 40-character commit SHA. Provide JSON options:

```json
{
  "checkout": "/srv/checkouts/example",
  "root": "/srv/mcp-skills",
  "id": "example",
  "providerId": "example",
  "mcpServerId": "example-skills",
  "repository": "trained-assist/example",
  "revision": "<exact approved SHA>",
  "manifestVersion": 2,
  "entrypoint": "src/mcp-skills/index.js",
  "manifest": "provider-manifest.json",
  "profiles": ["approved-profile"]
}
```

```sh
node scripts/prepare-mcp-skill-artifact.js prepare options.json > approved-source.json
```

Preparation archives only committed files (no .git or ignored/untracked working
files), requires a package-lock.json, and installs production dependencies using
npm ci --omit=dev --ignore-scripts with a minimal environment. Install scripts
are deliberately unsupported in this artifact profile; providers needing native
build hooks require an explicit build contract before onboarding.

The resulting release contains repo/ and artifact-manifest.json. Checksums cover
all files including installed dependencies, directories, executable bits and
relative symlink targets. Escaping/absolute symlinks, hardlinks and special files
are refused. Entrypoint, provider manifest and artifact path may not traverse
symlink components. Read-only bytes/directories are published by same-parent
rename; the approved config pins the resulting metadata digest. The metadata
also records Node/platform/architecture and the lockfile digest.

Prepare a whole config {version:1,sources:[...]} retaining other approved sources.
Then pass {root,configPath,config} in an activation JSON file:

```sh
node scripts/prepare-mcp-skill-artifact.js activate activation.json
```

Activation validates every source, rejects conflicts and unavailable enabled
artifacts, writes/fsyncs the new config and atomically renames it. The previous
config is retained as <configPath>.<sha256>.previous. Rollback uses that whole
config through the same activate operation. No release is deleted automatically.
Deploy should serialize admin updates, construct the new registry before swapping
it, and retain previous releases until children exit and rollback retention ends.
PR1 does not add live reload or switch the production runtime.

## Integrity and costs

Read-only is a deployment contract for trusted code, not an OS sandbox. A process
with the same UID can chmod files; a hostile same-UID writer is outside v1's trust
boundary. Runtime rehashes the entire release on every availability/resolve
check, including dependencies; cost scales with artifact size and action calls.
Do not cache verification by pathname/mtime. acquireAction creates a private
execution copy and verifies it again after copying, so a deployment pathname
replacement cannot change the approved bytes a child sees. Use its entrypoint
and call release after child exit (including failure/timeout); retain the lease
while a child is alive. The cheaper resolveAction is discovery only.

Full dependency trees and per-child execution copies increase disk/IO cost.
PR2 must recover abandoned execution copies after crash without deleting live
children's leases. No downloads, package
installs, credential checks or paid requests occur in discovery. Approval changes
require an admin/deploy operation. Real production onboarding and HH/Freelance
cutover are explicitly later slices and must pass CI/staging at their exact SHA.

## Sibling fallback and the core <-> domain switch (#1470 P0.1c, #1511)

Before a source is activated, a domain skill is mounted the legacy way: the core
repo registers the sibling checkout's MCP server in the engine's `.mcp.json`
visible only when that checkout exists (`src/browser.js`). Once a source is
activated for a profile, the host source runtime materializes the sealed adapter
server for the run and `writeMcpConfig()` **prefers it over the sibling** — a
sibling is registered only when the run has no sealed server for that MCP server
id. This makes `serving` a pure admin-config switch:

- **core -> domain (cutover):** `prepare` the source, then `activate` a config
  that enables it for the profile allowlist (`profiles`). The profile now gets
  37 hh tools from the sealed adapter; profiles outside the allowlist keep the
  sibling fallback, so `hh_connect` still works for new recruiters.
- **domain -> core (rollback):** re-`activate` the retained previous config
  (`<configPath>.<sha256>.previous`), or publish `{version:1,sources:[]}`. The
  runtime becomes disabled and the sibling fallback serves the profile again —
  **no code change and no redeploy** (covered by
  `tests/hh-sealed-source-toggle.test.js`).

The runtime reads the admin config from `MCP_SKILL_SOURCES_CONFIG` (default
`config/mcp-skill-sources.json`); the artifact lives under `MCP_SKILLS_ROOT`
(see `systemd/assist-agent.service` for the production paths). The checked-in
`config/mcp-skill-sources.json` stays empty, so a deploy without a prepared
artifact simply falls back to the sibling.

Proven live on the sandbox profile `trained-assist-product-owner` at hh revision
`2d194cd4a65f9ff3888aacdeea87afc33b0971b4` (artifactDigest
`72948f19a059a0dbf036110e6ae040918fc7b3e73828fa032b8c008fcd64b80d`): the
`hh_list_vacancies` read-only call returned `output.total = 1` through
runtime -> adapter -> broker -> provider, and rolling back to the `.previous`
config resolved `hh-skills` to the sibling `node
.../trained-assist-hh-skill/src/mcp-skills/index.js`.
