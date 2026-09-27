'use strict';
// Domain instructions for the system prompt, gated per user (issue: system-prompt diet).
//
// The base prompt (src/agent-system-prompt.txt) is only the core. Domain rules live
// here as *.md files, each gated by the SAME isReady() that gates its tools in
// tools/list — so a user without HH/Weeek/GetCourse gets neither the tools nor the text.
//
// Front matter:
//   server: MCP server id in .mcp.json (trained-skills, hh-skills, …)
//   module: tools/<file> of that server whose isReady() decides
//   when:   ready | not-ready | present   (present = the module exists at all)
//
// Failure policy: if a server can't be probed, its `ready`/`present` blocks are
// included and `not-ready` ones dropped (old behaviour: over-inform, never hide a
// workflow the user actually has).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DOMAINS_DIR = __dirname;
const PROBE = path.join(__dirname, 'probe.js');

function parseDomainFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${path.basename(file)}: missing front matter`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  if (!meta.server || !meta.module || !['ready', 'not-ready', 'present'].includes(meta.when)) {
    throw new Error(`${path.basename(file)}: need server, module, when=ready|not-ready|present`);
  }
  return { name: path.basename(file, '.md'), ...meta, body: m[2].trim() };
}

function loadDomains(dir = DOMAINS_DIR) {
  return fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort()
    .map(f => parseDomainFile(path.join(dir, f)));
}

// tools dir of a registry-style server (…/mcp-skills/index.js → …/mcp-skills/tools)
function toolsDirOf(server) {
  const entry = server && Array.isArray(server.args) ? server.args[0] : null;
  if (!entry || path.basename(entry) !== 'index.js') return null;
  const dir = path.join(path.dirname(entry), 'tools');
  return fs.existsSync(dir) ? dir : null;
}

// → { serverId: {file: true|false|null} | null }   (null = not probeable)
function probeServers(mcpServers, { timeoutMs = 15000 } = {}) {
  const out = {};
  for (const [id, server] of Object.entries(mcpServers || {})) {
    const dir = toolsDirOf(server);
    if (!dir) { out[id] = null; continue; }
    const r = spawnSync(process.execPath, [PROBE, dir], {
      env: { ...(server.env || {}), PATH: process.env.PATH || '' },
      encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 20,
    });
    const at = (r.stdout || '').lastIndexOf('__PROBE__');
    try { out[id] = JSON.parse(r.stdout.slice(at + 9)); if (at < 0) throw new Error('no marker'); }
    catch { console.warn(`[prompt-domains] probe ${id} failed:`, (r.stderr || r.error?.message || '').slice(0, 200)); out[id] = null; }
  }
  return out;
}

function selectDomains(domains, probe) {
  return domains.filter(d => {
    if (!(d.server in probe)) return false;          // server not attached for this user
    const mods = probe[d.server];
    if (!mods) return d.when !== 'not-ready';         // unprobeable → fail open
    if (!(d.module in mods)) return false;            // module not shipped in this server
    const ready = mods[d.module];
    if (ready === null) return d.when !== 'not-ready';
    if (d.when === 'present') return true;
    return d.when === 'ready' ? ready : !ready;
  });
}

function buildDomainBlock(mcpConfigPath, opts = {}) {
  let servers = {};
  try { servers = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8')).mcpServers || {}; }
  catch (e) { console.warn('[prompt-domains] read mcp config:', e.message); return ''; }
  const probe = opts.probe || probeServers(servers);
  const picked = selectDomains(loadDomains(opts.dir), probe);
  // opts.report: caller-owned object filled with what was decided (skills shadow, #1537).
  if (opts.report && typeof opts.report === 'object') Object.assign(opts.report, { probe, picked: picked.map(d => d.name) });
  if (!picked.length) return '';
  return '# ПОДКЛЮЧЁННЫЕ СКИЛЫ — правила работы\n\n' + picked.map(d => d.body).join('\n\n') + '\n';
}

module.exports = { parseDomainFile, loadDomains, probeServers, selectDomains, buildDomainBlock, toolsDirOf };
