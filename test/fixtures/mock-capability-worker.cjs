'use strict';
// Mock canonical communication Worker (issue #2061 PR1 T4, #2034 PR2).
//
// Worker-faithful on the door the live Worker actually serves (src/index.mjs of
// trained-assist-communication-skills): POST <invoke.path> with the tool arguments as
// the raw body, `Authorization: Bearer <token>`, the handler's own contract version in
// a response header. The door path and version pin come from the SAME contract file the
// relay reads, so «direct REST call == relayed MCP call» is a parity check, not a
// tautology. Binds 127.0.0.1 only — the staging gate forbids non-loopback outbound.
//
// Deliberately NOT implemented: the PR1 default envelope door (/capabilities/{toolId}/
// invoke). That path is covered by synthetic unit tests with an injected fetch; a
// fixture door nobody real serves would only test itself.

const http = require('http');
const { loadContract } = require('../../src/capability-relay/contract.js');

function sortedKeys(obj) {
  const out = {};
  for (const key of Object.keys(obj || {}).sort()) out[key] = obj[key];
  return out;
}

function boundDoor(contract) {
  const tool = contract.tools.find(t => t.invoke);
  if (!tool) throw new Error('mock worker: contract has no tool with an invoke binding');
  return { tool, path: tool.invoke.path, version: tool.invoke.contract_version };
}

/**
 * @param {object} [opts]
 * @param {number} [opts.port]    0 (default) picks a free loopback port
 * @param {string} [opts.token]   when set, only `Bearer <token>` is accepted — 401 is testable
 * @param {string} [opts.version] response contract version (default from the contract) — a foreign value makes version_mismatch testable
 * @param {number} [opts.delayMs] artificial latency — makes the relay deadline testable
 * @returns {Promise<{url:string, port:number, calls:object[], close:()=>Promise<void>}>}
 */
function startMockWorker({ port = 0, token = null, version, delayMs = 0 } = {}) {
  const contract = loadContract();
  const door = boundDoor(contract);
  const respondVersion = version !== undefined ? String(version) : door.version;
  const state = { calls: [], operations: new Set() };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const send = (status, payload, { withVersion = false } = {}) => {
        const text = JSON.stringify(payload);
        const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) };
        // The live Worker stamps x-contract-version from the door outward; auth failures
        // happen before the door and carry no version — same here.
        if (withVersion) headers['x-contract-version'] = respondVersion;
        res.writeHead(status, headers);
        res.end(text);
      };
      if (req.method !== 'POST') return send(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } });
      if (req.url.split('?')[0] !== door.path) {
        return send(404, { error: { code: 'NOT_FOUND', message: `нет маршрута ${req.url.split('?')[0]}` } });
      }
      const auth = String(req.headers.authorization || '');
      if (!/^Bearer\s+\S+/.test(auth)) return send(401, { error: { code: 'UNAUTHORIZED', message: 'unauthorized' } });
      if (token && auth !== `Bearer ${token}`) {
        return send(401, { error: { code: 'UNAUTHORIZED', message: 'unauthorized' } });
      }
      const operationId = String(req.headers['x-relay-operation-id'] || '');
      if (operationId) {
        if (state.operations.has(operationId)) {
          return send(409, { error: { code: 'CONFLICT', message: 'operationId already used' } }, { withVersion: true });
        }
        state.operations.add(operationId);
      }
      let args = {};
      try { args = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { args = {}; }
      const emit = () => {
        if (res.writableEnded || res.destroyed) return; // caller gave up (deadline test)
        state.calls.push({
          door: door.path,
          toolId: door.tool.toolId,
          argumentKeys: Object.keys(args || {}).sort(),
          correlation: {
            profileId: String(req.headers['x-relay-profile-id'] || '') || null,
            runId: String(req.headers['x-relay-run-id'] || '') || null,
            taskId: String(req.headers['x-relay-task-id'] || '') || null,
            operationId: operationId || null,
          },
        });
        send(200, {
          status: 'generated',
          message_text: 'mock draft',
          echo: { arguments: sortedKeys(args), correlation: state.calls[state.calls.length - 1].correlation },
        }, { withVersion: true });
      };
      if (delayMs > 0) setTimeout(emit, delayMs).unref?.();
      else emit();
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        url: `http://127.0.0.1:${actual}`,
        port: actual,
        door: door.path,
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
    process.stdout.write(`mock communication worker on ${w.url}${w.door}\n`);
  });
}
