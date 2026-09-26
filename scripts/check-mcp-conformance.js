'use strict';

// check-mcp-conformance.js — behavioural half of the skill contract (issue #1481).
//
// Sibling MCP servers (hh / freelance / engineering skills) are separate repos wired
// into writeMcpConfig() by path. The host owns the contract they must meet at that
// junction; check-skill-contract.js checks the static shape, this checks behaviour:
// every tools/call must give the model non-blank text — an empty tool result is
// turned into an explicit notice, never an empty block the model fills with a guess.
//
// How: spawn the repo's REAL src/mcp-skills/index.js with a preload that replaces its
// registry.js by a probe tool returning whatever `value` the call passes. So the real
// boundary code is exercised without credentials, network or the repo's dependencies.
//
// Usage: node scripts/check-mcp-conformance.js <path-to-skill-repo>
// Exit code 0 = conforms, 1 = violations. deploy.sh runs it on a sibling's new
// revision BEFORE switching the live checkout to it.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PRELOAD = path.join(__dirname, 'mcp-conformance-preload.cjs');
const EMPTY_VALUES = [
  ['absent', undefined], ['empty string', ''], ['blank string', '   '],
  ['empty array', []], ['empty object', {}], ['null', null],
];
const TIMEOUT_MS = 15000;

function rpcSession(indexPath, registryPath) {
  const child = spawn(process.execPath, ['--require', PRELOAD, indexPath], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', MCP_CONFORMANCE_REGISTRY: registryPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let buf = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p(msg); }
    }
  });
  child.stderr.on('data', (d) => { stderr += d; });
  let nextId = 1;
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out; stderr: ${stderr.slice(-500)}`)); }, TIMEOUT_MS);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { call, close: () => child.kill() };
}

// A serialised empty value ("null", "[]", "{}", "\"  \"") is still nothing to read.
function looksEmpty(text) {
  if (!text.trim()) return true;
  let v;
  try { v = JSON.parse(text); } catch { return false; }
  if (v === null) return true;
  if (typeof v === 'string') return !v.trim();
  if (Array.isArray(v)) return v.length === 0;
  return typeof v === 'object' && Object.keys(v).length === 0;
}

function responseText(msg) {
  const content = msg && msg.result && msg.result.content;
  if (!Array.isArray(content)) return null;
  return content.filter(c => c && c.type === 'text').map(c => String(c.text || '')).join('');
}

async function checkMcpConformance(repoPath) {
  const errors = [];
  const indexPath = path.join(repoPath, 'src', 'mcp-skills', 'index.js');
  const registryPath = path.join(repoPath, 'src', 'mcp-skills', 'registry.js');
  if (!fs.existsSync(indexPath)) return { ok: false, errors: [`missing MCP entrypoint: ${indexPath}`] };

  const rpc = rpcSession(indexPath, registryPath);
  try {
    const init = await rpc.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'conformance', version: '1' } });
    if (!init.result) errors.push(`initialize failed: ${JSON.stringify(init.error)}`);

    for (const [label, value] of EMPTY_VALUES) {
      const args = value === undefined ? {} : { value };
      const msg = await rpc.call('tools/call', { name: 'conformance_probe', arguments: args });
      const text = responseText(msg);
      const shown = text !== null && looksEmpty(text);
      if (text === null) errors.push(`tool returning ${label}: response has no text content (${JSON.stringify(msg).slice(0, 200)})`);
      else if (shown) errors.push(`tool returning ${label}: model receives ${JSON.stringify(text)} instead of an explicit empty-result notice`);
    }

    const ok = await rpc.call('tools/call', { name: 'conformance_probe', arguments: { value: { ok: 1 } } });
    if (!/"ok"\s*:\s*1/.test(responseText(ok) || '')) errors.push(`non-empty result is not passed through: ${JSON.stringify(ok).slice(0, 200)}`);
  } catch (e) {
    errors.push(e.message);
  } finally {
    rpc.close();
  }
  return { ok: errors.length === 0, errors };
}

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node scripts/check-mcp-conformance.js <path-to-skill-repo>');
    process.exit(2);
  }
  checkMcpConformance(path.resolve(target)).then(({ ok, errors }) => {
    for (const e of errors) console.error(`[error] ${e}`);
    console.log(ok ? 'PASS' : 'FAIL', `(${errors.length} errors)`);
    process.exit(ok ? 0 : 1);
  });
}

module.exports = { checkMcpConformance };
