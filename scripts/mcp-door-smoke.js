#!/usr/bin/env node
'use strict';
/**
 * Smoke the MCP HTTP door of an agent host (issue #2114 P1).
 *
 * The door is what replaces "the engine runs on the same box as the skills":
 * POST /mcp/token mints a run-scoped token, POST /mcp answers JSON-RPC against
 * the same registry a local engine sees. This script is the acceptance check for
 * that door on a host that is not serving production traffic yet:
 *
 *   1. mint a token (host token or AGENT_SECRET, never printed),
 *   2. initialize / ping / tools/list,
 *   3. one real tools/call on a cheap tool,
 *   4. with --compare, the tool set of a second host, diffed by name.
 *
 * The compare is the part that matters when moving the door between hosts: a
 * consumer that gets a smaller catalog than it used to will not error, it will
 * quietly lose tools (playwright and capability-relay are never on this door).
 *
 *   node scripts/mcp-door-smoke.js --base https://169-58-15-230.sslip.io --profile vovako
 *   MCP_HOST_TOKEN=… node scripts/mcp-door-smoke.js \
 *     --base https://169-58-15-230.sslip.io/agent --profile alice \
 *     --compare https://136-65-7-197.sslip.io/agent --compare-secret-env AGENT_SECRET
 *
 * Secrets come from the environment only. Exit 0 ok · 1 a step failed · 2 usage
 * error · 3 the two hosts serve different tool sets.
 */
const fs = require('fs');

function parseArgs(argv) {
  const o = {
    base: null, profile: 'vovako', secretEnv: null, compare: null, compareSecretEnv: null,
    call: null, callArgs: {}, json: null, timeoutMs: 120000, expectTools: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') o.base = argv[++i];
    else if (a === '--profile') o.profile = argv[++i];
    else if (a === '--secret-env') o.secretEnv = argv[++i];
    else if (a === '--compare') o.compare = argv[++i];
    else if (a === '--compare-secret-env') o.compareSecretEnv = argv[++i];
    else if (a === '--expect-tools') o.expectTools = Number(argv[++i]);
    else if (a === '--call') o.call = argv[++i];
    else if (a === '--call-args') { try { o.callArgs = JSON.parse(argv[++i]); } catch { throw new Error('--call-args must be JSON'); } }
    else if (a === '--json') o.json = argv[++i];
    else if (a === '--timeout') o.timeoutMs = Number(argv[++i]);
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

// The door answers on <origin>/mcp; a base already carrying /agent (the form the
// bots and the run tokens are configured with) is used as given.
function doorUrl(base, path) {
  const trimmed = String(base).replace(/\/+$/, '');
  return trimmed.endsWith('/mcp') && path === '/mcp' ? trimmed : `${trimmed}${path}`;
}

async function rpc(url, token, message, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 400) }; }
  if (!res.ok) throw new Error(`${message.method} → HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  if (body.error) throw new Error(`${message.method} → JSON-RPC ${body.error.code}: ${body.error.message}`);
  return body.result;
}

async function probe(base, { profile, secret, timeoutMs, call, callArgs, label }) {
  const mintedUrl = doorUrl(base, '/mcp/token');
  const mintRes = await fetch(mintedUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ username: profile }),
    signal: AbortSignal.timeout(Math.min(timeoutMs, 30000)),
  });
  const mintText = await mintRes.text();
  if (!mintRes.ok) throw new Error(`${label} mint → HTTP ${mintRes.status}: ${mintText.slice(0, 300)}`);
  const { token, url: doorPath } = JSON.parse(mintText);
  if (!/^rt_[0-9a-f]{64}$/.test(token || '')) throw new Error(`${label} mint did not return a run token`);

  const mcpUrl = new URL(doorPath && doorPath.startsWith('/') ? doorPath : '/mcp', base).toString();
  const init = await rpc(mcpUrl, token, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-door-smoke', version: '1.0.0' } },
  }, timeoutMs);
  await rpc(mcpUrl, token, { jsonrpc: '2.0', id: 2, method: 'ping' }, timeoutMs);
  const list = await rpc(mcpUrl, token, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, timeoutMs);

  // /health has no auth and reports the commit — a tool set is only comparable
  // between hosts running the same code.
  let health = null;
  try {
    const h = await fetch(new URL('/health', base), { signal: AbortSignal.timeout(10000) });
    if (h.ok) health = await h.json();
  } catch { /* /health is informational */ }

  let callResult = null;
  if (call) {
    const r = await rpc(mcpUrl, token, {
      jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: call, arguments: callArgs },
    }, timeoutMs);
    callResult = { name: call, isError: !!r.isError, text: (r.content || []).map(c => c.text || '').join('\n').slice(0, 300) };
  }

  return {
    base, door: mcpUrl, profile,
    health,
    serverInfo: init.serverInfo,
    protocolVersion: init.protocolVersion,
    toolCount: (list.tools || []).length,
    tools: (list.tools || []).map(t => t.name).sort(),
    call: callResult,
  };
}

async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  if (opts.help || !opts.base) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 20).join('\n').replace(/^ \* ?/gm, ''));
    return opts.help ? 0 : 2;
  }
  const secret = process.env[opts.secretEnv || 'MCP_HOST_TOKEN'] || process.env.AGENT_SECRET;
  if (!secret) {
    console.error(`No minting credential: set ${opts.secretEnv || 'MCP_HOST_TOKEN'} (or AGENT_SECRET) in the environment. Secrets are never read from a file or a flag.`);
    return 2;
  }

  let host;
  try {
    host = await probe(opts.base, { profile: opts.profile, secret, timeoutMs: opts.timeoutMs, call: opts.call, callArgs: opts.callArgs, label: opts.base });
  } catch (e) {
    console.error(`❌ ${opts.base}: ${e.message}`);
    return 1;
  }

  console.log(`✅ ${host.base}`);
  console.log(`   door            ${host.door}`);
  console.log(`   profile         ${host.profile}`);
  console.log(`   server          ${host.serverInfo?.name} ${host.serverInfo?.version} (protocol ${host.protocolVersion})`);
  console.log(`   health          vm=${host.health?.vm ?? '?'} commit=${host.health?.commit ?? '?'}`);
  console.log(`   tools           ${host.toolCount}`);
  if (host.call) console.log(`   tools/call      ${host.call.name} → ${host.call.isError ? 'isError' : 'ok'}: ${host.call.text.split('\n')[0].slice(0, 160)}`);
  if (opts.expectTools != null) {
    if (host.toolCount < opts.expectTools) {
      console.error(`   ❌ only ${host.toolCount} tools, expected at least ${opts.expectTools} — a sibling checkout is probably missing on this host`);
      return 1;
    }
    console.log(`   ✅ at least ${opts.expectTools} tools as expected`);
  }
  console.log(`   catalog         ${host.tools.join(' ') || '(empty)'}`);

  let exit = 0;
  if (opts.compare) {
    const compareSecret = process.env[opts.compareSecretEnv || 'MCP_HOST_TOKEN'] || process.env.AGENT_SECRET;
    let other;
    try {
      other = await probe(opts.compare, { profile: opts.profile, secret: compareSecret, timeoutMs: opts.timeoutMs, call: null, callArgs: {}, label: opts.compare });
    } catch (e) {
      console.error(`❌ ${opts.compare}: ${e.message}`);
      return 1;
    }
    const only = (a, b) => a.filter(x => !b.includes(x));
    const mine = only(host.tools, other.tools);
    const theirs = only(other.tools, host.tools);
    console.log(`\n${opts.base} vs ${opts.compare}`);
    console.log(`   health          ${host.health?.commit || '?'} vs ${other.health?.commit || '?'}`);
    console.log(`   tools           ${host.toolCount} vs ${other.toolCount}`);
    if (!mine.length && !theirs.length) {
      console.log('   ✅ identical tool set');
    } else {
      console.log(`   only on ${opts.base}: ${mine.join(' ') || '(none)'}`);
      console.log(`   only on ${opts.compare}: ${theirs.join(' ') || '(none)'}`);
      if (host.health?.commit !== other.health?.commit) {
        console.log('   ⚠️  the two hosts run different commits — a diff here is expected; re-run once both are on the same sha');
      }
      exit = 3;
    }
  }

  if (opts.json) {
    fs.writeFileSync(opts.json, JSON.stringify({ host, comparedWith: opts.compare || null }, null, 2));
    console.log(`\n   snapshot        ${opts.json}`);
  }
  return exit;
}

main(process.argv.slice(2)).then(
  code => { process.exitCode = code; },
  e => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; },
);