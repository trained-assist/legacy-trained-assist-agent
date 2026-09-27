#!/usr/bin/env node
'use strict';
// #1537 PR-E dry-run: propose workDir/skills.json per profile. READ-ONLY — writes
// nothing into profiles, only prints a markdown report.
//
// Proposal = sections whose tools the profile actually called in the last N days
// (engine transcripts in ~/.claude/projects/<escaped workDir>*/*.jsonl, tool_use
// names mcp__<server>__<tool>) + catalog audienceDefaults (recruiter → recruiting).
// Report shows what each profile would stop seeing vs today (all sections on).
//
// Usage: node scripts/skills-migration-dry-run.js [--users /home/vova/users] [--days 30]
const fs = require('fs');
const path = require('path');
const os = require('os');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1]; };
const USERS = arg('--users', process.env.USERS_DIR || path.join(os.homedir(), 'users'));
const DAYS = Number(arg('--days', 30));
const PROJECTS = arg('--transcripts', path.join(os.homedir(), '.claude', 'projects'));
const catalog = require('../config/skill-catalog.json');
const TOOLS_DIR = path.join(__dirname, '..', 'src', 'mcp-skills', 'tools');

// Catalog module entry → file: 'x.js' is a core module, '<server>/x.js' a sibling's (#1470).
function moduleFile(m) {
  if (!m.includes('/')) return path.join(TOOLS_DIR, m);
  const [server, file] = m.split('/');
  const { SKILL_SIBLINGS, siblingPaths } = require('../src/skill-siblings');
  const sib = SKILL_SIBLINGS.find(s => s.mcpServerId === server);
  return sib ? path.join(path.dirname(siblingPaths(sib).indexPath), 'tools', file) : null;
}

// tool name → section id
function toolSectionMap() {
  const modSection = {};
  const sibSection = {};
  for (const [id, s] of Object.entries(catalog.sections)) {
    for (const m of s.modules || []) modSection[m] = id;
    for (const sib of s.siblings || []) sibSection[sib] = id;
  }
  const byTool = {};
  for (const m of Object.keys(modSection)) {
    const file = moduleFile(m);
    if (!file || !fs.existsSync(file)) continue;
    // Same discovery as src/mcp-skills/registry.js: tool names are the keys of mod.tools.
    let names = [];
    try { names = Object.keys(require(file).tools || {}); } catch { /* fall back to source scan */ }
    if (!names.length) {
      const src = fs.readFileSync(file, 'utf8');
      names = [...src.matchAll(/^\s{2}([a-z][a-z0-9_]+):\s*\{/gm)].map(x => x[1]);
    }
    for (const n of names) byTool[n] ||= modSection[m];
  }
  return { byTool, sibSection };
}

function escapeDir(p) { return p.replace(/[^A-Za-z0-9]/g, '-'); }

function usedSections(workDir, map, sinceMs) {
  const prefix = escapeDir(workDir);
  const used = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS).filter(d => d === prefix || d.startsWith(prefix + '-')); } catch { return used; }
  for (const d of dirs) {
    const full = path.join(PROJECTS, d);
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(full, f);
      if (fs.statSync(fp).mtimeMs < sinceMs) continue;
      const text = fs.readFileSync(fp, 'utf8');
      for (const m of text.matchAll(/"name":"mcp__([a-z0-9-]+)__([a-z0-9_]+)"/g)) {
        const [, server, tool] = m;
        // *_status calls are connectivity probes («что подключено?»), not use of the section.
        if (/_status$/.test(tool)) continue;
        const sec = server === 'trained-skills' ? map.byTool[tool] : map.sibSection[server];
        if (!sec || catalog.sections[sec]?.always) continue;
        used.set(sec, (used.get(sec) || 0) + 1);
      }
    }
  }
  return used;
}

function audienceOf(workDir) {
  try {
    const raw = fs.readFileSync(path.join(workDir, 'sessions.json'), 'utf8');
    return /"audience"\s*:\s*"recruiter"/.test(raw) ? 'recruiter' : null;
  } catch { return null; }
}

// Collapse to top-level where every child is used; keep child ids otherwise.
function topLevel(ids) {
  return [...new Set(ids.map(id => id.split('/')[0]))].sort();
}

function main() {
  const map = toolSectionMap();
  const since = Date.now() - DAYS * 86400e3;
  const allTop = Object.keys(catalog.sections).filter(id => !id.includes('/') && !catalog.sections[id].always);
  const rows = [];
  for (const name of fs.readdirSync(USERS).sort()) {
    const workDir = path.join(USERS, name);
    if (!fs.statSync(workDir).isDirectory()) continue;
    const used = usedSections(workDir, map, since);
    const audience = audienceOf(workDir);
    const fromAudience = audience ? (catalog.audienceDefaults?.[audience]?.enabled || []) : [];
    const enabled = topLevel([...used.keys(), ...fromAudience]);
    const lose = allTop.filter(s => !enabled.includes(s));
    const calls = [...used.values()].reduce((a, b) => a + b, 0);
    rows.push({ name, audience, enabled, lose, calls, used: [...used.entries()].sort((a, b) => b[1] - a[1]) });
  }
  const active = rows.filter(r => r.calls > 0 || r.audience);
  const idle = rows.filter(r => !(r.calls > 0 || r.audience));
  const out = [];
  out.push(`# #1537 dry-run: предлагаемые skills.json (${new Date().toISOString().slice(0, 10)}, окно ${DAYS} дн.)`, '');
  out.push('Ничего не записано. Предложение = разделы, чьи тулы профиль реально вызывал + дефолт по аудитории (recruiter → recruiting). «Потеряет» = разделы, которые сейчас видны всем, а после записи skills.json скроются.', '');
  out.push(`Профилей: ${rows.length}; с активностью/аудиторией: ${active.length}; без вызовов тулов за ${DAYS} дн.: ${idle.length} (им skills.json не пишем — остаются legacy).`, '');
  out.push('| Профиль | Аудитория | Вызовов | Включить | Потеряет | Использовано (раздел×вызовы) |', '|---|---|---|---|---|---|');
  for (const r of active) {
    out.push(`| ${r.name} | ${r.audience || '—'} | ${r.calls} | ${r.enabled.join(', ') || '—'} | ${r.lose.join(', ')} | ${r.used.map(([s, n]) => `${s}×${n}`).join(', ') || '—'} |`);
  }
  if (idle.length) out.push('', `Без активности: ${idle.map(r => r.name).join(', ')}`);
  process.stdout.write(out.join('\n') + '\n');
}

if (require.main === module) main();
module.exports = { toolSectionMap, escapeDir, topLevel };
