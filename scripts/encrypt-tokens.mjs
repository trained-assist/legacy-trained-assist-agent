#!/usr/bin/env node
// One-time migration: encrypt every credential file under agent-tokens/ (epic #1789 P0 C4).
//
//   node scripts/encrypt-tokens.mjs --dry-run   # list what would change, touches nothing
//   node scripts/encrypt-tokens.mjs             # back up + encrypt in place
//
// What it does per file:
//   1. skips anything that is already a v2 envelope (idempotent — re-running is a no-op),
//   2. skips non-credentials (.chatid, .secrets_log, .username, gdrive-* caches, *.meta,
//      .index.json, hermes-research output) — see shouldEncrypt() in src/credential-store.js,
//   3. copies the original to agent-tokens/.backup-<timestamp>/<profile>/<file>,
//   4. rewrites the file through credential-store (AES-256-GCM + .meta sidecar + .index.json,
//      mode 0600).
//
// Requires CRED_ENCRYPTION_KEY (64 hex chars) unless --dry-run.
//
// ⚠️ Sibling domain repos (documents/gdrive, engineering/github, hh, sales/weeek,
// speech/deepgram) still read credential files with raw fs.readFileSync. Encrypting
// breaks them until they ship their own decrypt support — coordinate before running
// this against production.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { tokensRoot } = require('../src/data-paths.js');
const store = require('../src/credential-store.js');

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('Usage: node scripts/encrypt-tokens.mjs [--dry-run|-n]\n' +
    '  --dry-run   list the files that would be encrypted, change nothing\n' +
    'Root: agent-tokens (AGENT_TOKENS_DIR / AGENT_TOKENS_ROOT / $HOME/agent-tokens)');
  process.exit(0);
}
const DRY_RUN = argv.includes('--dry-run') || argv.includes('-n');

const root = tokensRoot();

if (!fs.existsSync(root)) {
  console.log(`[encrypt-tokens] nothing to do — ${root} does not exist`);
  process.exit(0);
}

const todo = [];
const already = [];
const skippedPlain = [];

function collect(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    console.warn('[encrypt-tokens] cannot read %s: %s', dir, e.message);
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;            // .backup-<ts> and other hidden dirs
      if (store.PLAINTEXT_DIRS.has(entry.name)) continue;   // hermes-research output, not credentials
      collect(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name === store.INDEX_FILE) continue;
    if (store.isMetaSidecar(entry.name)) continue;
    if (!store.shouldEncrypt(entry.name)) {
      skippedPlain.push(path.relative(root, full));
      continue;
    }
    let raw;
    try { raw = fs.readFileSync(full, 'utf8'); } catch (e) {
      console.warn('[encrypt-tokens] cannot read %s: %s', full, e.message);
      continue;
    }
    if (store.isEncrypted(raw)) { already.push(path.relative(root, full)); continue; }
    todo.push({ full, rel: path.relative(root, full), raw });
  }
}

collect(root);

console.log(`[encrypt-tokens] root=${root}`);
console.log(`[encrypt-tokens] ${todo.length} file(s) to encrypt, ${already.length} already encrypted, ${skippedPlain.length} non-credential file(s) skipped`);

if (DRY_RUN) {
  for (const t of todo) console.log(`  would encrypt: ${t.rel}`);
  if (todo.length) console.log('[encrypt-tokens] dry run — nothing written');
  process.exit(0);
}

if (!todo.length) {
  console.log('[encrypt-tokens] nothing to do — already migrated (idempotent)');
  process.exit(0);
}

if (!store.hasMasterKey()) {
  console.error('[encrypt-tokens] CRED_ENCRYPTION_KEY is not set (or is not 64 hex chars).');
  console.error('                 Generate one: openssl rand -hex 32');
  console.error('                 Then export it (or put it in secrets.env) and re-run.');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupRoot = path.join(root, `.backup-${stamp}`);
const mode = process.env.GCS_WORKSPACE_SYNC ? undefined : 0o600;

for (const t of todo) {
  const backupPath = path.join(backupRoot, t.rel);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.writeFileSync(backupPath, t.raw, { mode });
}

let done = 0;
const failures = [];
for (const t of todo) {
  try {
    store.writeCredentialFile(t.full, t.raw);
    done++;
  } catch (e) {
    failures.push(`${t.rel}: ${e.message}`);
  }
}

console.log(`[encrypt-tokens] encrypted ${done}/${todo.length} file(s); originals kept in ${backupRoot}`);
if (failures.length) {
  console.error('[encrypt-tokens] failures:');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log('[encrypt-tokens] done — verify with: node scripts/encrypt-tokens.mjs --dry-run');
