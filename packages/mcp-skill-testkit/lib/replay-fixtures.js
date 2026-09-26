'use strict';

// HTTP record/replay for deterministic behaviour tests. Loads fixture JSON
// files from a directory and installs them via nock; non-loopback outbound is
// blocked so a forgotten fixture fails loudly instead of hitting the network.
//
// Fixture file shape (a single object or an array of them):
//   {
//     "host": "api.hh.ru",                   // or "baseUrl": "https://api.hh.ru"
//     "method": "get",
//     "path": "/vacancies",
//     "requestBody": { ... },                // optional body matcher
//     "status": 200,                         // optional, default 200
//     "headers": { "content-type": "application/json" },
//     "response": { ... }                    // JSON or string
//   }
//
//   const replay = replayFixtures('fixtures/http');
//   // ... run code that fetches ...
//   replay.restore();

const fs = require('fs');
const { join, extname } = require('path');

const LOOPBACK_RE = /^(127\.|localhost$|\[?::1\]?$)/i;

function loadFixtures(dir) {
  if (!fs.existsSync(dir)) throw new Error(`replayFixtures: directory not found: ${dir}`);
  const fixtures = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (extname(name) !== '.json') continue;
    const parsed = JSON.parse(fs.readFileSync(join(dir, name), 'utf8'));
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) fixtures.push({ file: name, ...entry });
  }
  return fixtures;
}

function replayFixtures(dir, nockImpl) {
  const nock = nockImpl || require('nock');
  const fixtures = loadFixtures(dir);

  nock.disableNetConnect();
  nock.enableNetConnect((host) => LOOPBACK_RE.test(host));

  const scopes = fixtures.map((f) => {
    const base = f.baseUrl || `https://${f.host}`;
    const scope = nock(base);
    const method = String(f.method || 'get').toLowerCase();
    const interceptor = f.requestBody !== undefined
      ? scope[method](f.path, f.requestBody)
      : scope[method](f.path);
    return interceptor.reply(f.status || 200, f.response === undefined ? '' : f.response, f.headers || {});
  });

  return {
    fixtures,
    scopes,
    pendingMocks: () => nock.pendingMocks(),
    assertDone: () => {
      const pending = nock.pendingMocks();
      if (pending.length) throw new Error(`replayFixtures: unmatched fixtures: ${pending.join(', ')}`);
    },
    restore: () => { nock.cleanAll(); nock.enableNetConnect(); },
  };
}

module.exports = { replayFixtures, loadFixtures };
