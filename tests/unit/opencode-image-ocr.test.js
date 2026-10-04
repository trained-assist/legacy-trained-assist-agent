// Integration test for the /run wiring that feeds image attachments through
// vision OCR when the active engine is OpenCode (src/media-vision.js) — see
// specs/opencode-image-ocr-spec.md. OpenCode's models have no vision input of
// their own, unlike Claude Code whose Read tool already hands images to the
// model natively, so a photo is otherwise just an opaque path to that engine.
//
// This suite deliberately runs the server WITHOUT a provider key set, so it
// only proves the wiring (note shape, no crash, engine gating) without making a
// real network call — src/media-vision.js's own OCR behavior (success, refusal,
// HTTP/network errors) is covered by tests/unit/media-vision.test.js with an
// injected fetch.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { createServer } from 'http';

const SECRET = 'test-agent-secret-oc-image';
const USERNAME_CLAUDE = 'oc-image-test-claude';
const USERNAME_OPENCODE = 'oc-image-test-opencode';

let usersDir, dataDir, serverProc, serverPort;

function authHeader() {
  return { Authorization: `Bearer ${SECRET}` };
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['src/server.js'], {
      cwd: join(fileURLToPath(import.meta.url), '..', '..', '..'),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let resolved = false;
    const lines = [];
    const expectedPort = parseInt(env.PORT || '3001', 10);
    const tryResolve = () => {
      for (const line of lines) {
        if (line.includes('listening on')) { resolved = true; resolve({ proc, port: expectedPort }); return true; }
      }
      return false;
    };
    proc.stdout.on('data', (chunk) => { lines.push(...chunk.toString().split('\n')); if (!resolved) tryResolve(); });
    proc.stderr.on('data', (chunk) => { lines.push(...chunk.toString().split('\n')); if (!resolved) tryResolve(); });
    proc.on('error', reject);
    proc.on('exit', (code) => { if (!resolved) reject(new Error(`Server exited with code ${code}\n${lines.join('\n')}`)); });
    setTimeout(() => { if (!resolved) reject(new Error(`Server didn't start in 5s. Output:\n${lines.join('\n')}`)); }, 5000);
  });
}

beforeAll(async () => {
  usersDir = mkdtempSync(join(tmpdir(), 'oc-image-users-'));
  dataDir = mkdtempSync(join(tmpdir(), 'oc-image-data-'));
  // Deliberately no LLM_LADDER_TOKEN — see file header.
  const { proc, port } = await startServer({
    PORT: '13581',
    SECRETS_SOURCE: 'env',
    TELEGRAM_BOT_TOKEN: 'test-tg-token-oc-image',
    AGENT_SECRET: SECRET,
    USERS_DIR: usersDir,
    AGENT_DATA_DIR: dataDir,
    NODE_ENV: 'test',
  });
  serverProc = proc;
  serverPort = port;
}, 10000);

afterAll(async () => {
  if (serverProc) serverProc.kill('SIGTERM');
  try { rmSync(usersDir, { recursive: true, force: true }); } catch {}
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

function base(pathAndQuery) {
  return `http://127.0.0.1:${serverPort}${pathAndQuery}`;
}

async function runWithImage(username, userId) {
  const filePath = join(usersDir, username, 'media', 'intake', `probe-${userId}.jpg`);
  const run = await fetch(base('/run'), {
    method: 'POST', headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId, username, task: 'что на фото?',
      fileBase64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
      fileName: 'probe.jpg', fileMimeType: 'image/jpeg',
    }),
  });
  expect(run.status).toBe(202);
  await new Promise(r => setTimeout(r, 150));
}

function pendingTaskFor(username) {
  const pendingDir = join(dataDir, 'pending-tasks');
  for (const f of readdirSync(pendingDir)) {
    if (!f.endsWith('.json')) continue;
    const entry = JSON.parse(readFileSync(join(pendingDir, f), 'utf8'));
    if (entry.username === username) return entry;
  }
  return null;
}

describe('/run image attachment note (no ladder token configured)', () => {
  it('OpenCode engine: base file note only, no recognition block, no crash', async () => {
    mkdirSync(join(usersDir, USERNAME_OPENCODE), { recursive: true });
    writeFileSync(join(usersDir, USERNAME_OPENCODE, 'profile.json'), JSON.stringify({ engine: 'opencode' }));

    await runWithImage(USERNAME_OPENCODE, '9001');
    const entry = pendingTaskFor(USERNAME_OPENCODE);
    expect(entry).toBeTruthy();
    expect(entry.task).toMatch(/^\[Файл сохранён: .*probe\.jpg \(image\/jpeg\)\./);
    expect(entry.task).not.toContain('Распознано на изображении');
  });

  it('Claude engine (default, no profile override): same base note, OCR never attempted', async () => {
    await runWithImage(USERNAME_CLAUDE, '9002');
    const entry = pendingTaskFor(USERNAME_CLAUDE);
    expect(entry).toBeTruthy();
    expect(entry.task).toMatch(/^\[Файл сохранён: .*probe\.jpg \(image\/jpeg\)\./);
    expect(entry.task).not.toContain('Распознано на изображении');
  });
});

// Second server instance, with the llm-ladder pointed at a local stand-in
// (LLM_LADDER_URL + LLM_LADDER_TOKEN — src/media-vision.js ходит через llm-ladder,
// прямого OPENROUTER_BASE_URL больше нет, #2092). Цель — доказать success path
// сквозь: блок распознавания реально попадает в текст задачи, который читает OpenCode.
describe('/run image attachment note (llm-ladder mocked, success path)', () => {
  const USERNAME = 'oc-image-test-success';
  let mockServer, mockPort, serverProc2, serverPort2, usersDir2, dataDir2;

  beforeAll(async () => {
    mockServer = createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'Вывеска: "Тестовая кофейня"' } }] }));
      });
    });
    await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
    mockPort = mockServer.address().port;

    usersDir2 = mkdtempSync(join(tmpdir(), 'oc-image-users2-'));
    dataDir2 = mkdtempSync(join(tmpdir(), 'oc-image-data2-'));
    mkdirSync(join(usersDir2, USERNAME), { recursive: true });
    writeFileSync(join(usersDir2, USERNAME, 'profile.json'), JSON.stringify({ engine: 'opencode' }));

    const { proc, port } = await startServer({
      PORT: '13582',
      SECRETS_SOURCE: 'env',
      TELEGRAM_BOT_TOKEN: 'test-tg-token-oc-image-2',
      AGENT_SECRET: SECRET,
      USERS_DIR: usersDir2,
      AGENT_DATA_DIR: dataDir2,
      NODE_ENV: 'test',
      LLM_LADDER_URL: `http://127.0.0.1:${mockPort}`,
      LLM_LADDER_TOKEN: 'test-ladder-token',
    });
    serverProc2 = proc;
    serverPort2 = port;
  }, 10000);

  afterAll(async () => {
    if (serverProc2) serverProc2.kill('SIGTERM');
    if (mockServer) await new Promise(r => mockServer.close(r));
    try { rmSync(usersDir2, { recursive: true, force: true }); } catch {}
    try { rmSync(dataDir2, { recursive: true, force: true }); } catch {}
  });

  it('folds the OCR result into the task note for the OpenCode engine', async () => {
    const run = await fetch(`http://127.0.0.1:${serverPort2}/run`, {
      method: 'POST', headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: '9003', username: USERNAME, task: 'что на фото?',
        fileBase64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
        fileName: 'probe.jpg', fileMimeType: 'image/jpeg',
      }),
    });
    expect(run.status).toBe(202);
    await new Promise(r => setTimeout(r, 150));

    const pendingDir = join(dataDir2, 'pending-tasks');
    const entry = readdirSync(pendingDir).filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(readFileSync(join(pendingDir, f), 'utf8')))
      .find(p => p.username === USERNAME);
    expect(entry).toBeTruthy();
    expect(entry.task).toContain('[Распознано на изображении:\nВывеска: "Тестовая кофейня"]');
  });
});
