# Plan: Register documents-skill + move tools from core

## Context

`trained-assist-documents-skill` exists as a fully functional domain skill server (deck, doc-export, gdrive, presentation-creation playbook) but is NOT registered in `skill-siblings.js` or `skill-catalog.json`. Core has duplicate tool files and the freelance-project-spec playbook that belongs in documents-skill.

## Step 1: Register documents-skill as a sibling

**`src/skill-siblings.js`** — add:
```js
{ id: 'documents', repo: 'trained-assist-documents-skill', mcpServerId: 'documents-skills' },
```

**`config/skill-catalog.json`** — add server + sections:
```json
"documents-skills": { "kind": "sibling", "repo": "trained-assist-documents-skill" }
```

New `documents` section:
```json
"documents": {
  "siblings": ["documents-skills"],
  "modules": ["documents-skills/10-deck.js", "documents-skills/20-doc-export.js"],
  "promptDomains": ["presentations"]
}
```

Update `gdrive` section:
```json
"gdrive": {
  "siblings": ["documents-skills"],
  "modules": ["documents-skills/50-gdrive.js"],
  "promptDomains": ["gdrive"]
}
```

## Step 2: Make PlaybookStore discover documents-skill playbooks

**`src/playbook-store.js`** — add `'trained-assist-documents-skill'` to `DEFAULT_SIBLING_REPOS` array (line ~36).

This makes both playbooks discoverable:
- `presentation-creation.json` (already in documents-skill)
- `freelance-project-spec.json` (after move in Step 3)

## Step 3: Move freelance-project-spec.json to documents-skill

**Move:** `trained-assist-agent/playbooks/freelance-project-spec.json` → `trained-assist-documents-skill/playbooks/freelance-project-spec.json`

The playbook references `lib/risk-engine.js` from `trained-assist-freelance-skill` — this cross-sibling dependency works because PlaybookStore resolves at runtime, and the agent process has all siblings checked out.

No change needed in `config/audience-default-playbooks.json` — PlaybookStore resolves by `id`, not file path.

## Step 4: Extract `deleteServiceAccount` from core's `50-gdrive.js`

`src/runner/quick/secrets.js` (line 11) imports `deleteServiceAccount` from core's `50-gdrive.js` — only caller.

**Create `src/gdrive-sa.js`** with:
- `getAdcToken()` — VM metadata token fetch
- `getSaEmail(userId)` — reads SA email from token file
- `deleteServiceAccount(userId)` — GCP IAM DELETE
- `GCP_PROJECT = 'trained-assist-gdrive-sa'`

Update `secrets.js` import: `require('../../gdrive-sa')`.

## Step 5: Delete core's `50-gdrive.js`

1030 lines removed. All gdrive tools now come from documents-skill sibling.

## Step 6: Delete `62-business-analyst.js` entirely

All 5 `ba_*` tools dropped:
- `ba_development_playbook` — engineering playbook wrapper (trivial, unused without playbook)
- `ba_clarify_requirements` — task size classifier
- `ba_write_spec` — spec.md writer
- `ba_client_spec_template` — client ТЗ template
- `ba_export_client_doc` — markdown→HTML/PDF/DOCX (duplicate of documents-skill's `doc_export`)

No other code imports from this file (verified via grep).

Rename not needed — file is deleted.

## Step 7: Update catalog sections

- Remove `freelance` section's reference to `62-business-analyst.js`
- If `freelance` section has no other modules, remove it or repurpose for freelance-skill tools
- `ba_development_playbook` is NOT moved to engineering — it's dropped with all `ba_*` tools

## Step 8: Verify

```bash
# documents-skill
cd /Users/vova/Code/trained-assist-documents-skill && npm run check && npm test

# core
cd /Users/vova/Code/trained-assist-agent && node scripts/check-env-sync.js && npm run check && npm test
```

## Files summary

| File | Action |
|------|--------|
| `src/skill-siblings.js` | Add documents entry |
| `config/skill-catalog.json` | Add server, add documents section, update gdrive section, remove freelance ba_* ref |
| `src/playbook-store.js` | Add `trained-assist-documents-skill` to DEFAULT_SIBLING_REPOS |
| `src/gdrive-sa.js` | **NEW** — deleteServiceAccount extracted from 50-gdrive.js |
| `src/runner/quick/secrets.js` | Update import path |
| `src/mcp-skills/tools/50-gdrive.js` | **DELETE** (1030 lines) |
| `src/mcp-skills/tools/62-business-analyst.js` | **DELETE** (347 lines) |
| `playbooks/freelance-project-spec.json` | **MOVE** to documents-skill |
