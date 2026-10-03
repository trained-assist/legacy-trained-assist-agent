// No hardcoded provider keys in the agent source (owner 2026-10-03).
//
// The agent must hold NO API keys for OpenRouter / OpenAI / OpenCode Go / Anthropic /
// etc. — every such call goes through the llm-ladder worker, which owns the key pool.
// Only Codex keys are allowed to remain (the owner keeps Codex in-process).
//
// This test scans every source file for ACTUAL key literals — a quoted string that
// starts with a vendor prefix and is long enough to be a real key. It deliberately
// ignores regex patterns (`sk-[A-Za-z0-9]{20,}`), env-var reads
// (`process.env.OPENCODE_GO_API_KEYS`) and masking utilities, which are not keys.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['src', 'scripts', 'config'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '__pycache__']);

// A real key literal: quoted, vendor prefix, then 20+ opaque chars.
// Regex patterns contain `[A-Za-z0-9]` / `\d` and are excluded by the "no metachar" rule.
// Placeholders (`ghp_xxxx…`, `sk-or-0000…`) are excluded: the tail must have ≥8
// distinct non-placeholder chars.
const KEY_RE = /["'`](sk-or-|oc_sk_|sk-ant-|sk-proj-|ghp_|gho_|ghu_|ghs_|ghr_|xox[baprs]-|AIza)([A-Za-z0-9_-]{20,})["'`]/g;

function isPlaceholder(tail) {
  // all same char, or only x/0/-/_ (common placeholder alphabet)
  if (/^(.)\1*$/.test(tail)) return true;
  const distinct = new Set(tail.replace(/[-_]/g, '').toLowerCase());
  return distinct.size <= 2 && [...distinct].every(c => 'x0'.includes(c));
}

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(p); }
    else if (e.isFile() && /\.(js|mjs|cjs|ts|cts|mts|json|ya?ml|env|sh)$/.test(e.name)) {
      yield p;
    }
  }
}

test('no hardcoded provider keys in the agent source (only Codex remains)', () => {
  const files = [];
  for (const d of SCAN_DIRS) files.push(...walk(path.join(ROOT, d)));
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f);
    for (const m of text.matchAll(KEY_RE)) {
      if (isPlaceholder(m[2])) continue;
      hits.push(`${rel}: ${m[0].slice(0, 40)}…`);
    }
  }
  assert.deepEqual(hits, [], `hardcoded keys found:\n  ${hits.join('\n  ')}`);
});
