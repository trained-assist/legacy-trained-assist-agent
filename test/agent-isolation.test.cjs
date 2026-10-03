'use strict';
// T0 agent process hardening (issue #1649) — everything that can be checked
// without creating unix users. The real cross-user check (profile A cannot read
// profile B / the server secrets file) is test/agent-isolation-e2e.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-iso-'));
process.env.AGENT_MCP_BRIDGE_DIR = path.join(tmpRoot, 'bridge');

const iso = require('../src/agent-isolation');
const tokens = require('../src/agent-run-tokens');
const bridge = require('../src/agent-mcp-bridge');
const { runEngineProcess } = require('../src/runner/claude-runner');
const { prepareEngineSpawn } = require('../src/runner/engine-isolation');
const { writeRunMcpConfig } = require('../src/browser');

const SERVER_ENV = {
  PATH: process.env.PATH,
  AGENT_SECRET: 'srv-agent-secret',
  TELEGRAM_BOT_TOKEN: 'srv-bot-token',
  DEEPGRAM_API_KEY: 'srv-deepgram',
  OPENROUTER_API_KEY: 'srv-openrouter',
  INN_DADATA_SECRET: 'srv-dadata',
  SOME_SERVER_ONLY_SETTING: 'srv-other',
};
const SERVER_VALUES = Object.entries(SERVER_ENV).filter(([k]) => k !== 'PATH').map(([, v]) => v);

function writeExe(file, body) {
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
  return file;
}

// ── env allowlist ─────────────────────────────────────────────────────────────

test('buildAgentEnv keeps engine vars, run identity and profile tokens; drops server secrets', () => {
  const env = iso.buildAgentEnv({
    ...SERVER_ENV, HOME: '/h', LANG: 'C.UTF-8', LC_ALL: 'C', ANTHROPIC_MODEL: 'm',
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0', AGENT_USER_ID: 'alice', AGENT_CHAT_ID: '1',
    AGENT_BOT_TOKEN: 'bot', CLOUDFLARE_API_TOKEN: 'cf', GH_TOKEN: 'profile-gh', AGENT_SESSION_FILE: '/x',
  }, { userTokenNames: ['GH_TOKEN', 'AGENT_SECRET'], extra: { AGENT_RUN_TOKEN: 'rt_x', TELEGRAM_BOT_TOKEN: 'nope' } });
  for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS', 'AGENT_USER_ID', 'GH_TOKEN', 'AGENT_RUN_TOKEN']) {
    assert.ok(k in env, `${k} kept`);
  }
  for (const k of ['AGENT_SECRET', 'TELEGRAM_BOT_TOKEN', 'DEEPGRAM_API_KEY', 'OPENROUTER_API_KEY', 'INN_DADATA_SECRET', 'SOME_SERVER_ONLY_SETTING', 'AGENT_BOT_TOKEN', 'CLOUDFLARE_API_TOKEN', 'AGENT_SESSION_FILE']) {
    assert.ok(!(k in env), `${k} dropped`);
  }
});

test('isolationConfig: off by default, run-as implies the allowlist, bad names ignored', () => {
  assert.deepEqual([iso.isolationConfig({}).envAllowlist, iso.isolationConfig({}).runAs], [false, false]);
  assert.equal(iso.isolationConfig({ AGENT_ENV_ALLOWLIST: '1' }).envAllowlist, true);
  const c = iso.isolationConfig({ AGENT_RUN_AS_USERS: 'ta-agent-1, ta-agent-2,Bad;rm' });
  assert.deepEqual(c.runAsUsers, ['ta-agent-1', 'ta-agent-2']);
  assert.equal(c.envAllowlist, true);
});

// ── run tokens ────────────────────────────────────────────────────────────────

test('run tokens are scoped, header-parsed and revocable', () => {
  const t = tokens.issueRunToken({ taskId: 'alice-1', username: 'alice' });
  assert.match(t, /^rt_[0-9a-f]{64}$/);
  assert.deepEqual({ ...tokens.verifyRunToken(t), issuedAt: 0 }, { taskId: 'alice-1', username: 'alice', issuedAt: 0 });
  assert.equal(tokens.runTokenFromAuthHeader(`Bearer ${t}`).taskId, 'alice-1');
  assert.equal(tokens.runTokenFromAuthHeader('Bearer srv-agent-secret'), null);
  assert.equal(tokens.verifyRunToken('rt_' + '0'.repeat(64)), null);
  tokens.revokeRunToken(t);
  assert.equal(tokens.verifyRunToken(t), null);
});

// ── MCP config on disk ────────────────────────────────────────────────────────

test('bridged MCP config on disk carries no server env; real specs stay in memory', () => {
  const workDir = fs.mkdtempSync(path.join(tmpRoot, 'mcpcfg-'));
  const prev = process.env.AGENT_SECRET;
  process.env.AGENT_SECRET = 'srv-agent-secret-on-disk-check';
  try {
    const { mcpConfig, servers } = writeRunMcpConfig(workDir, 'alice', {}, { bridged: true });
    const onDisk = fs.readFileSync(mcpConfig, 'utf8');
    assert.ok(!onDisk.includes('srv-agent-secret-on-disk-check'), 'secret not in .mcp.json');
    assert.ok(!/"env"/.test(onDisk), 'no env blocks at all');
    const cfg = JSON.parse(onDisk);
    assert.ok(cfg.mcpServers['trained-skills'].args.includes(bridge.CLIENT_PATH));
    assert.equal(servers['trained-skills'].env.AGENT_SECRET, 'srv-agent-secret-on-disk-check');
    const plain = writeRunMcpConfig(workDir, 'alice', {}, { bridged: false });
    assert.equal(plain.servers, null);
  } finally {
    if (prev === undefined) delete process.env.AGENT_SECRET; else process.env.AGENT_SECRET = prev;
  }
});

test('MCP tools get the bot token of the run audience, not the classic bot', () => {
  const workDir = fs.mkdtempSync(path.join(tmpRoot, 'aud-'));
  const secrets = require('../src/secrets');
  secrets.setLoadedSecrets({ BOT_TOKEN: 'classic-bot' });
  try {
    const { servers } = writeRunMcpConfig(workDir, 'alice', { botToken: 'freelance-bot' }, { bridged: true });
    assert.equal(servers['trained-skills'].env.AGENT_BOT_TOKEN, 'freelance-bot');
    const dflt = writeRunMcpConfig(workDir, 'alice', {}, { bridged: true });
    assert.equal(dflt.servers['trained-skills'].env.AGENT_BOT_TOKEN, 'classic-bot');
  } finally {
    secrets.setLoadedSecrets(null);
  }
});

test('engineering workspaces + mirrors are inside the profile, handed to MCP by env', () => {
  const workDir = fs.mkdtempSync(path.join(tmpRoot, 'eng-'));
  const { buildMcpConfig } = require('../src/browser');
  const dp = require('../src/data-paths');
  const env = buildMcpConfig(workDir, 'alice', {}).mcpServers['trained-skills'].env;
  const profile = dp.userWorkDir('alice');
  assert.equal(env.ENGINEERING_WORKSPACE_ROOT, path.join(profile, 'engineering-workspaces'));
  assert.equal(env.ENGINEERING_MIRRORS_ROOT, path.join(profile, 'engineering-mirrors'));
  assert.ok(dp.engineeringWorkspacesDir('alice').startsWith(profile + path.sep), 'nothing under the shared data dir');
});

// ── runEngineProcess end-to-end with the allowlist + bridge ───────────────────

const fakeMcp = writeExe(path.join(tmpRoot, 'fake-mcp.js'), `#!/usr/bin/env node
require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const req = JSON.parse(l);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {
    serverHasSecret: process.env.AGENT_SECRET === 'srv-agent-secret',
    fromConfig: process.env.FROM_CONFIG || null,
    runToken: !!process.env.AGENT_RUN_TOKEN,
  } }) + '\\n');
});
`);

function fakeEngine(outDir) {
  return writeExe(path.join(outDir, 'fake-engine'), `#!/bin/sh
env > "${outDir}/engine.env"
echo '{"jsonrpc":"2.0","id":1,"method":"initialize"}' | "${process.execPath}" "${bridge.CLIENT_PATH}" trained-skills > "${outDir}/mcp.out" 2>"${outDir}/mcp.err"
echo "$AGENT_RUN_TOKEN" > "${outDir}/token"
echo '{"type":"result","result":"ok"}'
`);
}

function baseOpts(outDir, bin) {
  return {
    engine: 'claude', taskId: `alice-${Date.now()}`, chatId: '42', thinkingStart: Date.now(), msgId: null,
    BOT_TOKEN: 'srv-bot-token', secrets: { BOT_TOKEN: 'srv-bot-token', DEEPGRAM_API_KEY: 'srv-deepgram' },
    user: { username: 'alice', workDir: outDir, name: 'Alice' },
    cleanEnv: { ...SERVER_ENV }, userTokens: { GH_TOKEN: 'alice-gh' }, sessionFilePath: '',
    restartShutdown: () => false, activeTimers: new Map(),
    tgEdit: async () => ({ ok: true }), tgSend: async () => ({ ok: true }), outputCallback: null,
    engineBin: bin, engineArgs: [], cwd: outDir,
    bridgedServers: { 'trained-skills': { command: process.execPath, args: [fakeMcp], env: { FROM_CONFIG: 'yes' } } },
  };
}

function parseEnvFile(file) {
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

test('without isolation the engine still gets the service env (sanity: the check below can fail)', async () => {
  delete process.env.AGENT_ENV_ALLOWLIST;
  const outDir = fs.mkdtempSync(path.join(tmpRoot, 'legacy-'));
  const r = await runEngineProcess(baseOpts(outDir, fakeEngine(outDir)));
  assert.equal(r.exitCode, 0);
  const env = parseEnvFile(path.join(outDir, 'engine.env'));
  assert.equal(env.AGENT_SECRET, 'srv-agent-secret');
  assert.equal(env.AGENT_BOT_TOKEN, 'srv-bot-token');
});

test('with AGENT_ENV_ALLOWLIST=1 the engine sees no server-only env, MCP keeps it via the bridge, token dies with the run', async () => {
  process.env.AGENT_ENV_ALLOWLIST = '1';
  try {
    const outDir = fs.mkdtempSync(path.join(tmpRoot, 'iso-'));
    const r = await runEngineProcess(baseOpts(outDir, fakeEngine(outDir)));
    assert.equal(r.exitCode, 0);
    assert.equal(r.claudeResult, 'ok');

    const raw = fs.readFileSync(path.join(outDir, 'engine.env'), 'utf8');
    for (const v of [...SERVER_VALUES, 'srv-bot-token']) assert.ok(!raw.includes(v), `engine env must not contain ${v}`);
    const env = parseEnvFile(path.join(outDir, 'engine.env'));
    assert.equal(env.GH_TOKEN, 'alice-gh', 'current profile token is passed');
    assert.equal(env.AGENT_USER_ID, 'alice');
    assert.match(env.AGENT_RUN_TOKEN, /^rt_/);
    assert.ok(env.AGENT_MCP_BRIDGE_SOCKET);

    const mcp = JSON.parse(fs.readFileSync(path.join(outDir, 'mcp.out'), 'utf8').trim());
    assert.deepEqual(mcp.result, { serverHasSecret: true, fromConfig: 'yes', runToken: true }, 'MCP server runs with the service env');

    // After the run the token is revoked: the bridge refuses it.
    const token = fs.readFileSync(path.join(outDir, 'token'), 'utf8').trim();
    assert.equal(tokens.verifyRunToken(token), null);
    const reply = await bridgeHandshake(env.AGENT_MCP_BRIDGE_SOCKET, token, 'trained-skills');
    assert.match(reply, /unauthorized/);
  } finally {
    delete process.env.AGENT_ENV_ALLOWLIST;
  }
});

test('allowlist keeps the engine\'s own provider keys (opencode: OPENROUTER + OpenCode Go + config env refs), nothing else', async () => {
  process.env.AGENT_ENV_ALLOWLIST = '1';
  const svcHome = fs.mkdtempSync(path.join(tmpRoot, 'svc-oc-'));
  fs.mkdirSync(path.join(svcHome, '.config', 'opencode'), { recursive: true });
  fs.writeFileSync(path.join(svcHome, '.config', 'opencode', 'opencode.json'),
    JSON.stringify({ provider: { gigachat: { options: { apiKey: '${GIGACHAT_TOKEN}' } }, other: { options: { apiKey: '{env:OTHER_PROVIDER_KEY}' } } } }));
  process.env.AGENT_SERVICE_HOME = svcHome;
  try {
    const outDir = fs.mkdtempSync(path.join(tmpRoot, 'oc-'));
    const opts = baseOpts(outDir, fakeEngine(outDir));
    opts.engine = 'opencode';
    opts.cleanEnv = { ...SERVER_ENV, GIGACHAT_TOKEN: 'gc-key', OTHER_PROVIDER_KEY: 'other-key' };
    const r = await runEngineProcess(opts);
    assert.equal(r.exitCode, 0);
    const env = parseEnvFile(path.join(outDir, 'engine.env'));
    // The agent holds no provider keys: no OPENCODE_API_KEY / OPENCODE_GO_API_KEY(S) is set or
    // admitted — the llm-ladder owns the pools, the engine only gets the ladder token.
    assert.ok(!('OPENCODE_API_KEY' in env) && !('OPENCODE_GO_API_KEY' in env) && !('OPENCODE_GO_API_KEYS' in env),
      'no OpenCode Go key reaches the engine');
    assert.ok(!iso.engineCredentialNames('opencode').includes('OPENCODE_API_KEY'), 'Go key is not an engine credential any more');
    assert.deepEqual(iso.engineCredentialNames('codex'), ['OPENAI_API_KEY'], 'codex credential set is unchanged');
    assert.equal(env.GIGACHAT_TOKEN, 'gc-key', '${VAR} reference in the opencode config');
    assert.equal(env.OTHER_PROVIDER_KEY, 'other-key', '{env:VAR} reference in the opencode config');
    for (const k of ['AGENT_SECRET', 'TELEGRAM_BOT_TOKEN', 'DEEPGRAM_API_KEY', 'INN_DADATA_SECRET', 'SOME_SERVER_ONLY_SETTING']) assert.ok(!(k in env), `${k} dropped`);
    // claude runs on OAuth — no provider key passes for it
    assert.deepEqual(iso.engineCredentialNames('claude'), []);
  } finally {
    delete process.env.AGENT_ENV_ALLOWLIST;
    delete process.env.AGENT_SERVICE_HOME;
  }
});

function bridgeHandshake(socketPath, token, server) {
  return new Promise((resolve, reject) => {
    let data = '';
    const s = net.createConnection(socketPath, () => s.write(JSON.stringify({ token, server }) + '\n'));
    s.on('data', d => { data += d; });
    s.on('close', () => resolve(data));
    s.on('error', reject);
  });
}

test('run-as is skipped (allowlist only) when the engine cwd is outside the profile — engineering worktrees', async () => {
  const { prepareEngineSpawn } = require('../src/runner/engine-isolation');
  const wd = fs.mkdtempSync(path.join(tmpRoot, 'wd-'));
  const outside = fs.mkdtempSync(path.join(tmpRoot, 'ws-'));
  const config = { ...iso.isolationConfig({ AGENT_RUN_AS_USERS: 'never-leased' }), slotLockDir: path.join(tmpRoot, 'locks-x') };
  const r = await prepareEngineSpawn({ engine: 'claude', taskId: 't-ws', user: { username: 'u', workDir: wd }, cwd: outside, engineEnv: { ...SERVER_ENV }, config });
  try {
    assert.equal(r.runAs, null, 'no slot leased');
    assert.equal(r.isolated, true, 'still allowlisted + bridged');
    assert.ok(!('AGENT_SECRET' in r.env));
    assert.deepEqual(r.wrap('/bin/x', ['a']), ['/bin/x', ['a']]);
  } finally { r.release(); }
});

test('bridge: a valid token only opens servers registered for that run', async () => {
  const sock = await bridge.ensureBridge(process.env.AGENT_MCP_BRIDGE_DIR);
  const t = tokens.issueRunToken({ taskId: 'bob-1', username: 'bob' });
  bridge.registerRun(t, { servers: { 'trained-skills': { command: process.execPath, args: [fakeMcp] } }, env: { PATH: process.env.PATH }, cwd: tmpRoot });
  try {
    assert.match(await bridgeHandshake(sock, t, 'hh-skills'), /unauthorized/, 'unknown server id');
    assert.match(await bridgeHandshake(sock, 'rt_' + 'a'.repeat(64), 'trained-skills'), /unauthorized/, 'unknown token');
    assert.match(await bridgeHandshake(sock, 'srv-agent-secret', 'trained-skills'), /unauthorized/, 'server secret is not a run token');
  } finally {
    bridge.unregisterRun(t);
    tokens.revokeRunToken(t);
  }
});

// ── run-as slots: leasing, gate ACLs, journal recovery ────────────────────────

function fakeCfg(root, users = ['s1', 's2']) {
  return {
    ...iso.isolationConfig({ AGENT_RUN_AS_USERS: users.join(','), AGENT_RUN_AS_GROUP: 'ta-agents', AGENT_SERVICE_USER: 'svc' }),
    slotLockDir: path.join(root, 'slots'), slotWaitMs: 0,
  };
}

test('prepareIsolatedRun: exclusive slots, gate opened for one slot only, everything revoked on release', async () => {
  const home = fs.mkdtempSync(path.join(tmpRoot, 'home-'));
  const cfg = fakeCfg(home);
  const calls = [];
  const exec = (bin, args) => { calls.push([bin, ...args]); };
  const wdA = path.join(home, 'users', 'alice');
  const wdB = path.join(home, 'users', 'bob');
  const sock = path.join(home, 'agent-data', 'agent-bridge', 'b.sock');

  const a = await iso.prepareIsolatedRun(cfg, { workDir: wdA, engine: 'claude', exec, serviceHome: home, reach: [sock] });
  const b = await iso.prepareIsolatedRun(cfg, { workDir: wdB, engine: 'claude', exec, serviceHome: home, reach: [sock] });
  assert.notEqual(a.slot, b.slot);
  await assert.rejects(iso.prepareIsolatedRun(cfg, { workDir: wdA, engine: 'claude', exec, serviceHome: home }), /no free run-as slot/);

  const opened = (slot) => calls.filter(c => c[0] === 'setfacl' && c[1] === '-m' && c[2].startsWith(`u:${slot}:`)).map(c => [c[2], c[3]]);
  assert.deepEqual(opened(a.slot).filter(([, p]) => p === wdA), [[`u:${a.slot}:rwx`, wdA]]);
  assert.deepEqual(opened(a.slot).filter(([, p]) => p === wdB), [], 'A slot never gets B gate');
  for (const d of [path.join(home, 'users'), home, path.join(home, 'agent-data'), path.join(home, 'agent-data', 'agent-bridge')]) {
    assert.ok(opened(a.slot).some(([e, p]) => e === `u:${a.slot}:x` && p === d), `traverse-only on ${d}`);
  }
  assert.ok(calls.some(c => c[0] === 'setfacl' && c[1] === '-x' && c[2] === 'g:ta-agents' && c[3] === wdA), 'group access removed from the gate itself');
  assert.ok(fs.existsSync(path.join(wdA, iso.GATE_MARKER)));
  assert.equal(a.env.HOME, path.join(wdA, '.agent-home'));
  assert.equal(a.env.TMPDIR, path.join(wdA, '.agent-home', 'tmp', a.slot), 'temp dir per slot inside the profile');
  // TMPDIR goes as a sudo argv assignment (glibc strips it from setuid env, #1791)
  assert.deepEqual(a.spawnArgv('/bin/true', ['x']), ['sudo', ['-n', '-u', a.slot, `TMPDIR=${a.env.TMPDIR}`, '--', '/bin/true', 'x']]);
  assert.deepEqual(a.spawnArgv('/bin/true', [], { TMPDIR: '/t', GH_TOKEN: 'secret', PATH: '/bin' }), ['sudo', ['-n', '-u', a.slot, 'TMPDIR=/t', '--', '/bin/true']],
    'only glibc-stripped allowlisted names go to argv');

  calls.length = 0;
  a.release();
  const clearAt = calls.findIndex(c => c.join(' ') === `sudo -n -u ${a.slot} -- find ${a.env.TMPDIR} -xdev -mindepth 1 -delete`);
  const firstRevoke = calls.findIndex(c => c[0] === 'setfacl' && c[1] === '-x');
  assert.ok(clearAt >= 0, 'release clears the temp dir as the slot');
  assert.ok(clearAt > calls.findIndex(c => c.includes('pkill')) && clearAt < firstRevoke, 'after the reap, while the gate is still open');
  const revoked = calls.filter(c => c[0] === 'setfacl' && c[1] === '-x').map(c => c[3]);
  assert.deepEqual(new Set(revoked), new Set(a.aclPaths));
  assert.ok(calls.some(c => c.includes('pkill')), 'slot processes reaped');
  assert.ok(!fs.existsSync(iso.journalPath(cfg, a.slot)));
  b.release();
});

test('a slot left by an interrupted run is revoked before its next lease', async () => {
  const home = fs.mkdtempSync(path.join(tmpRoot, 'home-'));
  const cfg = fakeCfg(home, ['s1']);
  fs.mkdirSync(cfg.slotLockDir, { recursive: true });
  // dead holder + journal of what it had opened
  fs.writeFileSync(path.join(cfg.slotLockDir, 's1.lock'), '999999');
  fs.writeFileSync(iso.journalPath(cfg, 's1'), JSON.stringify({ pid: 999999, paths: ['/stale/profile'] }));
  const calls = [];
  const run = await iso.prepareIsolatedRun(cfg, { workDir: path.join(home, 'users', 'carol'), engine: 'opencode', exec: (b, a) => calls.push([b, ...a]), serviceHome: home });
  assert.equal(run.slot, 's1');
  assert.ok(calls.some(c => c[0] === 'setfacl' && c[1] === '-x' && c[2] === 'u:s1' && c[3] === '/stale/profile'));
  run.release();
});

test('codex is not moved to a slot user (allowlist only) — its home needs to be slot-owned first', async () => {
  const { prepareEngineSpawn } = require('../src/runner/engine-isolation');
  const cfg = { ...iso.isolationConfig({ AGENT_RUN_AS_USERS: 's1', AGENT_SERVICE_USER: 'svc' }), slotLockDir: path.join(tmpRoot, 'slots-codex'), slotWaitMs: 0 };
  const wd = fs.mkdtempSync(path.join(tmpRoot, 'codex-'));
  const r = await prepareEngineSpawn({ engine: 'codex', taskId: 't-codex', user: { username: 'u', workDir: wd }, cwd: wd, engineEnv: { ...SERVER_ENV }, userTokens: {}, bridgedServers: {}, config: cfg });
  try {
    assert.equal(r.runAs, null);
    assert.deepEqual(r.wrap('codex', ['exec']), ['codex', ['exec']]);
    assert.ok(!('AGENT_SECRET' in r.env), 'allowlist still applies');
  } finally { r.release(); }
});

test('engine home staging: claude gets an access token via env, never the refresh token file', () => {
  const svcHome = fs.mkdtempSync(path.join(tmpRoot, 'svc-'));
  fs.mkdirSync(path.join(svcHome, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(svcHome, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'acc', refreshToken: 'ref' } }));
  fs.writeFileSync(path.join(svcHome, '.claude', 'settings.json'), '{}');
  const wd = fs.mkdtempSync(path.join(tmpRoot, 'wd-'));
  const st = iso.stageEngineHome('claude', wd, { serviceHome: svcHome });
  assert.equal(st.env.CLAUDE_CODE_OAUTH_TOKEN, 'acc');
  assert.ok(fs.existsSync(path.join(wd, '.agent-home', '.claude', 'settings.json')));
  assert.ok(!fs.existsSync(path.join(wd, '.agent-home', '.claude', '.credentials.json')));
  const all = spawnSync('grep', ['-r', 'ref', path.join(wd, '.agent-home')], { encoding: 'utf8' });
  assert.equal(all.stdout, '', 'refresh token not staged');
});

// ── ops script ────────────────────────────────────────────────────────────────

test('ops script: dry run is the default and changes nothing', () => {
  const home = fs.mkdtempSync(path.join(tmpRoot, 'ops-'));
  const script = path.join(__dirname, '..', 'scripts', 'ops', 'agent-isolation-setup.sh');
  const r = spawnSync('bash', [script, '--service-user', 'svc', '--service-home', home, '--slots', '2', '--skip-sa-review', '--skip-engines'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DRY RUN/);
  assert.match(r.stdout, /\[dry-run\] useradd .*ta-agent-2/);
  assert.match(r.stdout, /169\.254\.0\.0\/16 -j REJECT/);
  assert.match(r.stdout, /AGENT_RUN_AS_USERS=ta-agent-1,ta-agent-2/);
  assert.deepEqual(fs.readdirSync(home), [], 'nothing created');
  // gate preparation mirrors src/agent-isolation.js gatePrepareCommands
  const home2 = fs.mkdtempSync(path.join(tmpRoot, 'ops2-'));
  fs.mkdirSync(path.join(home2, 'users', 'alice'), { recursive: true });
  const r2 = spawnSync('bash', [script, '--service-user', 'svc', '--service-home', home2, '--slots', '1', '--skip-sa-review', '--skip-engines'], { encoding: 'utf8' });
  const want = iso.gatePrepareCommands(iso.isolationConfig({ AGENT_RUN_AS_GROUP: 'ta-agents', AGENT_SERVICE_USER: 'svc' }), path.join(home2, 'users', 'alice'));
  const printed = r2.stdout.replace(/\\/g, ''); // dry run prints argv with printf %q
  for (const argv of want) assert.ok(printed.includes(`[dry-run] ${argv.join(' ')}`), `script prepares like the runner: ${argv.join(' ')}\n${r2.stdout}`);
  assert.ok(!fs.existsSync(path.join(home2, 'users', 'alice', iso.GATE_MARKER)), 'dry run does not mark');
  const bad = spawnSync('bash', [script, '--service-user', 'svc', '--apply'], { encoding: 'utf8' });
  if (process.getuid && process.getuid() !== 0) assert.notEqual(bad.status, 0, '--apply refuses without root');
});

// ── #1791: env names glibc strips from setuid programs ─────────────────────────

test('every allowlisted name glibc strips from setuid env travels via sudo argv, and none is a secret', () => {
  const stripped = [...iso.ENGINE_ENV_ALLOW].filter(k => iso.GLIBC_SETUID_STRIPPED_ENV.has(k));
  assert.deepEqual(iso.ARGV_ENV, stripped);
  assert.ok(iso.ARGV_ENV.includes('TMPDIR'));
  for (const k of iso.ARGV_ENV) assert.doesNotMatch(k, /TOKEN|KEY|SECRET|PASS|COOKIE/, `${k} would be visible in ps`);
  const env = Object.fromEntries(stripped.map(k => [k, `/v/${k}`]));
  const [, argv] = iso.sudoArgv({ sudoBin: 'sudo' }, 's1', '/bin/true', [], { ...env, PATH: '/bin' });
  for (const k of stripped) assert.ok(argv.includes(`${k}=/v/${k}`), k);
  assert.ok(!argv.some(a => a.startsWith('PATH=')), 'the rest stays in the process env');
});

test('the stripped-name list matches the host glibc loader (when there is one)', (t) => {
  const ld = ['/lib64/ld-linux-x86-64.so.2', '/lib/ld-linux-aarch64.so.1'].find(f => fs.existsSync(f));
  if (!ld) return t.skip('no glibc loader here');
  const strings = new Set(fs.readFileSync(ld).toString('latin1').split(/[^\x20-\x7e]+/));
  if (!strings.has('TMPDIR')) return t.skip('loader without the unsecvars table');
  for (const k of iso.GLIBC_SETUID_STRIPPED_ENV) {
    if (k.startsWith('LD_')) continue; // spelled via a prefix in some builds
    assert.ok(strings.has(k), `${k} not in ${ld} — list drifted from glibc`);
  }
});

test('clearSlotTmp: own dir emptied as the slot; stale sweep spares the own dir', () => {
  const calls = [];
  iso.clearSlotTmp({ sudoBin: 'sudo' }, 's1', '/p/.agent-home/tmp/s1', { exec: (b, a) => calls.push([b, ...a]), stale: true });
  assert.deepEqual(calls[0], ['sudo', '-n', '-u', 's1', '--', 'find', '/p/.agent-home/tmp/s1', '-xdev', '-mindepth', '1', '-delete']);
  assert.deepEqual(calls[1].slice(0, 13), ['sudo', '-n', '-u', 's1', '--', 'find', '/p/.agent-home/tmp', '-xdev', '-mindepth', '1', '-maxdepth', '1', '!']);
  assert.ok(calls[1].includes('+1440') && calls[1].includes('s1'));
  // best effort: a failing find never throws
  iso.clearSlotTmp({ sudoBin: 'sudo' }, 's1', '/nonexistent/tmp/s1', { exec: () => { throw new Error('boom'); }, stale: true });
});

test.after(async () => {
  await bridge.closeBridge();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
