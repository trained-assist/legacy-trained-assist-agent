#!/usr/bin/env node
// CI gate for the domain-skill migration control plane (issue #1511).
//
// The matrix docs/migration/domain-skill-migration.json is the single source of
// truth for "where is each domain skill actually served". This check fails when
// it drifts from reality:
//   core: yes      -> the listed tool files exist under src/mcp-skills/tools/
//   domain: yes    -> scripts/staging/canaries/<skill>.json exists
//   serving:domain -> config/mcp-skill-sources.json has the source, enabled:true
//                     and a non-empty profiles allowlist containing canaryProfile
//
// Dependency-free and offline: fs + path only, JSON in, exit code out.
// Run: node scripts/check-migration-matrix.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULTS = {
  matrixPath: path.join(ROOT, 'docs/migration/domain-skill-migration.json'),
  toolsDir: path.join(ROOT, 'src/mcp-skills/tools'),
  canariesDir: path.join(ROOT, 'scripts/staging/canaries'),
  configPath: path.join(ROOT, 'config/mcp-skill-sources.json'),
};

const PLANS = new Set(['planned', 'in-progress', 'done', 'dropped']);
const CORE_FLAGS = new Set(['yes', 'no']);
const DOMAIN_FLAGS = new Set(['yes', 'unverified', 'no']);
const SERVING_FLAGS = new Set(['core', 'domain']);
export const REQUIRED = [
  'skill', 'domainName', 'repo', 'mcpServerId', 'actions', 'coreTools',
  'plan', 'core', 'domain', 'serving', 'canaryProfile', 'evidence', 'ownerIssue',
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function check(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const errors = [];
  const fail = msg => errors.push(msg);

  let matrix;
  try { matrix = opts.matrix !== undefined ? opts.matrix : readJson(o.matrixPath); }
  catch (e) { return { errors: [`cannot read matrix ${o.matrixPath}: ${e.message}`], summary: null }; }

  const entries = matrix && matrix.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    return { errors: ['matrix has no "entries" array'], summary: null };
  }

  let config;
  try { config = opts.config !== undefined ? opts.config : readJson(o.configPath); }
  catch (e) { return { errors: [`cannot read config ${o.configPath}: ${e.message}`], summary: null }; }
  const sources = config && Array.isArray(config.sources) ? config.sources : [];

  const tools = fs.existsSync(o.toolsDir) ? new Set(fs.readdirSync(o.toolsDir)) : new Set();
  const canaries = fs.existsSync(o.canariesDir) ? new Set(fs.readdirSync(o.canariesDir)) : new Set();
  const seen = new Set();

  for (const e of entries) {
    const id = (e && e.skill) || '<missing skill>';
    for (const key of REQUIRED) {
      if (!e || e[key] === undefined) fail(`${id}: missing required field "${key}"`);
    }
    if (e && e.skill) {
      if (seen.has(e.skill)) fail(`${id}: duplicate skill entry`);
      seen.add(e.skill);
    }
    if (e && !PLANS.has(e.plan)) fail(`${id}: invalid plan "${e.plan}"`);
    if (e && !CORE_FLAGS.has(e.core)) fail(`${id}: invalid core "${e.core}"`);
    if (e && !DOMAIN_FLAGS.has(e.domain)) fail(`${id}: invalid domain "${e.domain}"`);
    if (e && !SERVING_FLAGS.has(e.serving)) fail(`${id}: invalid serving "${e.serving}"`);
    if (e && (!e.canaryProfile || e.canaryProfile === '*')) {
      fail(`${id}: canaryProfile must be explicit and not "*"`);
    }

    if (e && e.core === 'yes') {
      if (!Array.isArray(e.coreTools) || e.coreTools.length === 0) {
        fail(`${id}: core=yes requires a non-empty coreTools[]`);
      } else {
        for (const tool of e.coreTools) {
          if (!tools.has(tool)) fail(`${id}: core=yes but src/mcp-skills/tools/${tool} is missing`);
        }
      }
    }

    if (e && e.domain === 'yes') {
      const canary = `${e.skill}.json`;
      if (!canaries.has(canary)) {
        fail(`${id}: domain=yes but scripts/staging/canaries/${canary} is missing`);
      }
    }

    if (e && e.serving === 'core' && e.core !== 'yes') {
      fail(`${id}: serving=core but core=${e.core}`);
    }

    if (e && e.serving === 'domain') {
      if (e.domain !== 'yes') fail(`${id}: serving=domain but domain=${e.domain}`);
      const src = sources.find(s => s && (s.id === e.skill || s.providerId === e.skill));
      if (!src) {
        fail(`${id}: serving=domain but no source in config/mcp-skill-sources.json`);
      } else {
        if (src.mcpServerId !== e.mcpServerId) {
          fail(`${id}: serving=domain mcpServerId mismatch (config "${src.mcpServerId}" vs matrix "${e.mcpServerId}")`);
        }
        if (src.enabled !== true) fail(`${id}: serving=domain but config source is not enabled`);
        if (!Array.isArray(src.profiles) || src.profiles.length === 0) {
          fail(`${id}: serving=domain but config source has no profiles allowlist`);
        } else if (!src.profiles.includes(e.canaryProfile)) {
          fail(`${id}: serving=domain but canaryProfile "${e.canaryProfile}" is not in config profiles`);
        }
      }
    }
  }

  return { errors, summary: { entries: entries.length } };
}

function main() {
  const { errors, summary } = check();
  if (errors.length) {
    console.error('❌ migration matrix check failed:');
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }
  console.log(`✅ migration matrix check passed (${summary.entries} domain skills)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
