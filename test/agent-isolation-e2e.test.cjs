'use strict';
// Regression for issue #1649 with REAL unix users: an agent run for profile A
// cannot read profile B's files or token files, nor the server secrets file,
// and does not see server-only env vars — while another run holds profile B
// open at the same time.
//
// Needs Linux, setfacl and passwordless sudo (it creates throwaway users via the
// ops script). Skipped unless AGENT_ISOLATION_E2E=1 — CI sets it in a dedicated step.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const enabled = process.env.AGENT_ISOLATION_E2E === '1' && process.platform === 'linux';
const PREFIX = 'tae2e-';
const GROUP = 'tae2e';
const SLOTS = [`${PREFIX}1`, `${PREFIX}2`];
const SCRIPT = path.join(__dirname, '..', 'scripts', 'ops', 'agent-isolation-setup.sh');

function sudo(args, opts = {}) {
  return spawnSync('sudo', ['-n', ...args], { encoding: 'utf8', ...opts });
}

test('profile A agent cannot read profile B, token files or server secrets', { skip: !enabled && 'set AGENT_ISOLATION_E2E=1 on Linux with passwordless sudo' }, async (t) => {
  const iso = require('../src/agent-isolation');
  const me = os.userInfo().username;
  const home = fs.mkdtempSync('/tmp/ta-e2e-home-');
  const users = path.join(home, 'users');
  const tokensDir = path.join(home, 'agent-tokens');
  const dataDir = path.join(home, 'agent-data');
  const secretsFile = path.join(home, 'secrets.env');
  for (const p of ['alice', 'bob']) {
    fs.mkdirSync(path.join(users, p, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(users, p, 'notes.md'), `${p}-notes\n`);
    fs.mkdirSync(path.join(tokensDir, p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(tokensDir, p, 'github'), `${p}-gh-token\n`, { mode: 0o600 });
  }
  fs.writeFileSync(secretsFile, 'AGENT_SECRET=srv-agent-secret\n', { mode: 0o600 });

  t.after(() => {
    for (const s of SLOTS) sudo(['userdel', s]);
    sudo(['groupdel', GROUP]);
    sudo(['rm', '-f', `/etc/sudoers.d/${GROUP}`]);
    sudo(['rm', '-rf', home]);
  });

  const setup = sudo(['bash', SCRIPT, '--apply', '--service-user', me, '--service-home', home,
    '--users-dir', users, '--tokens-dir', tokensDir, '--data-dir', dataDir, '--secrets-file', secretsFile,
    '--slots', '2', '--prefix', PREFIX, '--group', GROUP,
    '--skip-engines', '--skip-firewall', '--skip-systemd', '--skip-sa-review']);
  assert.equal(setup.status, 0, `setup failed:\n${setup.stdout}\n${setup.stderr}`);

  const cfg = iso.isolationConfig({
    AGENT_RUN_AS_USERS: SLOTS.join(','), AGENT_RUN_AS_GROUP: GROUP, AGENT_SERVICE_USER: me,
    AGENT_SLOT_LOCK_DIR: path.join(dataDir, 'agent-slots'),
  });
  const runA = await iso.prepareIsolatedRun(cfg, { workDir: path.join(users, 'alice'), engine: 'none', serviceHome: home });
  const runB = await iso.prepareIsolatedRun(cfg, { workDir: path.join(users, 'bob'), engine: 'none', serviceHome: home });
  assert.notEqual(runA.slot, runB.slot);

  const serviceEnv = {
    PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', AGENT_USER_ID: 'alice',
    AGENT_SECRET: 'srv-agent-secret', TELEGRAM_BOT_TOKEN: 'srv-bot', DEEPGRAM_API_KEY: 'srv-dg', GH_TOKEN: 'alice-gh-env',
  };
  const probe = [
    `id -un`,
    `cat ${users}/alice/notes.md && echo OWN_READ_OK`,
    `echo from-agent > ${users}/alice/agent-wrote.txt && echo OWN_WRITE_OK`,
    `cat ${users}/bob/notes.md && echo LEAK_OTHER_PROFILE`,
    `ls ${users} && echo LEAK_PROFILE_LIST`,
    `cat ${tokensDir}/bob/github && echo LEAK_OTHER_TOKENS`,
    `cat ${tokensDir}/alice/github && echo LEAK_TOKEN_FILE`,
    `cat ${secretsFile} && echo LEAK_SECRETS_FILE`,
    `env`,
  ].map(c => `(${c}) 2>/dev/null`).join('; ');

  function runAs(run, profile) {
    const env = iso.buildAgentEnv(serviceEnv, { userTokenNames: ['GH_TOKEN'], extra: run.env });
    const [bin, args] = run.spawnArgv('/bin/sh', ['-c', probe]);
    return spawnSync(bin, args, { env, cwd: path.join(users, profile), encoding: 'utf8', timeout: 30_000 });
  }

  const a = runAs(runA, 'alice');
  assert.equal(a.status === null ? 'timeout' : 'ok', 'ok', a.stderr);
  const out = a.stdout;
  assert.match(out, new RegExp(`^${runA.slot}$`, 'm'), 'runs as the slot user');
  assert.match(out, /OWN_READ_OK/);
  assert.match(out, /OWN_WRITE_OK/);
  for (const leak of ['LEAK_OTHER_PROFILE', 'LEAK_PROFILE_LIST', 'LEAK_OTHER_TOKENS', 'LEAK_TOKEN_FILE', 'LEAK_SECRETS_FILE']) {
    // whole-line markers: SUDO_COMMAND in the env dump echoes the probe text itself
    assert.doesNotMatch(out, new RegExp(`^${leak}$`, 'm'), `${leak}:\n${out}`);
  }
  for (const v of ['srv-agent-secret', 'srv-bot', 'srv-dg', 'bob-notes', 'bob-gh-token']) assert.ok(!out.includes(v), `saw ${v}`);
  assert.match(out, /GH_TOKEN=alice-gh-env/, 'current profile token passed via env');
  assert.match(out, /^SHELL=\/bin\/bash$/m, 'slot has a usable shell for the engines\' Bash tool');
  assert.match(out, new RegExp(`^HOME=${path.join(users, 'alice', '.agent-home')}$`, 'm'), 'HOME is the per-profile engine home');

  // The service user can still read and rewrite what the agent wrote (default ACL).
  const wrote = path.join(users, 'alice', 'agent-wrote.txt');
  assert.equal(fs.readFileSync(wrote, 'utf8'), 'from-agent\n');
  fs.appendFileSync(wrote, 'service-appended\n');

  runA.release();
  runB.release();

  // After release, the slot that served alice is reused for bob — alice is closed again.
  const runB2 = await iso.prepareIsolatedRun(cfg, { workDir: path.join(users, 'bob'), engine: 'none', serviceHome: home });
  const [bin, args] = runB2.spawnArgv('/bin/sh', ['-c', `cat ${users}/alice/notes.md && echo LEAK_AFTER_RELEASE; cat ${users}/bob/notes.md`]);
  const b2 = spawnSync(bin, args, { env: iso.buildAgentEnv(serviceEnv, { extra: runB2.env }), cwd: path.join(users, 'bob'), encoding: 'utf8' });
  assert.doesNotMatch(b2.stdout, /^LEAK_AFTER_RELEASE$/m, b2.stdout);
  assert.match(b2.stdout, /bob-notes/);
  runB2.release();

  // No slot entries remain anywhere after all runs are released.
  const acl = execFileSync('getfacl', ['-R', '-p', users], { encoding: 'utf8' });
  for (const s of SLOTS) assert.ok(!acl.includes(`user:${s}:`), `${s} ACL left behind:\n${acl}`);
});

test('runEngineProcess as a slot user: allowlisted env, MCP through the bridge, grants revoked after', { skip: !enabled && 'set AGENT_ISOLATION_E2E=1 on Linux with passwordless sudo' }, async (t) => {
  const me = os.userInfo().username;
  const home = fs.mkdtempSync('/tmp/ta-e2e-run-');
  const users = path.join(home, 'users');
  const dataDir = path.join(home, 'agent-data');
  const workDir = path.join(users, 'alice');
  fs.mkdirSync(workDir, { recursive: true });
  // Code the slot executes must be readable by it: in production the root-owned
  // release dir; here a world-readable copy outside the (closed) service home.
  const pub = fs.mkdtempSync('/tmp/ta-e2e-pub-');
  fs.chmodSync(pub, 0o755);
  const client = path.join(pub, 'agent-mcp-bridge-client.js');
  fs.copyFileSync(path.join(__dirname, '..', 'src', 'agent-mcp-bridge-client.js'), client);
  fs.chmodSync(client, 0o755);
  const fakeMcp = path.join(pub, 'fake-mcp.js');
  fs.writeFileSync(fakeMcp, `require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const req = JSON.parse(l);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { uid: process.getuid(), hasSecret: process.env.AGENT_SECRET === 'srv-agent-secret' } }) + '\\n');
});\n`);
  const engine = path.join(pub, 'fake-engine');
  fs.writeFileSync(engine, `#!/bin/sh
env > "$HOME/engine.env"
echo '{"jsonrpc":"2.0","id":1,"method":"initialize"}' | "${process.execPath}" "${client}" trained-skills > "$HOME/mcp.out" 2>&1
cat ${home}/secrets.env > "$HOME/secrets.out" 2>&1
id -u > "$HOME/uid"
echo '{"type":"result","result":"ok"}'
`);
  fs.chmodSync(engine, 0o755);
  fs.writeFileSync(path.join(home, 'secrets.env'), 'AGENT_SECRET=srv-agent-secret\n', { mode: 0o600 });

  t.after(() => {
    for (const s of SLOTS) sudo(['userdel', s]);
    sudo(['groupdel', GROUP]);
    sudo(['rm', '-f', `/etc/sudoers.d/${GROUP}`]);
    sudo(['rm', '-rf', home, pub]);
  });
  const setup = sudo(['bash', SCRIPT, '--apply', '--service-user', me, '--service-home', home,
    '--slots', '2', '--prefix', PREFIX, '--group', GROUP,
    '--skip-engines', '--skip-firewall', '--skip-systemd', '--skip-sa-review']);
  assert.equal(setup.status, 0, `setup failed:\n${setup.stdout}\n${setup.stderr}`);

  Object.assign(process.env, {
    AGENT_RUN_AS_USERS: SLOTS.join(','), AGENT_RUN_AS_GROUP: GROUP, AGENT_SERVICE_USER: me, AGENT_SERVICE_HOME: home,
    AGENT_SLOT_LOCK_DIR: path.join(dataDir, 'agent-slots'), AGENT_MCP_BRIDGE_DIR: path.join(dataDir, 'agent-bridge'),
    AGENT_MCP_BRIDGE_CLIENT: client,
  });
  const { runEngineProcess } = require('../src/runner/claude-runner');
  const bridge = require('../src/agent-mcp-bridge');
  t.after(() => bridge.closeBridge());

  const r = await runEngineProcess({
    engine: 'claude', taskId: 'alice-e2e', chatId: '1', thinkingStart: Date.now(), msgId: null,
    BOT_TOKEN: 'srv-bot', secrets: { BOT_TOKEN: 'srv-bot' },
    user: { username: 'alice', workDir, name: 'Alice' },
    cleanEnv: { PATH: '/usr/local/bin:/usr/bin:/bin', AGENT_SECRET: 'srv-agent-secret' }, userTokens: { GH_TOKEN: 'alice-gh' },
    sessionFilePath: '', restartShutdown: () => false, activeTimers: new Map(),
    tgEdit: async () => ({ ok: true }), tgSend: async () => ({ ok: true }), outputCallback: null,
    engineBin: engine, engineArgs: [], cwd: workDir,
    bridgedServers: { 'trained-skills': { command: process.execPath, args: [fakeMcp] } },
  });
  assert.equal(r.claudeResult, 'ok', JSON.stringify(r.processError));

  const agentHome = path.join(workDir, '.agent-home');
  const slotUid = Number(fs.readFileSync(path.join(agentHome, 'uid'), 'utf8'));
  assert.notEqual(slotUid, process.getuid(), 'engine ran as another user');
  const env = fs.readFileSync(path.join(agentHome, 'engine.env'), 'utf8');
  for (const v of ['srv-agent-secret', 'srv-bot']) assert.ok(!env.includes(v), `engine env has ${v}`);
  assert.match(env, /^GH_TOKEN=alice-gh$/m);
  assert.doesNotMatch(fs.readFileSync(path.join(agentHome, 'secrets.out'), 'utf8'), /srv-agent-secret/);
  const mcp = JSON.parse(fs.readFileSync(path.join(agentHome, 'mcp.out'), 'utf8').trim());
  assert.deepEqual(mcp.result, { uid: process.getuid(), hasSecret: true }, 'MCP server ran as the service user with its env');

  const acl = execFileSync('getfacl', ['-R', '-p', home], { encoding: 'utf8' });
  for (const s of SLOTS) assert.ok(!acl.includes(`user:${s}:`), `${s} ACL left behind`);
});
