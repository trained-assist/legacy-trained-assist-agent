'use strict';
// Branded copies of site_deploy folders at /s/<project>/ (src/site-mirror.js):
// one owner per name, atomic replace, no dotfiles/symlinks, traversal-safe serving,
// CSP sandbox so user JS cannot touch the product origin.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mirrorSite, serveSite, SANDBOX_CSP } = require('../src/site-mirror');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'site-mirror-')); }
function site(root, files) {
  const dir = fs.mkdtempSync(path.join(root, 'src-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}
function fakeRes() {
  const r = { status: 0, headers: {}, body: Buffer.alloc(0) };
  r.writeHead = (s, h = {}) => { r.status = s; r.headers = h; };
  r.write = (c) => { r.body = Buffer.concat([r.body, Buffer.from(c)]); return true; };
  r.end = (c) => { if (c) r.write(c); r.done = true; r.emit?.('finish'); };
  r.on = r.once = r.emit = () => r; r.removeListener = () => r;
  return r;
}
async function get(dataRoot, p, method = 'GET') {
  const res = new (require('stream').PassThrough)();
  const out = { status: 0, headers: {}, chunks: [] };
  res.writeHead = (s, h = {}) => { out.status = s; out.headers = h; };
  res.on('data', c => out.chunks.push(c));
  const done = new Promise(r => res.on('end', r));
  const handled = serveSite({ method }, new URL('http://x' + p), res, dataRoot);
  if (handled && !res.writableEnded) await done; else await new Promise(r => setImmediate(r));
  return { handled, ...out, body: Buffer.concat(out.chunks).toString() };
}

test('mirror copies files (skipping dotfiles/symlinks), returns the branded URL, serves with sandbox CSP', async () => {
  const root = tmp(); const data = path.join(root, 'data');
  const src = site(root, { 'index.html': '<h1>hi</h1>', 'css/a.css': 'b{}', '.git/config': 'secret', '.env': 'K=1' });
  fs.symlinkSync('/etc/passwd', path.join(src, 'pw.txt'));
  const r = mirrorSite({ src, name: 'demo', username: 'alice', dataRoot: data, env: {} });
  assert.deepEqual(r, { ok: true, url: 'https://recruiter-assistant.ru/s/demo/' });
  assert.equal(fs.existsSync(path.join(data, 'sites', 'demo', '.git')), false);
  assert.equal(fs.existsSync(path.join(data, 'sites', 'demo', 'pw.txt')), false);

  const idx = await get(data, '/s/demo/');
  assert.equal(idx.status, 200); assert.equal(idx.body, '<h1>hi</h1>');
  assert.equal(idx.headers['Content-Security-Policy'], SANDBOX_CSP);
  assert.ok(!SANDBOX_CSP.includes('allow-same-origin'));
  const css = await get(data, '/s/demo/css/a.css');
  assert.equal(css.status, 200); assert.match(css.headers['Content-Type'], /text\/css/);
  const redir = await get(data, '/s/demo');
  assert.equal(redir.status, 301); assert.equal(redir.headers.Location, '/s/demo/');
  const head = await get(data, '/s/demo/', 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.body, '');
});

test('traversal, dot paths, unknown sites and other routes are refused', async () => {
  const root = tmp(); const data = path.join(root, 'data');
  fs.mkdirSync(path.join(data, 'sites'), { recursive: true });
  fs.writeFileSync(path.join(data, 'sites', 'demo.meta.json'), '{"owner":"alice"}');
  mirrorSite({ src: site(root, { 'index.html': 'x' }), name: 'demo', username: 'alice', dataRoot: data, env: {} });
  for (const p of ['/s/demo/..%2fdemo.meta.json', '/s/demo/%2e%2e/demo.meta.json', '/s/demo/.hidden', '/s/nope/', '/s/demo/missing.js']) {
    const r = await get(data, p);
    // 404 here, or not handled at all (WHATWG URL folds %2e%2e before routing).
    assert.ok(r.status === 404 || (!r.handled && r.status === 0), `${p} → ${r.status}`);
    assert.ok(!r.body.includes('owner'), p);
  }
  assert.equal((await get(data, '/p/demo')).handled, false);
  assert.equal(serveSite({ method: 'POST' }, new URL('http://x/s/demo/'), fakeRes(), data), false);
});

test('one owner per name; owner redeploy replaces content atomically; SITES_PUBLIC_URL overrides base', async () => {
  const root = tmp(); const data = path.join(root, 'data');
  assert.equal(mirrorSite({ src: site(root, { 'index.html': 'v1', 'old.js': '1' }), name: 'x-site', username: 'alice', dataRoot: data, env: {} }).ok, true);
  const bob = mirrorSite({ src: site(root, { 'index.html': 'evil' }), name: 'x-site', username: 'bob', dataRoot: data, env: {} });
  assert.equal(bob.ok, false); assert.match(bob.error, /другим профилем/);
  assert.equal((await get(data, '/s/x-site/')).body, 'v1');
  const again = mirrorSite({ src: site(root, { 'index.html': 'v2' }), name: 'x-site', username: 'alice', dataRoot: data, env: { SITES_PUBLIC_URL: 'https://stage.example/' } });
  assert.equal(again.url, 'https://stage.example/s/x-site/');
  assert.equal((await get(data, '/s/x-site/')).body, 'v2');
  assert.equal((await get(data, '/s/x-site/old.js')).status, 404, 'files removed from the folder disappear');
  assert.deepEqual(fs.readdirSync(path.join(data, 'sites')).filter(n => n.startsWith('.')), [], 'no tmp/old leftovers');
});
