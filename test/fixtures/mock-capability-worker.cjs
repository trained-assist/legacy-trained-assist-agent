'use strict';
// Mock canonical capability handler (issue #2061 PR1, T4).
//
// Stands in for the Cloudflare-side handler so REST and MCP can be compared without a
// network: it reads the SAME contract file the relay reads, which is what makes
// deepEqual(REST, MCP) a meaningful parity check rather than a tautology. Binds
// 127.0.0.1 only — the staging gate forbids non-loopback outbound, so a live Cloudflare
// call is not reachable from a test (and is PR2 anyway).

const http = require('http');
const crypto = require('crypto');
const { loadContract } = require('../../src/capability-relay/contract.js');

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function sortedKeys(obj) {
  const out = {};
  for (const key of Object.keys(obj || {}).sort()) out[key] = obj[key];
  return out;
}

function handleInvoke(contract, toolId, body, headers, state, expectedToken) {
  const auth = headers.authorization || '';
  if (!/^Bearer\s+\S+/.test(auth)) {
    return { status: 401, payload: { error: { code: 'unauthorized', message: 'bearer token required' } } };
  }
  if (expectedToken && auth !== `Bearer ${expectedToken}`) {
    return { status: 401, payload: { error: { code: 'unauthorized', message: 'caller credential rejected' } } };
  }
  if (String(headers['x-relay-contract-version'] || '') !== String(contract.version)) {
    return { status: 400, payload: { error: { code: 'invalid_arguments', message: 'contract version mismatch' } } };
  }
  const tool = contract.tools.find(t => t.toolId === toolId);
  if (!tool) {
    return { status: 404, payload: { error: { code: 'not_found', message: `unknown capability ${toolId}` } } };
  }
  const authContext = sortedKeys(body && body.authContext);
  const operationId = authContext.operationId;
  if (operationId) {
    if (state.operations.has(operationId)) {
      return { status: 409, payload: { error: { code: 'conflict', message: 'operationId already used' } } };
    }
    state.operations.add(operationId);
  }
  const args = (body && body.arguments) || {};
  const draftRef = digest(sortedKeys(args));
  // What the handler records about a call: a digest and the field NAMES. The identity
  // value itself is proxied, never stored — a fixture must not become a place where a
  // caller identity sits in a log the tests then read.
  state.calls.push({
    toolId,
    authContextDigest: digest(authContext),
    authContextKeys: Object.keys(authContext),
    authorizationScheme: 'bearer',
    arguments: sortedKeys(args),
  });
  return {
    status: 200,
    payload: {
      contractVersion: contract.version,
      toolId: tool.toolId,
      effect: tool.mutates ? 'write' : 'read',
      output: {
        draftRef,
        channel: args.channel || null,
        candidateRef: args.candidateRef || null,
        vacancyRef: args.vacancyRef || null,
        tone: args.tone || 'friendly',
      },
      // Only hashes and a scheme — the mock must not become a place where a token or an
      // identity string is stored in a log the tests then read.
      echo: { authContextDigest: digest(authContext), authorizationScheme: 'bearer' },
    },
  };
}

/**
 * @param {object} [opts]
 * @param {number} [opts.port] 0 (default) picks a free loopback port
 * @returns {Promise<{url:string, port:number, calls:object[], close:()=>Promise<void>}>}
 */
/** @param {string} [opts.token] when set, only `Bearer <token>` is accepted — so 401 is testable. */
function startMockWorker({ port = 0, contract = loadContract(), token = null } = {}) {
  const state = { calls: [], operations: new Set() };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const send = (status, payload) => {
        const text = JSON.stringify(payload);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
      };
      if (req.method !== 'POST') return send(405, { error: { code: 'invalid_arguments', message: 'POST only' } });
      const match = /^\/capabilities\/([^/]+)\/invoke$/.exec(req.url.split('?')[0]);
      if (!match) return send(404, { error: { code: 'not_found', message: 'unknown path' } });
      let body = {};
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { /* empty body */ }
      const { status, payload } = handleInvoke(contract, decodeURIComponent(match[1]), body, req.headers, state, token);
      return send(status, payload);
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        url: `http://127.0.0.1:${actual}`,
        port: actual,
        get calls() { return state.calls; },
        close: () => new Promise(done => server.close(() => done())),
      });
    });
  });
}

module.exports = { startMockWorker };

if (require.main === module) {
  const port = Number(process.argv[2] || 0);
  startMockWorker({ port }).then(w => {
    process.stdout.write(`mock capability worker on ${w.url}\n`);
  });
}