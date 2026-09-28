# Domain section manifest — who owns what in the skill catalog

Epic #1753. Schema: `contracts/skill-sections.schema.json`. Merge rules and their
executable proof: `src/skills/section-manifest.js`,
`test/skill-sections-manifest.test.cjs`.

## Why

`config/skill-catalog.json` in core used to list every module and prompt domain of
every sibling repo. So adding or removing a tool in a domain repo broke core's CI
(#1744), and moving a tool out of core always needed a second PR in core. A domain
repo now describes its own share in `config/skill-sections.json`; core keeps only what
is really core's.

## Ownership

| Owned by core (`config/skill-catalog.json`) | Owned by the domain (`config/skill-sections.json`) |
|---|---|
| `servers` — the mount registry (plus `src/skill-siblings.js`, `deploy.sh ensure_sibling`, the CI clone) | `modules` of **its own server**, bare file names (`90-hh.js`, not `hh-skills/90-hh.js`) |
| section **ids** and the tree (`recruiting/hh` is a child of `recruiting`) | `promptDomains` whose files live in the repo's `src/prompt-domains/` |
| `always: true` (only `core`) | `mount: true` — mount the whole server when the section is on (core's old `siblings`) |
| `audienceDefaults` | `pinned` — tools of its own server always listed when the section is on |
| sections made only of core modules | `title` of a section the domain wholly owns |

**Section ids are core's contract** with every profile's `skills.json` and with
`audienceDefaults`: renaming one is a migration of all profiles. A new section is
registered in core **once** (an empty `"my-section": {}` is enough); from then on the
domain adds, removes and regroups its tools without ever touching core.

## Manifest

```jsonc
// trained-assist-hh-skill/config/skill-sections.json
{
  "version": 1,
  "server": "hh-skills",
  "sections": {
    "recruiting":           { "modules": ["97-candidate-client-report.js"] },
    "recruiting/hh":        { "title": "HeadHunter", "mount": true,
                              "modules": ["90-hh.js", "91-hh-discovery.js", "…"],
                              "promptDomains": ["hh", "hh.setup", "hh-notify"] },
    "recruiting/interview": { "modules": ["99-interview-analysis.js"] },
    "demo":                 { "title": "Демо-режим рекрутинга", "modules": ["98-demo.js"] }
  }
}
```

A section entry needs at least one of `modules`, `promptDomains` or `mount: true`.
`always` and `siblings` are rejected — they are core's.

## Merge (core side, `mergeManifests`)

- **Union, never replace.** `recruiting/interview` keeps core's `95-video-analysis.js`
  and gains `hh-skills/99-interview-analysis.js`.
- **Title:** core's title wins; the domain's is used when core's section has none.
- **Unknown section id** → warning, entry skipped (ids are registered in core).
- **Server not a registered sibling** → warning, whole manifest skipped.
- **Prompt-domain name claimed by two owners** (core↔sibling or sibling↔sibling) →
  hard error naming both. The old loader was "first name wins, core first" — a
  collision would silently bypass one owner's prompt rules.
- A manifest that can't be read or fails the schema → warning and fall back to core's
  own entries for that server (P1, expand/contract), never a broken profile.

## Where each check lives

- **Domain repo CI:** the manifest is schema-valid, and it covers exactly the files in
  `src/mcp-skills/tools/` (no unlisted, no gone). The repo that holds both files is
  the only place that can check them without cross-repo coupling.
- **Core CI:** the core catalog references no foreign server (after P4); the merge
  contract (`test/skill-sections-manifest.test.cjs`); wiring of mounts
  (`test/sibling-wiring.test.cjs`).

## Rollout (epic #1753)

P0 this contract → P1 core reads manifests with fallback to its own entries (behaviour
identical, proven by the round-trip test) → P2 hh-skill ships its manifest, core drops
`hh-skills/*` → P3 the other siblings → P4 core's completeness contract flips to
"local modules only" → P5 live acceptance.
