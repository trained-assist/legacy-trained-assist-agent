'use strict';
// Epic #1805, §3-1: tg_send_file path guard. The MCP server runs as the
// service user — without the guard any profile's agent can exfiltrate any
// service-readable file (secrets.env, ~/.ssh, ~/.git-credentials, чужие
// agent-tokens) into its own chat. The guard is realpath-based, so a symlink
// inside the workspace pointing outside is denied too.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { tools, isAllowedSendPath } = require('../src/mcp-skills/tools/94-tg-send');

// Fixture lives under HOME (not under os.tmpdir() — tmp is an allowed root, so
// placing forbidden files there would make the negative tests meaningless).
const root = fs.mkdtempSync(path.join(os.homedir(), 'tg-send-guard-'));
const workDir = path.join(root, 'work');
const tokensDir = path.join(root, 'agent-tokens');
const fakeSecrets = path.join(root, 'secrets.env');
const tmpFile = path.join(os.tmpdir(), `tg-send-guard-tmp-${process.pid}.txt`);
fs.mkdirSync(path.join(workDir, 'sub'), { recursive: true });
fs.mkdirSync(path.join(tokensDir, 'alice', 'hermes-research'), { recursive: true });
fs.mkdirSync(path.join(tokensDir, 'bob', 'hermes-research'), { recursive: true });
fs.writeFileSync(path.join(workDir, 'report.pdf'), 'x');
fs.writeFileSync(path.join(workDir, 'sub', 'shot.png'), 'x');
fs.writeFileSync(path.join(tokensDir, 'alice', 'hermes-research', 'r.md'), 'x');
fs.writeFileSync(path.join(tokensDir, 'bob', 'hermes-research', 'r.md'), 'x');
fs.writeFileSync(fakeSecrets, 'SECRET=1');
fs.writeFileSync(tmpFile, 'x');
fs.symlinkSync(fakeSecrets, path.join(workDir, 'link-to-secret'));

const prev = { WORK_DIR: process.env.WORK_DIR, AGENT_TOKENS_DIR: process.env.AGENT_TOKENS_DIR, USER_ID: process.env.USER_ID };
process.env.WORK_DIR = workDir;
process.env.AGENT_TOKENS_DIR = tokensDir;
process.env.USER_ID = 'alice';

test.after(() => {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(tmpFile, { force: true });
});

test('allows files inside the run workspace', () => {
  assert.equal(isAllowedSendPath(path.join(workDir, 'report.pdf')), true);
  assert.equal(isAllowedSendPath(path.join(workDir, 'sub', 'shot.png')), true);
});

test('denies service-readable files outside every allowed root', () => {
  assert.equal(isAllowedSendPath(fakeSecrets), false);
  assert.equal(isAllowedSendPath('/home/vova/secrets.env'), false);
  assert.equal(isAllowedSendPath('/home/vova/.ssh/id_ed25519'), false);
  assert.equal(isAllowedSendPath('/home/vova/.git-credentials'), false);
  assert.equal(isAllowedSendPath(path.join(tokensDir, 'bob', 'hermes-research', 'r.md')), false);
});

test('allows own profile hermes-research, denies other profiles', () => {
  assert.equal(isAllowedSendPath(path.join(tokensDir, 'alice', 'hermes-research', 'r.md')), true);
  assert.equal(isAllowedSendPath(path.join(tokensDir, 'bob', 'hermes-research', 'r.md')), false);
});

test('denies a symlink inside workspace that points outside', () => {
  assert.equal(isAllowedSendPath(path.join(workDir, 'link-to-secret')), false);
});

test('system tmp (shared, #1712) is allowed — guard targets service secrets', () => {
  assert.equal(isAllowedSendPath(tmpFile), true);
});

test('relative path resolves against run cwd (an allowed root)', () => {
  assert.equal(isAllowedSendPath('some/relative/report.pdf'), true);
});

test('handler rejects an outside path before touching the filesystem', async () => {
  const res = await tools.tg_send_file.handler({ file_path: '/home/vova/secrets.env' });
  assert.match(String(res.error), /outside the allowed roots/);
});

test('handler rejects a missing-but-inside path with File not found', async () => {
  const res = await tools.tg_send_file.handler({ file_path: path.join(workDir, 'nope.pdf') });
  assert.match(String(res.error), /File not found/);
});
