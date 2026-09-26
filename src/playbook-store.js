'use strict';

// Playbook registry — resolves/validates/renders the Playbook v1 contract.
// See issue #1372 (P0: registry + schema, no behavior change).
//
// A playbook is a versioned artifact, not a prompt. Rendering into a prompt is
// a derived, read-only operation; the JSON file is the source of truth. A
// running plan pins {playbook_id, playbook_version}, so editing a playbook
// never mutates an already-started task.
//
// Resolution order — highest precedence first:
//   1. profile custom : ~/users/<profile>/playbooks/<id>.json   (scope "profile")
//   2. sibling repo   : <repo-parent>/<domain-skill-repo>/playbooks/<id>.json
//   3. system repo    : <repo>/playbooks/<id>.json              (scope "system")
// Sibling and system files are repo-owned and therefore "system" scope (immutable
// via PR); only the profile level may declare scope "profile". The winning level
// is annotated on the returned object as `source`; the file location, not the
// declared field, is authoritative for scope.

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const { userWorkDir } = require('./data-paths');

const REPO_ROOT = path.resolve(__dirname, '..');
const REPO_PARENT = path.resolve(REPO_ROOT, '..');

const SYSTEM_PLAYBOOKS_DIR = path.join(REPO_ROOT, 'playbooks');

// Known domain-skill sibling checkouts (see server.js HH_SKILL_SIBLING /
// FREELANCE_SKILL_SIBLING). They are consulted only if present AND they carry a
// playbooks/ dir, so an absent sibling is simply skipped.
const DEFAULT_SIBLING_REPOS = ['trained-assist-engineering', 'trained-assist-freelance-skill', 'trained-assist-hh-skill'];

const PLAYBOOK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const schema = require('../contracts/playbook.schema.json');
const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
const validate = ajv.compile(schema);

function playbookError(code, message) {
  // Prefix the code so logs are self-describing and `toThrow(/CODE/)` works.
  return Object.assign(new Error(`[${code}] ${message}`), { code });
}

function defaultSiblingRoots() {
  // Explicit override (test/build environments that don't have the domain
  // checkouts on disk next to this repo). Delimiter-separated, e.g.
  // PLAYBOOK_SIBLING_ROOTS=/fixtures/trained-assist-engineering:/fixtures/other.
  const override = process.env.PLAYBOOK_SIBLING_ROOTS;
  if (override) {
    return override.split(path.delimiter).filter(Boolean);
  }
  return DEFAULT_SIBLING_REPOS
    .map(repo => path.join(REPO_PARENT, repo))
    .filter(dir => fs.existsSync(path.join(dir, 'playbooks')));
}

function formatAjvErrors(errors) {
  return (errors || [])
    .map(e => `${e.instancePath || '/'} ${e.message}`)
    .join('; ') || 'schema validation failed';
}

function validatePlaybook(playbook) {
  if (!validate(playbook)) {
    throw playbookError('INVALID_PLAYBOOK', formatAjvErrors(validate.errors));
  }
  return true;
}

// Substitute {placeholder} tokens with values from `vars`. Unknown placeholders
// are left verbatim (never silently blanked) — the same rule the executor will
// use when it renders instructions, so a missing value is visible, not lost.
function substitute(text, vars) {
  return String(text).replace(/\{(\w+)\}/g, (match, key) =>
    (vars && vars[key] != null) ? String(vars[key]) : match);
}

function hookLine(hook, vars) {
  const parts = [hook.type];
  if (hook.to) parts.push(`to=${hook.to}`);
  if (hook.text) parts.push(`"${substitute(hook.text, vars)}"`);
  return parts.join(' ');
}

function renderPlaybook(playbook, vars = {}) {
  const lines = [];
  lines.push(`# ${playbook.title} (${playbook.id} v${playbook.version}, ${playbook.source || playbook.scope})`);
  if (playbook.goal_template) lines.push(`Goal: ${substitute(playbook.goal_template, vars)}`);
  if (playbook.user_value_template) lines.push(`User value: ${substitute(playbook.user_value_template, vars)}`);

  (playbook.stages || []).forEach((stage, i) => {
    lines.push('');
    lines.push(`## ${i + 1}. ${stage.title} [${stage.id}]`);
    for (const hook of stage.on_enter || []) lines.push(`  on_enter: ${hookLine(hook, vars)}`);
    for (const step of stage.steps || []) {
      const contract = step.execution_kind === 'programmatic'
        ? 'programmatic'
        : `${step.executor_role}/${step.minimum_model_level}/${step.context_budget}`;
      lines.push(`- [${contract}] ${substitute(step.title, vars)}`);
      if (step.instructions) lines.push(`    instructions: ${substitute(step.instructions, vars)}`);
      lines.push(`    validation: ${Object.keys(step.validation || {}).join(', ')}`);
      if (step.max_attempts != null) lines.push(`    max_attempts: ${step.max_attempts}`);
      if (step.execution_timeout_seconds != null) lines.push(`    timeout: ${step.execution_timeout_seconds}s`);
      if (step.delay_after_sec != null) lines.push(`    delay_after_sec: ${step.delay_after_sec}`);
      for (const hook of step.on_complete || []) lines.push(`    on_complete: ${hookLine(hook, vars)}`);
      for (const hook of step.on_fail || []) lines.push(`    on_fail: ${hookLine(hook, vars)}`);
    }
    for (const hook of stage.on_exit || []) lines.push(`  on_exit: ${hookLine(hook, vars)}`);
  });

  if (playbook.hooks) {
    lines.push('');
    lines.push('## Task hooks');
    for (const [event, hooks] of Object.entries(playbook.hooks)) {
      for (const hook of hooks || []) lines.push(`  ${event}: ${hookLine(hook, vars)}`);
    }
  }
  return lines.join('\n');
}

class PlaybookStore {
  constructor({ profileId = null, systemDir = SYSTEM_PLAYBOOKS_DIR, siblingRoots = null } = {}) {
    this.profileId = profileId ? String(profileId) : null;
    this.systemDir = systemDir;
    this.siblingRoots = siblingRoots === null ? defaultSiblingRoots() : siblingRoots;
  }

  // Highest precedence first. Only the profile level is profile-scoped; sibling
  // and system files are repo-owned ("system" scope).
  _levels() {
    const levels = [];
    if (this.profileId) {
      levels.push({ kind: 'profile', scope: 'profile', dir: path.join(userWorkDir(this.profileId), 'playbooks') });
    }
    for (const root of this.siblingRoots) {
      levels.push({ kind: 'sibling', scope: 'system', dir: path.join(root, 'playbooks') });
    }
    levels.push({ kind: 'system', scope: 'system', dir: this.systemDir });
    return levels;
  }

  _files(dir) {
    try {
      return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => path.join(dir, f)).sort();
    } catch {
      return [];
    }
  }

  _load(file, level) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw playbookError('INVALID_JSON', `${file}: ${error.message}`);
    }
    validatePlaybook(raw);
    if (raw.scope !== level.scope) {
      throw playbookError('SCOPE_MISMATCH',
        `${file}: declared scope "${raw.scope}" does not match its ${level.kind} location (expected "${level.scope}")`);
    }
    return { ...raw, source: level.kind, path: file };
  }

  // Resolve one playbook at the winning level, or null if unknown. A malformed
  // higher-precedence file throws rather than silently falling through — a
  // broken profile override must not be masked by the system default.
  resolve(id) {
    if (typeof id !== 'string' || !PLAYBOOK_ID_RE.test(id)) return null;
    for (const level of this._levels()) {
      const file = path.join(level.dir, `${id}.json`);
      if (fs.existsSync(file)) return this._load(file, level);
    }
    return null;
  }

  get(id, version) {
    const playbook = this.resolve(id);
    if (!playbook) return null;
    if (version != null && playbook.version !== version) {
      throw playbookError('VERSION_NOT_FOUND',
        `playbook "${id}" version ${version} not found (resolved v${playbook.version} from ${playbook.source})`);
    }
    return playbook;
  }

  // Highest version declared for `id` across ALL levels (not just the winning
  // one), so a profile override can be numbered above the system playbook it
  // shadows. Returns 0 when the id is unknown everywhere. A malformed file at
  // any level throws (same strictness as resolve — never mask a broken file).
  maxVersion(id) {
    if (typeof id !== 'string' || !PLAYBOOK_ID_RE.test(id)) return 0;
    let max = 0;
    for (const level of this._levels()) {
      const file = path.join(level.dir, `${id}.json`);
      if (!fs.existsSync(file)) continue;
      const pb = this._load(file, level);
      if (pb.version > max) max = pb.version;
    }
    return max;
  }

  // List every playbook id visible to the profile, each at its winning level.
  // A malformed file is reported in `diagnostics` and does not crash the list
  // (the id may then resolve to a lower level, which the diagnostic makes visible).
  list() {
    const seen = new Map();
    const diagnostics = [];
    for (const level of this._levels()) {
      for (const file of this._files(level.dir)) {
        const base = path.basename(file, '.json');
        if (!PLAYBOOK_ID_RE.test(base)) {
          diagnostics.push({ file, code: 'INVALID_ID' });
          continue;
        }
        if (seen.has(base)) continue;
        try {
          seen.set(base, this._load(file, level));
        } catch (error) {
          diagnostics.push({ file, code: error.code || 'INVALID_PLAYBOOK', message: error.message });
        }
      }
    }
    const playbooks = [...seen.values()]
      .map(pb => ({
        id: pb.id,
        version: pb.version,
        scope: pb.scope,
        source: pb.source,
        title: pb.title,
        goal_template: pb.goal_template,
        path: pb.path,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return { playbooks, diagnostics };
  }
}

module.exports = {
  PlaybookStore,
  validatePlaybook,
  renderPlaybook,
  playbookError,
  SYSTEM_PLAYBOOKS_DIR,
  DEFAULT_SIBLING_REPOS,
  PLAYBOOK_ID_RE,
  _internal: { substitute },
};
