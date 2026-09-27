'use strict';

// Audience → default playbook resolver (issue #1372, slice P5).
//
// Maps a bot/surface ("audience" — see AUDIENCE-SCOPE-SPEC) to the playbook id
// that should be *suggested / pre-selected* for that surface. This module only
// SUGGESTS: it never compiles, runs or activates a plan. The draft→active gate
// (`task_update status=active`) stays entirely with the caller, so a suggestion
// is information, not an action.
//
// Resolution (highest precedence first, merged per audience key):
//   1. env  AUDIENCE_DEFAULT_PLAYBOOK        — JSON {audience: playbookId}
//   2. file AUDIENCE_DEFAULT_PLAYBOOK_CONFIG — JSON {version, playbooks:{...}}
//   3. built-in DEFAULT_AUDIENCE_PLAYBOOKS
// A per-audience miss falls back to the map's "default" entry, then to
// "feature" — a suggestion is never null and never an arbitrary string.

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '..', 'config', 'audience-default-playbooks.json');

const FALLBACK_PLAYBOOK_ID = 'feature';

// Built-in map mirrors config/audience-default-playbooks.json. Kept in code so a
// missing/removed config file never disables the suggestion.
const DEFAULT_AUDIENCE_PLAYBOOKS = Object.freeze({
  freelance: 'freelance-project-spec',
  exhibition: 'exhibition-catalog-to-sales-site',
  development: 'feature',
  default: 'feature',
});

const PLAYBOOK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function normalizeAudience(audience) {
  const value = audience == null ? '' : String(audience).trim().toLowerCase();
  return value || 'default';
}

// Accept both {playbooks:{audience:id}} and a bare {audience:id} object; drop
// entries that are not valid playbook ids so a typo can never become a suggestion.
function sanitizeMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw.playbooks && typeof raw.playbooks === 'object' && !Array.isArray(raw.playbooks)
    ? raw.playbooks : raw;
  const map = {};
  for (const [audience, id] of Object.entries(source)) {
    if (typeof id !== 'string' || !PLAYBOOK_ID_RE.test(id)) continue;
    map[normalizeAudience(audience)] = id;
  }
  return Object.keys(map).length ? map : null;
}

function readConfigFile(configPath) {
  const file = configPath || process.env.AUDIENCE_DEFAULT_PLAYBOOK_CONFIG || DEFAULT_CONFIG_PATH;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return { map: sanitizeMap(JSON.parse(raw)), path: file };
  } catch (error) {
    return { map: null, path: file, error: error.message };
  }
}

function readEnvMap(env) {
  const raw = (env || process.env).AUDIENCE_DEFAULT_PLAYBOOK;
  if (!raw) return null;
  try { return sanitizeMap(JSON.parse(raw)); }
  catch { return null; }
}

// Merge the three levels into one map, remembering where each entry came from.
// Env entries win over config entries win over built-ins, per audience key.
function loadAudiencePlaybookMap({ env = process.env, configPath = null, includeDiagnostics = true } = {}) {
  const entries = {};
  const set = (map, source) => {
    if (!map) return;
    for (const [audience, id] of Object.entries(map)) entries[audience] = { id, source };
  };
  set(DEFAULT_AUDIENCE_PLAYBOOKS, 'builtin');
  const fromFile = readConfigFile(configPath);
  set(fromFile.map, 'config');
  set(readEnvMap(env), 'env');
  const diagnostics = [];
  if (includeDiagnostics && fromFile.map == null && fromFile.error) {
    diagnostics.push({ file: fromFile.path, code: 'INVALID_CONFIG', message: fromFile.error });
  }
  return { entries, diagnostics, path: fromFile.path };
}

// Resolve the suggested playbook id for an audience. Always returns a string.
function resolveAudienceDefaultPlaybookId(audience, opts = {}) {
  const { entries } = loadAudiencePlaybookMap({ ...opts, includeDiagnostics: false });
  const key = normalizeAudience(audience);
  return (entries[key] && entries[key].id)
    || (entries.default && entries.default.id)
    || FALLBACK_PLAYBOOK_ID;
}

// Suggest/pre-select a playbook for an audience, verifying it actually resolves
// in the registry. Never throws; `available:false` means the suggestion points at
// an id the current profile cannot see (e.g. a sibling repo not checked out).
function suggestPlaybookForAudience(audience, { store = null, ...opts } = {}) {
  const { entries, diagnostics, path: configFile } = loadAudiencePlaybookMap(opts);
  const key = normalizeAudience(audience);
  const matched = entries[key];
  const entry = matched || entries.default || { id: FALLBACK_PLAYBOOK_ID, source: 'builtin' };
  const result = {
    audience: key,
    playbook_id: entry.id,
    source: entry.source,
    fallback: !matched,
    config_path: configFile,
    available: null,
  };
  if (diagnostics.length) result.diagnostics = diagnostics;
  if (store && typeof store.resolve === 'function') {
    try {
      const resolved = store.resolve(entry.id);
      result.available = Boolean(resolved);
      if (resolved) {
        result.playbook = { id: resolved.id, version: resolved.version, scope: resolved.scope, source: resolved.source };
      }
    } catch (error) {
      result.available = false;
      result.resolve_error = error.message;
    }
  }
  return result;
}

module.exports = {
  DEFAULT_AUDIENCE_PLAYBOOKS,
  DEFAULT_CONFIG_PATH,
  FALLBACK_PLAYBOOK_ID,
  normalizeAudience,
  loadAudiencePlaybookMap,
  resolveAudienceDefaultPlaybookId,
  suggestPlaybookForAudience,
};
