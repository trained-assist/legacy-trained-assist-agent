# Plan: Register documents-skill + move tools from core

## Context

`trained-assist-documents-skill` exists at `/Users/vova/Code/trained-assist-documents-skill` as a fully functional domain skill server (deck, doc-export, gdrive tools) but is NOT registered in `skill-siblings.js` or `skill-catalog.json`. Core still has duplicate tool files (`50-gdrive.js`, `62-business-analyst.js`). The goal: follow the same pattern as the hh-skill — register the sibling, move tools, remove duplicates.

## Step 1: Register documents-skill as a sibling

**`src/skill-siblings.js`** — add entry:
```js
{ id: 'documents', repo: 'trained-assist-documents-skill', mcpServerId: 'documents-skills' },
```

**`config/skill-catalog.json`** — add server:
```json
"documents-skills": { "kind": "sibling", "repo": "trained-assist-documents-skill" }
```

Add new `documents` section:
```json
"documents": {
  "siblings": ["documents-skills"],
  "modules": ["documents-skills/10-deck.js", "documents-skills/20-doc-export.js"],
  "promptDomains": ["presentations"]
}
```

Update `gdrive` section to use sibling:
```json
"gdrive": {
  "siblings": ["documents-skills"],
  "modules": ["documents-skills/50-gdrive.js"],
  "promptDomains": ["gdrive"]
}
```

## Step 2: Extract `deleteServiceAccount` from core's `50-gdrive.js`

`src/runner/quick/secrets.js` imports `deleteServiceAccount` from core's `50-gdrive.js` (line 11). Only caller.

**Fix:** Create `src/gdrive-sa.js` — small module with just the SA deletion logic (uses ADC token + GCP IAM API). Update `secrets.js` to import from there.

Functions needed from core's `50-gdrive.js`:
- `getAdcToken()` — fetches VM metadata token (lines 28–36)
- `getSaEmail(userId)` — reads SA email from token file (inline helper)
- `GCP_PROJECT` constant = `'trained-assist-gdrive-sa'`

## Step 3: Delete core's `50-gdrive.js`

After step 2, no core code imports from it. Delete the file (1030 lines). The `gdrive` section in catalog now points to `documents-skills/50-gdrive.js`.

## Step 4: Clean up `62-business-analyst.js`

The file has 5 tools with mixed concerns:
- **BA workflow** (keep in core): `ba_development_playbook`, `ba_clarify_requirements`, `ba_write_spec`
- **Document export** (remove — covered by documents-skill's `doc_export`): `ba_client_spec_template`, `ba_export_client_doc`

**Action:** Remove `ba_client_spec_template` + `ba_export_client_doc` + helper functions (`transformWideTables`, `splitRow`, `escapeHtml`, `DOC_CSS`) from the file. Remove `pandoc`/`playwright` imports that only served those tools.

**Rename:** `62-business-analyst.js` → `62-requirements.js` (now contains only requirement analysis tools).

Update catalog: `freelance` section modules → `["62-requirements.js"]`.

Also move `ba_development_playbook` to `engineering-skills` section (it's a development playbook, not freelance-specific). This means creating a small tool file in `trained-assist-engineering` or adding it to an existing file there.

## Step 5: Move tests

Core has **zero** document-related tests. Documents-skill already has full test coverage:
- `deckgen.test.js`, `doc-export.test.js`, `google-auth.test.js`
- `mcp-empty-result.test.js`, `skills-gating.test.js`, `presentation-playbook.test.js`

**No tests to move FROM core.** Just verify documents-skill tests pass.

## Step 6: Verify

```bash
# documents-skill
cd /Users/vova/Code/trained-assist-documents-skill && npm run check && npm test

# core
cd /Users/vova/Code/trained-assist-agent && node scripts/check-env-sync.js && npm run check && npm test

# After deploy on VM:
curl -s -H "Authorization: Bearer $AGENT_SECRET" http://localhost:3000/skills | jq '.[] | select(.server == "documents-skills")'
```

## Files to modify

| File | Action |
|------|--------|
| `src/skill-siblings.js` | Add documents entry |
| `config/skill-catalog.json` | Add server, add documents section, update gdrive/freelance sections |
| `src/gdrive-sa.js` | **NEW** — `deleteServiceAccount` extracted from `50-gdrive.js` |
| `src/runner/quick/secrets.js` | Update import path for `deleteServiceAccount` |
| `src/mcp-skills/tools/50-gdrive.js` | **DELETE** |
| `src/mcp-skills/tools/62-business-analyst.js` | Remove doc-export tools, rename to `62-requirements.js` |
