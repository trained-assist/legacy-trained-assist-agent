'use strict';
// Issue #1916 PR-A — session blob store (epic #1784 M2).
//
// The whole point of this file: the GCS client is INJECTED, so nothing here
// touches ADC, the metadata server, the network or a real bucket. The fake
// bucket implements exactly the shape the module uses —
// bucket.file(key).{save,getMetadata,download,exists} — and records what it was
// asked to do, so the assertions are about OUR contract, not about GCS.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  createSessionBlobStore,
  sessionKey,
  transcriptKey,
  slugCwd,
  resolveBucketName,
  sha256Hex,
  assertSafeKey,
  DEFAULT_BUCKET,
} = require('../src/session-blob-store');

// ── fake bucket ───────────────────────────────────────────────────────────────

function fakeBucket() {
  const objects = new Map(); // key -> { data, generation, contentType, size }
  const calls = { save: [], getMetadata: [], download: [], exists: [] };
  let generation = 1_700_000_000_000_000;
  const nextError = { op: null, err: null }; // one-shot failure injection

  function maybeFail(op) {
    if (nextError.op === op) {
      const err = nextError.err;
      nextError.op = null;
      nextError.err = null;
      throw err;
    }
  }

  function notFound(key) {
    const err = new Error(`No such object: ${key}`);
    err.code = 404;
    return err;
  }

  const bucket = {
    name: 'fake-test-bucket',
    objects,
    calls,
    failNext(op, err) { nextError.op = op; nextError.err = err; },
    file(key) {
      return {
        async save(data, opts = {}) {
          calls.save.push({ key, opts, bytes: Buffer.from(data) });
          maybeFail('save');
          generation += 1;
          objects.set(key, {
            data: Buffer.from(data),
            generation: String(generation),
            contentType: opts.contentType,
            contentEncoding: opts.contentEncoding,
          });
        },
        async getMetadata() {
          calls.getMetadata.push({ key });
          maybeFail('getMetadata');
          const obj = objects.get(key);
          if (!obj) throw notFound(key);
          return [{ generation: obj.generation, contentType: obj.contentType, size: String(obj.data.length) }];
        },
        async download() {
          calls.download.push({ key });
          maybeFail('download');
          const obj = objects.get(key);
          if (!obj) throw notFound(key);
          return [Buffer.from(obj.data)];
        },
        async exists() {
          calls.exists.push({ key });
          maybeFail('exists');
          return [objects.has(key)];
        },
      };
    },
  };
  return bucket;
}

const KEY = 'profiles/alice/sessions/s-123-456.json.gz';

// ── upload ────────────────────────────────────────────────────────────────────

test('upload returns {sha256, size, generation} and stores the exact bytes', async () => {
  const bucket = fakeBucket();
  const store = createSessionBlobStore({ bucket });
  const payload = Buffer.from('gzipped session body');

  const res = await store.upload(KEY, payload);

  assert.equal(res.sha256, crypto.createHash('sha256').update(payload).digest('hex'));
  assert.equal(res.sha256, sha256Hex(payload));
  assert.equal(res.sha256.length, 64);
  assert.equal(res.size, payload.length);
  assert.equal(typeof res.generation, 'string');
  assert.ok(Number(res.generation) > 0, 'generation is the GCS object generation');

  const stored = bucket.objects.get(KEY);
  assert.ok(stored, 'object is in the bucket');
  assert.deepEqual(stored.data, payload, 'byte-for-byte — what sha256 was taken over');
  assert.equal(stored.generation, res.generation);
  assert.equal(bucket.calls.save[0].key, KEY);
});

test('upload marks the object as gzip content and never sets content-encoding (bytes are pre-gzipped by the caller)', async () => {
  const bucket = fakeBucket();
  const store = createSessionBlobStore({ bucket });

  await store.upload(KEY, Buffer.from([0x1f, 0x8b]));

  const { opts } = bucket.calls.save[0];
  assert.equal(opts.contentType, 'application/gzip');
  assert.equal(opts.contentEncoding, undefined, 'GCS must not decompress what the caller gzipped');
  assert.equal(bucket.objects.get(KEY).contentEncoding, undefined);
});

test('upload overwrites the same key and reports the NEW generation (a session is re-archived after every run)', async () => {
  const bucket = fakeBucket();
  const store = createSessionBlobStore({ bucket });

  const first = await store.upload(KEY, Buffer.from('run 1'));
  const second = await store.upload(KEY, Buffer.from('run 2'));

  assert.notEqual(second.generation, first.generation);
  assert.equal(bucket.objects.size, 1, 'one key, one object');
  assert.deepEqual(bucket.objects.get(KEY).data, Buffer.from('run 2'));
  assert.equal(second.sha256, sha256Hex(Buffer.from('run 2')));
});

test('upload accepts a string payload (encoded utf8)', async () => {
  const bucket = fakeBucket();
  const store = createSessionBlobStore({ bucket });
  const res = await store.upload(KEY, 'привет');
  assert.equal(res.size, Buffer.byteLength('привет', 'utf8'));
  assert.equal(res.sha256, sha256Hex(Buffer.from('привет', 'utf8')));
});

test('upload rejects a payload it cannot hash honestly', async () => {
  const bucket = fakeBucket();
  const store = createSessionBlobStore({ bucket });
  await assert.rejects(() => store.upload(KEY, { not: 'bytes' }), /data must be a Buffer or string/);
  assert.equal(bucket.objects.size, 0, 'nothing was written');
});

test('upload surfaces an unreadable object metadata as BLOB_UPLOAD_UNVERIFIED (the bytes ARE stored — the caller must not treat it as a failed upload)', async () => {
  const bucket = fakeBucket();
  const store = createSessionBlobStore({ bucket });
  bucket.failNext('getMetadata', new Error('socket hang up'));

  await assert.rejects(
    () => store.upload(KEY, Buffer.from('x')),
    e => e.code === 'BLOB_UPLOAD_UNVERIFIED'
  );
  assert.ok(bucket.objects.has(KEY), 'the object survived the metadata failure');
});

// ── download / exists ─────────────────────────────────────────────────────────

test('download returns the stored bytes byte-for-byte (revert must reproduce them)', async () => {
  const bucket = fakeBucket();
  const store = createSessionBlobStore({ bucket });
  const payload = crypto.randomBytes(4096);
  await store.upload(KEY, payload);

  const got = await store.download(KEY);

  assert.ok(Buffer.isBuffer(got));
  assert.deepEqual(got, payload);
  assert.equal(sha256Hex(got), sha256Hex(payload));
});

test('download of a missing object rejects with BLOB_NOT_FOUND, not a raw 404', async () => {
  const bucket = fakeBucket();
  const store = createSessionBlobStore({ bucket });

  await assert.rejects(
    () => store.download('profiles/alice/sessions/never-archived.json.gz'),
    e => e.code === 'BLOB_NOT_FOUND' && /never-archived/.test(e.message)
  );
});

test('a non-404 download failure is NOT rewritten into BLOB_NOT_FOUND', async () => {
  const bucket = fakeBucket();
  const store = createSessionBlobStore({ bucket });
  const down = new Error('backend error');
  down.code = 503;
  bucket.failNext('download', down);

  await assert.rejects(() => store.download(KEY), e => e.code === 503);
});

test('exists is true after upload and false before it', async () => {
  const bucket = fakeBucket();
  const store = createSessionBlobStore({ bucket });

  assert.equal(await store.exists(KEY), false);
  await store.upload(KEY, Buffer.from('x'));
  assert.equal(await store.exists(KEY), true);
  assert.equal(await store.exists('profiles/alice/sessions/other.json.gz'), false);
});

// ── deadlines ─────────────────────────────────────────────────────────────────

test('a hung call is bounded by timeoutMs and rejects with BLOB_TIMEOUT', async () => {
  const hang = {
    name: 'hanging-bucket',
    file: () => ({
      save: () => new Promise(() => {}),
      getMetadata: () => new Promise(() => {}),
      download: () => new Promise(() => {}),
      exists: () => new Promise(() => {}),
    }),
  };
  const store = createSessionBlobStore({ bucket: hang, timeoutMs: 25 });

  const t0 = Date.now();
  await assert.rejects(() => store.upload(KEY, Buffer.from('x')), e => e.code === 'BLOB_TIMEOUT');
  await assert.rejects(() => store.download(KEY), e => e.code === 'BLOB_TIMEOUT');
  assert.ok(Date.now() - t0 < 5_000, 'the deadline actually fired');
});

test('the default per-call deadline is minutes-scale, not seconds (archive of a big transcript)', () => {
  const store = createSessionBlobStore({ bucket: fakeBucket() });
  assert.equal(store.bucketName, 'fake-test-bucket');
  const { DEFAULT_TIMEOUT_MS } = require('../src/session-blob-store');
  assert.ok(DEFAULT_TIMEOUT_MS >= 30_000 && DEFAULT_TIMEOUT_MS <= 300_000);
});

// ── key schema ────────────────────────────────────────────────────────────────

test('sessionKey / transcriptKey build exactly the documented key schema', () => {
  assert.equal(sessionKey('alice', 's-1234567890-1234567890'), 'profiles/alice/sessions/s-1234567890-1234567890.json.gz');
  assert.equal(
    transcriptKey('alice', 'Users-vova-Code-my-project', 'abc-DEF_123.45'),
    'profiles/alice/transcripts/Users-vova-Code-my-project/abc-DEF_123.45.jsonl.gz'
  );
  // Prefix shape — PR-B stores these as the ledger `dest`.
  assert.ok(sessionKey('p', 's').startsWith('profiles/p/sessions/'));
  assert.ok(transcriptKey('p', 'slug', 't').startsWith('profiles/p/transcripts/slug/'));
});

test('key builders reject anything that is not one safe path segment', () => {
  const badIds = ['', '..', '.', '../evil', 'a/b', 'a\\b', 'a\0b', 'x'.repeat(201)];
  for (const id of badIds) {
    assert.throws(() => sessionKey('alice', id), /invalid sessionId/, `sessionId ${JSON.stringify(id)}`);
    assert.throws(() => transcriptKey('alice', 'slug', id), /invalid engineSessionId/);
    assert.throws(() => transcriptKey('alice', id, 'eng'), /invalid slugCwd/);
  }
  for (const p of ['', '..', 'a b', 'a/b', 'x'.repeat(65)]) {
    assert.throws(() => sessionKey(p, 's'), /invalid profile name/, `profile ${JSON.stringify(p)}`);
  }
});

test('assertSafeKey blocks absolute paths, traversal, NUL and backslash tricks (the isSafeRelPath contract)', () => {
  const good = [
    'profiles/alice/sessions/s-1.json.gz',
    'profiles/alice/transcripts/Users-vova-Code-x/eng-1.jsonl.gz',
    'a/b/c.json.gz',
  ];
  for (const k of good) assert.equal(assertSafeKey(k), k);

  const bad = [
    '',
    '/profiles/a/sessions/s.json.gz',
    'profiles/../other/sessions/s.json.gz',
    'profiles/./a.json.gz',
    'profiles/a//b.json.gz',
    'profiles\\a\\sessions\\s.json.gz',
    'profiles/alice/sessions/..\u0000.json.gz',
    'profiles/alice/sessions/x y.json.gz',
  ];
  for (const k of bad) assert.throws(() => assertSafeKey(k), /unsafe blob key/, JSON.stringify(k));
});

test('upload/download/exists refuse an unsafe key before touching the bucket', async () => {
  const bucket = fakeBucket();
  const store = createSessionBlobStore({ bucket });

  for (const fn of [
    () => store.upload('../escape.json.gz', Buffer.from('x')),
    () => store.download('/etc/passwd'),
    () => store.exists('profiles/../escape.json.gz'),
  ]) {
    await assert.rejects(fn, /unsafe blob key/);
  }
  assert.equal(bucket.calls.save.length + bucket.calls.download.length + bucket.calls.exists.length, 0);
});

// ── slug-cwd (the transcript key's middle segment) ────────────────────────────

test('slugCwd is stable, segment-safe and survives a Russian/space-heavy path', () => {
  assert.equal(slugCwd('/home/vova/users/alice'), 'home-vova-users-alice');
  assert.equal(slugCwd('/Users/vova/Code/my project (v2)'), 'Users-vova-Code-my-project-v2');
  assert.equal(slugCwd('/home/vova/users/alice'), slugCwd('/home/vova/users/alice/'), 'trailing slash does not change it');
  assert.equal(slugCwd('/дом/проект'), slugCwd('/дом/проект'), 'deterministic');

  for (const cwd of ['/home/vova/users/alice', '/a/b c/d', '/проект 2', 'relative/path']) {
    const s = slugCwd(cwd);
    assert.match(s, /^[a-zA-Z0-9_.-]+$/, `slug ${s} is one safe segment`);
    assert.notEqual(s, '.');
    assert.notEqual(s, '..');
    assert.ok(!s.includes('/'), 'no separators left');
    // usable straight in transcriptKey()
    assert.equal(typeof transcriptKey('alice', s, 'eng-1'), 'string');
  }
  assert.throws(() => slugCwd(''), /invalid cwd/);
  assert.throws(() => slugCwd(null), /invalid cwd/);
});

test('slugCwd never throws on a cwd it cannot spell: hash fallback stays stable and segment-safe', () => {
  // Nothing ASCII left to write — the slug must still exist (PR-C recomputes the
  // key from cwd alone) and must be the same tomorrow.
  const cyr = slugCwd('/дом/проект');
  assert.equal(cyr, slugCwd('/дом/проект'), 'deterministic');
  assert.notEqual(cyr, slugCwd('/дом/другой'), 'different cwd → different slug');
  assert.match(cyr, /^[a-zA-Z0-9_.-]+$/);
  assert.match(cyr, /^cwd-[0-9a-f]{16}$/);
  assert.equal(slugCwd('///'), slugCwd('///'));
  assert.equal(slugCwd('..'), slugCwd('..'), '".." never becomes a traversal segment');

  // Too long → truncated + hash suffix, still one segment, still stable.
  const long = `/home/vova/users/alice/${'nested-dir-'.repeat(40)}`;
  const s = slugCwd(long);
  assert.ok(s.length <= 200, `slug length ${s.length} stays within one segment`);
  assert.match(s, /^[a-zA-Z0-9_.-]+$/);
  assert.equal(s, slugCwd(long));
  assert.notEqual(
    s,
    slugCwd(`/home/vova/users/alice/${'nested-dir-'.repeat(40)}extra`),
    'long cwds sharing a prefix stay distinct'
  );
  assert.ok(long.length > 180, 'the fixture really is over the truncation line');
});

// ── bucket config ─────────────────────────────────────────────────────────────

test('resolveBucketName: $GCS_BUCKET wins, unset falls back to the documented default', () => {
  assert.equal(resolveBucketName({}), DEFAULT_BUCKET);
  assert.equal(DEFAULT_BUCKET, 'trained-assist-workspaces');
  assert.equal(resolveBucketName({ GCS_BUCKET: 'my-bucket' }), 'my-bucket');
  assert.equal(resolveBucketName({ GCS_BUCKET: '  my-bucket  ' }), 'my-bucket');
  assert.equal(resolveBucketName({ GCS_BUCKET: '' }), DEFAULT_BUCKET);
});

test('resolveBucketName rejects a name GCS would reject anyway', () => {
  for (const bad of ['ab', 'UPPER', '-nope', 'nope-', 'has space', 'a..b', 'x'.repeat(64)]) {
    assert.throws(() => resolveBucketName({ GCS_BUCKET: bad }), /invalid GCS bucket name/, JSON.stringify(bad));
  }
});

test('the store reads $GCS_BUCKET from the environment when no bucket is injected', () => {
  const prev = process.env.GCS_BUCKET;
  process.env.GCS_BUCKET = 'env-bucket';
  try {
    assert.equal(resolveBucketName(), 'env-bucket');
  } finally {
    if (prev === undefined) delete process.env.GCS_BUCKET;
    else process.env.GCS_BUCKET = prev;
  }
});

// ── isolation guarantees ──────────────────────────────────────────────────────

test('loading this module never pulls in @google-cloud/storage (no ADC read at import time)', () => {
  const pkgMain = require.resolve('@google-cloud/storage');
  assert.equal(require.cache[pkgMain], undefined, '@google-cloud/storage must stay lazy — tests and non-GCP processes never construct a client');
});

test('an injected bucket is used as-is: no client is constructed behind the caller\'s back', async () => {
  const bucket = fakeBucket();
  const store = createSessionBlobStore({ bucket });
  await store.upload(KEY, Buffer.from('x'));
  assert.equal(bucket.calls.save.length, 1, 'the injected fake served the call');
});
