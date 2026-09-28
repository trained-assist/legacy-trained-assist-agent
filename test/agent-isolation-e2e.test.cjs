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
const SLOTS = [`${PREFIX}1`, `${PREFIX}2`, `${PREFIX}3`];
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
  // a chat attachment the service stored with 0600 (server.js intake)
  fs.mkdirSync(path.join(users, 'alice', 'media', 'intake'), { recursive: true });
  fs.writeFileSync(path.join(users, 'alice', 'media', 'intake', 'att.txt'), 'attachment-ok\n', { mode: 0o600 });
  // a repo in the profile, created by the service user (engineering workspaces look like this)
  const repo = path.join(users, 'alice', 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=s@x', '-c', 'user.name=s', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Service Bot\n\temail = bot@example.com\n');

  t.after(() => {
    for (const s of SLOTS) sudo(['userdel', s]);
    sudo(['groupdel', GROUP]);
    sudo(['rm', '-f', `/etc/sudoers.d/${GROUP}`]);
    sudo(['rm', '-rf', home]);
  });

  const setup = sudo(['bash', SCRIPT, '--apply', '--service-user', me, '--service-home', home,
    '--users-dir', users, '--tokens-dir', tokensDir, '--data-dir', dataDir, '--secrets-file', secretsFile,
    '--slots', '3', '--prefix', PREFIX, '--group', GROUP,
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
    `cat ${users}/alice/media/intake/att.txt`,
    `cat ${users}/bob/notes.md && echo LEAK_OTHER_PROFILE`,
    `ls ${users} && echo LEAK_PROFILE_LIST`,
    `cat ${tokensDir}/bob/github && echo LEAK_OTHER_TOKENS`,
    `cat ${tokensDir}/alice/github && echo LEAK_TOKEN_FILE`,
    `cat ${secretsFile} && echo LEAK_SECRETS_FILE`,
    `cd ${repo} && git status --short && echo GIT_STATUS_OK && git commit -q --allow-empty -m agent && git log -1 --format=%an | sed 's/^/GIT_AUTHOR=/'`,
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
  assert.match(out, /^attachment-ok$/m, 'a 0600 attachment the service stored is readable by this profile\'s run');
  assert.match(out, /^GIT_STATUS_OK$/m, 'git works on a service-owned repo (safe.directory)');
  assert.match(out, /^GIT_AUTHOR=Service Bot$/m, 'commit identity from the service git config');
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

  runB.release();

  // A file the agent created with a typical 0644 mode stays writable for the NEXT run,
  // which is another slot (opencode's session DB broke on exactly this).
  const shared = path.join(users, 'alice', 'agent-0644.txt');
  const [sb, sa] = runA.spawnArgv('/bin/sh', ['-c', `umask 022; echo one > ${shared}`]);
  spawnSync(sb, sa, { env: iso.buildAgentEnv(serviceEnv, { extra: runA.env }), cwd: path.join(users, 'alice') });
  runA.release();
  // occupy the slot alice just used, so her next run lands on a different one
  const hold = await iso.prepareIsolatedRun(cfg, { workDir: path.join(users, 'bob'), engine: 'none', serviceHome: home });
  const runA2 = await iso.prepareIsolatedRun(cfg, { workDir: path.join(users, 'alice'), engine: 'none', serviceHome: home });
  assert.notEqual(runA2.slot, runA.slot, 'next run of alice is another slot');
  const [wb, wa] = runA2.spawnArgv('/bin/sh', ['-c', `echo two >> ${shared} && echo APPEND_OK`]);
  const w = spawnSync(wb, wa, { env: iso.buildAgentEnv(serviceEnv, { extra: runA2.env }), cwd: path.join(users, 'alice'), encoding: 'utf8' });
  assert.match(w.stdout, /APPEND_OK/, `another slot can write the previous slot's file: ${w.stderr}`);
  runA2.release();
  hold.release();

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
cat "$2" > "$HOME/sys.out" 2>&1
id -u > "$HOME/uid"
echo '{"type":"result","result":"ok"}'
`);
  fs.chmodSync(engine, 0o755);
  fs.writeFileSync(path.join(home, 'secrets.env'), 'AGENT_SECRET=srv-agent-secret\n', { mode: 0o600 });
  // the runner writes the system prompt into the profile with mode 0600 (persona.js)
  const sysPrompt = path.join(workDir, '.system-prompt.txt');
  fs.writeFileSync(sysPrompt, 'SYS-PROMPT-OK\n', { mode: 0o600 });

  t.after(() => {
    for (const s of SLOTS) sudo(['userdel', s]);
    sudo(['groupdel', GROUP]);
    sudo(['rm', '-f', `/etc/sudoers.d/${GROUP}`]);
    sudo(['rm', '-rf', home, pub]);
  });
  const setup = sudo(['bash', SCRIPT, '--apply', '--service-user', me, '--service-home', home,
    '--slots', '3', '--prefix', PREFIX, '--group', GROUP,
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
    engineBin: engine, engineArgs: ['--append-system-prompt-file', sysPrompt], cwd: workDir,
    bridgedServers: { 'trained-skills': { command: process.execPath, args: [fakeMcp] } },
  });
  assert.equal(r.claudeResult, 'ok', JSON.stringify(r.processError));

  const agentHome = path.join(workDir, '.agent-home');
  const slotUid = Number(fs.readFileSync(path.join(agentHome, 'uid'), 'utf8'));
  assert.notEqual(slotUid, process.getuid(), 'engine ran as another user');
  const env = fs.readFileSync(path.join(agentHome, 'engine.env'), 'utf8');
  for (const v of ['srv-agent-secret', 'srv-bot']) assert.ok(!env.includes(v), `engine env has ${v}`);
  assert.match(env, /^GH_TOKEN=alice-gh$/m);
  assert.equal(fs.readFileSync(path.join(agentHome, 'sys.out'), 'utf8'), 'SYS-PROMPT-OK\n', 'engine reads a 0600 system prompt file the service passed');
  assert.doesNotMatch(fs.readFileSync(path.join(agentHome, 'secrets.out'), 'utf8'), /srv-agent-secret/);
  const mcp = JSON.parse(fs.readFileSync(path.join(agentHome, 'mcp.out'), 'utf8').trim());
  assert.deepEqual(mcp.result, { uid: process.getuid(), hasSecret: true }, 'MCP server ran as the service user with its env');

  const acl = execFileSync('getfacl', ['-R', '-p', home], { encoding: 'utf8' });
  for (const s of SLOTS) assert.ok(!acl.includes(`user:${s}:`), `${s} ACL left behind`);
});
