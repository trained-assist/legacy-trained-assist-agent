// Integration tests for PUT/GET /intake-files and the /run fileRefs + requestId
// wiring it feeds. The gateway (trained-assist-tg-bot) stores photos/voice/docs
// here instead of base64-in-KV, so a retry can reuse bytes already on disk
// instead of re-sending them (and isn't capped by KV's 25MB value limit).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'os';
import { spawn } from 'child_process';

const SECRET = 'test-agent-secret-intake-files';
const USERNAME = 'intake-files-test-user';

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
  usersDir = mkdtempSync(join(tmpdir(), 'intake-files-users-'));
  dataDir = mkdtempSync(join(tmpdir(), 'intake-files-data-'));
  const { proc, port } = await startServer({
    PORT: '13580',
    SECRETS_SOURCE: 'env',
    TELEGRAM_BOT_TOKEN: 'test-tg-token-intake-files',
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

describe('PUT/GET /intake-files', () => {
  it('stores bytes and returns them on GET, with the stored name/mime/size', async () => {
    const id = 'a'.repeat(64);
    const put = await fetch(base(`/intake-files?username=${USERNAME}&id=${id}&name=photo.jpg`), {
      method: 'PUT',
      headers: { ...authHeader(), 'Content-Type': 'image/jpeg' },
      body: Buffer.from([1, 2, 3, 4]),
    });
    expect(put.status).toBe(200);
    const meta = await put.json();
    expect(meta).toMatchObject({ id, name: 'photo.jpg', mime: 'image/jpeg', size: 4 });

    const get = await fetch(base(`/intake-files?username=${USERNAME}&id=${id}`), { headers: authHeader() });
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('image/jpeg');
    const bytes = Buffer.from(await get.arrayBuffer());
    expect([...bytes]).toEqual([1, 2, 3, 4]);
  });

  it('rejects without the master secret', async () => {
    const res = await fetch(base(`/intake-files?username=${USERNAME}&id=${'b'.repeat(64)}&name=x`), {
      method: 'PUT', body: Buffer.from([1]),
    });
    expect(res.status).toBe(401);
  });

  it('404s for an id that was never stored', async () => {
    const res = await fetch(base(`/intake-files?username=${USERNAME}&id=${'c'.repeat(64)}`), { headers: authHeader() });
    expect(res.status).toBe(404);
  });

  it('rejects a malformed id', async () => {
    const res = await fetch(base(`/intake-files?username=${USERNAME}&id=not-hex`), { headers: authHeader() });
    expect(res.status).toBe(400);
  });

  // tg-bot#319: the gateway hands this path straight to speech_transcribe as `source`.
  // Without it the caller has to re-derive `media/intake-store/<id>/data` — a second copy
  // of this file's layout that breaks silently the day we move the store.
  it('PUT answers with a workspace-relative path the same dir /action spawns tools in', async () => {
    const id = 'e'.repeat(64);
    const put = await fetch(base(`/intake-files?username=${USERNAME}&id=${id}&name=voice.ogg`), {
      method: 'PUT', headers: { ...authHeader(), 'Content-Type': 'audio/ogg' }, body: Buffer.from([1, 2, 3]),
    });
    expect(put.status).toBe(200);
    const meta = await put.json();
    expect(meta.path).toBe(`media/intake-store/${id}/data`);

    // The claim is only useful if the bytes are really there.
    const read = await fetch(base(`/intake-files?username=${USERNAME}&id=${id}`), { headers: authHeader() });
    expect(read.status).toBe(200);
  });
});

describe('/run with fileRefs and requestId', () => {
  it('copies a stored fileRef into the task media dir and notes it in the task', async () => {
    const id = 'd'.repeat(64);
    await fetch(base(`/intake-files?username=${USERNAME}&id=${id}&name=note.txt`), {
      method: 'PUT', headers: { ...authHeader(), 'Content-Type': 'text/plain' }, body: Buffer.from('hello'),
    });
    const run = await fetch(base('/run'), {
      method: 'POST', headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: '111', username: USERNAME, task: 'проверь файл',
        fileRefs: [{ id, name: 'note.txt', mime: 'text/plain' }],
      }),
    });
    expect(run.status).toBe(202);
    const copied = join(usersDir, USERNAME, 'media', 'intake', `${id}-note.txt`);
    // /run copies the ref synchronously before accepting; give the fire-and-forget
    // background runTask a tick to avoid a false negative if that ordering ever shifts.
    await new Promise(r => setTimeout(r, 100));
    expect(existsSync(copied)).toBe(true);
    expect(readFileSync(copied, 'utf8')).toBe('hello');
  });

  it('a repeated requestId returns the same taskId instead of starting a second run', async () => {
    const requestId = 'req-dedup-test-1';
    const body = JSON.stringify({ userId: '112', username: USERNAME, task: 'дубль?', requestId });
    const first = await fetch(base('/run'), { method: 'POST', headers: { ...authHeader(), 'Content-Type': 'application/json' }, body });
    const second = await fetch(base('/run'), { method: 'POST', headers: { ...authHeader(), 'Content-Type': 'application/json' }, body });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstJson = await first.json();
    const secondJson = await second.json();
    expect(secondJson.taskId).toBe(firstJson.taskId);
    expect(secondJson.duplicate).toBe(true);
    expect(firstJson.duplicate).toBeUndefined();
  });

  it('rejects a malformed requestId', async () => {
    const res = await fetch(base('/run'), {
      method: 'POST', headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: '113', username: USERNAME, task: 'x', requestId: 'has a space' }),
    });
    expect(res.status).toBe(400);
  });
});
