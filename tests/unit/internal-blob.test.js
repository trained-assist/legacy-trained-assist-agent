// /internal/blob/* — тяжёлые кандидатские файлы в GCS (hh-skill #105):
// upload сырых байтов → session-blob-store (в тестах — файловый фейк GCS_FAKE_DIR,
// который глобально выставлен tests/setup-isolation.mjs) → download байтами назад.
import { describe, it, expect, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { handleInternal } = require('../../src/handlers/internal.js');
const { candidateDocKey, createSessionBlobStore } = require('../../src/session-blob-store.js');

function fakeReq(buf, headers = {}, method = 'POST') {
  const req = Readable.from([Buffer.isBuffer(buf) ? buf : Buffer.from(buf)]);
  req.headers = headers;
  req.method = method;
  req.destroy = req.destroy || (() => {});
  return req;
}

function makeRes() {
  const out = { status: null, headers: {}, body: null, json: null };
  const res = {
    writeHead(status, headers) { out.status = status; Object.assign(out.headers, headers || {}); return res; },
    setHeader(k, v) { out.headers[k] = v; },
    end(b) { out.body = b; return res; },
  };
  return { res, out };
}

async function callUpload(params, buf, headers = {}) {
  const url = new URL('http://x/internal/blob/upload?' + new URLSearchParams(params));
  const { res, out } = makeRes();
  const ctx = {
    json: (_r, status, data) => { out.status = status; out.json = data; },
    readBody: async () => '',
    readBodyBuffer: undefined, // используем fallback-реализацию внутри хэндлера
    BASE_USERS_DIR: '/tmp',
    getGtdTickNow: () => async () => {},
  };
  const req = fakeReq(buf, headers);
  await handleInternal(req, url, res, ctx);
  return out;
}

async function callDownload(params) {
  const url = new URL('http://x/internal/blob/download?' + new URLSearchParams(params));
  const { res, out } = makeRes();
  const ctx = {
    json: (_r, status, data) => { out.status = status; out.json = data; },
    readBody: async () => '',
    BASE_USERS_DIR: '/tmp',
    getGtdTickNow: () => async () => {},
  };
  await handleInternal(fakeReq('', {}, 'GET'), url, res, ctx);
  return out;
}

const OK = { username: 'alice', candidate_id: 'anna-1', doc_id: 'm1a2b3', ext: '.m4a' };

describe('candidateDocKey', () => {
  it('builds the profiles/<user>/candidate-docs/<cand>/<doc><ext> key', () => {
    expect(candidateDocKey('alice', 'anna-1', 'm1a2b3', '.M4A')).toBe('profiles/alice/candidate-docs/anna-1/m1a2b3.m4a');
  });
  it('rejects traversal, bad profile and bad ext', () => {
    expect(() => candidateDocKey('../etc', 'a', 'b', '.x')).toThrow(/profile/i);
    expect(() => candidateDocKey('alice', '../up', 'b', '.x')).toThrow(/candidateId/);
    expect(() => candidateDocKey('alice', 'a', 'b', 'png')).toThrow(/ext/);
    expect(() => candidateDocKey('alice', 'a', 'b', '.phtml;rm')).toThrow(/ext/);
  });
});

describe('/internal/blob/upload → download', () => {
  beforeEach(() => { /* файловый фейк живёт в GCS_FAKE_DIR из setup-isolation */ });

  it('roundtrips raw bytes with size/sha and returns them verbatim', async () => {
    const payload = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x42, 0x0a, 0x00]);
    const up = await callUpload(OK, payload, { 'content-type': 'audio/mp4' });
    expect(up.status).toBe(200);
    expect(up.json.ok).toBe(true);
    expect(up.json.size).toBe(payload.length);
    expect(up.json.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(up.json.key).toBe('profiles/alice/candidate-docs/anna-1/m1a2b3.m4a');

    const down = await callDownload(OK);
    expect(down.status).toBe(200);
    expect(down.headers['Content-Type']).toBe('application/octet-stream');
    expect(Buffer.from(down.body).equals(payload)).toBe(true);
  });

  it('rejects invalid params before touching the store', async () => {
    expect((await callUpload({ ...OK, username: '../etc/passwd' }, 'x')).status).toBe(400);
    expect((await callUpload({ ...OK, ext: 'nope' }, 'x')).status).toBe(400);
    expect((await callUpload({ ...OK, candidate_id: 'a/b' }, 'x')).status).toBe(400);
    const empty = await callUpload(OK, Buffer.alloc(0));
    expect(empty.status).toBe(400);
    expect(empty.json.error).toMatch(/пустое/);
  });

  it('download of a missing object → 404 with the key', async () => {
    const out = await callDownload({ ...OK, doc_id: 'never' });
    expect(out.status).toBe(404);
    expect(out.json.error).toMatch(/не найден/);
  });

  it('re-upload of the same key overwrites (store semantics)', async () => {
    await callUpload(OK, Buffer.from('v1'), { 'content-type': 'text/plain' });
    await callUpload(OK, Buffer.from('v2-longer'), { 'content-type': 'text/plain' });
    const down = await callDownload(OK);
    expect(Buffer.from(down.body).toString()).toBe('v2-longer');
    // sha в store считается от записанных байтов
    const again = await callUpload(OK, Buffer.from('v2-longer'), { 'content-type': 'text/plain' });
    expect(again.json.sha256).toBe(require('node:crypto').createHash('sha256').update('v2-longer').digest('hex'));
    expect(typeof createSessionBlobStore().bucketName).toBe('string');
  });
});

async function callDelete(params) {
  const url = new URL('http://x/internal/blob/delete?' + new URLSearchParams(params));
  const { res, out } = makeRes();
  const ctx = {
    json: (_r, status, data) => { out.status = status; out.json = data; },
    readBody: async () => '',
    BASE_USERS_DIR: '/tmp',
    getGtdTickNow: () => async () => {},
  };
  const req = fakeReq('', {}, 'POST');
  await handleInternal(req, url, res, ctx);
  return out;
}

describe('/internal/blob/delete — удаление документа (#107)', () => {
  it('upload → delete → download 404; повторный delete идемпотентен', async () => {
    const up = await callUpload(OK, Buffer.from('bytes-to-die'), { 'content-type': 'audio/mp4' });
    expect(up.status).toBe(200);

    const del = await callDelete(OK);
    expect(del.status).toBe(200);
    expect(del.json).toMatchObject({ ok: true, deleted: true });

    const down = await callDownload(OK);
    expect(down.status).toBe(404);

    const again = await callDelete(OK);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ ok: true, deleted: false });
  });

  it('невалидные параметры → 400, объект не трогается', async () => {
    expect((await callDelete({ ...OK, username: '../etc' })).status).toBe(400);
    expect((await callDelete({ ...OK, ext: 'x' })).status).toBe(400);
  });
});
