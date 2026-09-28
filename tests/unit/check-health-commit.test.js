// SS-13 — deploy is green only when /health serves the commit it just built.
import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { commitMatches, checkHealthCommit } = require('../../scripts/check-health-commit.js');
const FULL = '107049a722aac96b53f2ae44b32eea6d1b4da0b0';

let server;
afterEach(() => server && server.close());
function serve(status, body) {
  return new Promise(resolve => {
    server = http.createServer((_, res) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); });
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/health`));
  });
}

describe('commitMatches', () => {
  it('accepts the short sha /health reports and a full sha', () => {
    expect(commitMatches('107049a', FULL)).toBe(true);
    expect(commitMatches(FULL, FULL)).toBe(true);
  });
  it('rejects another commit, unknown and empty', () => {
    expect(commitMatches('9a13f85', FULL)).toBe(false);
    expect(commitMatches('unknown', FULL)).toBe(false);
    expect(commitMatches('', FULL)).toBe(false);
    expect(commitMatches('107049a', '')).toBe(false);
  });
});

describe('checkHealthCommit', () => {
  it('ok when 200 and the target commit is served', async () => {
    const url = await serve(200, { status: 'alive', commit: '107049a' });
    expect(await checkHealthCommit(url, FULL)).toMatchObject({ ok: true });
  });
  it('fails on a 200 from the previous release (the silent-drift case)', async () => {
    const url = await serve(200, { status: 'alive', commit: '9a13f85' });
    const r = await checkHealthCommit(url, FULL);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('9a13f85');
  });
  it('fails on non-200 and on an unreachable service', async () => {
    const url = await serve(503, { commit: '107049a' });
    expect((await checkHealthCommit(url, FULL)).ok).toBe(false);
    expect((await checkHealthCommit('http://127.0.0.1:1/health', FULL)).ok).toBe(false);
  });
});

describe('deploy.sh wiring', () => {
  it('gates health on the built commit, not on a bare 200', () => {
    const sh = fs.readFileSync(path.resolve(__dirname, '../../scripts/deploy.sh'), 'utf8');
    expect(sh).toContain('scripts/check-health-commit.js" http://localhost:8080/health "$TARGET"');
    expect(sh).not.toMatch(/STATUS_CODE" = "200" \]; then HEALTHY=1/);
  });
});
