const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../src/run-input-store');

const freshWorkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'run-input-test-'));

test('buildDocument: two sections + truthful header (sizes, engine, session, not-reproduced note)', () => {
  const doc = store.buildDocument({
    taskId: 'user1-msg-42-7',
    engine: 'claude',
    sessionId: 's-abc',
    systemPrompt: 'SYS',
    prompt: 'PROMPT',
    createdAt: Date.UTC(2026, 8, 27),
  });
  assert.match(doc, /Реальный input агента — user1-msg-42-7/);
  assert.match(doc, /движок: claude · сессия: s-abc/);
  assert.match(doc, /Системный промпт: 3 символов · контекст\+задача: 6 символов/);
  assert.match(doc, /1\. СИСТЕМНЫЙ ПРОМПТ [\s\S]*SYS/);
  assert.match(doc, /2\. ПРОМПТ \(контекст \+ задача\) [\s\S]*PROMPT/);
  assert.match(doc, /0\. ЧТО ДОБАВЛЯЕТ ДВИЖОК/);
});

test('buildDocument: per-engine notes + MCP servers + resume flag', () => {
  for (const [engine, marker] of [['claude', /ОТЛОЖЕННО[\s\S]*ToolSearch/], ['opencode', /tools\[\] каждого шага целиком/], ['codex', /tool_output_token_limit/]]) {
    const doc = store.buildDocument({ taskId: 't1', engine, systemPrompt: 'S', prompt: 'P', mcpServers: ['trained-skills', 'hh-skills'], resumed: engine === 'claude' });
    assert.match(doc, marker, engine);
    assert.match(doc, /MCP-серверы: trained-skills, hh-skills/);
    assert.match(doc, new RegExp(`продолжение сессии движка: ${engine === 'claude' ? 'да' : 'нет'}`));
    for (const other of Object.keys(store.ENGINE_NOTES).filter(e => e !== engine)) {
      assert.ok(!doc.includes(store.ENGINE_NOTES[other][0]), `${engine} doc must not carry ${other} notes`);
    }
  }
  const unknown = store.buildDocument({ taskId: 't2', engine: 'hermes', systemPrompt: '', prompt: '' });
  assert.match(unknown, /Движок неизвестен/);
  assert.match(unknown, /MCP-серверы: —/);
});

test('writeInput/readInput round-trip inside workDir/.run-inputs, mode 0600', () => {
  const workDir = freshWorkDir();
  const ok = store.writeInput(workDir, 'user1-msg-1-2', 'DOC');
  assert.equal(ok, true);
  const file = path.join(workDir, '.run-inputs', 'user1-msg-1-2.txt');
  assert.equal(fs.readFileSync(file, 'utf8'), 'DOC');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(store.readInput(workDir, 'user1-msg-1-2'), 'DOC');
});

test('readInput: unknown task → null; missing workDir → null', () => {
  const workDir = freshWorkDir();
  assert.equal(store.readInput(workDir, 'nope-1'), null);
  assert.equal(store.readInput(null, 'user1-msg-1-2'), null);
});

test('taskId is validated: path traversal / illegal chars rejected on both ends', () => {
  const workDir = freshWorkDir();
  assert.equal(store.writeInput(workDir, '../evil', 'X'), false);
  assert.equal(store.writeInput(workDir, 'a/b', 'X'), false);
  assert.equal(store.readInput(workDir, '../../etc/passwd'), null);
  assert.equal(fs.existsSync(path.join(workDir, '.run-inputs', '..-evil.txt')), false);
});

test('prune keeps the newest KEEP files', () => {
  const workDir = freshWorkDir();
  const dir = path.join(workDir, '.run-inputs');
  fs.mkdirSync(dir, { recursive: true });
  const total = store.KEEP + 5;
  for (let i = 0; i < total; i++) {
    const f = path.join(dir, `task-${String(i).padStart(3, '0')}.txt`);
    fs.writeFileSync(f, `doc ${i}`);
    fs.utimesSync(f, new Date(Date.now() - (total - i) * 1000), new Date(Date.now() - (total - i) * 1000));
  }
  store.writeInput(workDir, 'task-newest', 'NEW');
  const left = fs.readdirSync(dir).filter(f => f.endsWith('.txt'));
  assert.equal(left.length, store.KEEP);
  assert.ok(left.includes('task-newest.txt'));
  assert.ok(!left.includes('task-000.txt')); // oldest evicted
});
