'use strict';
// Probe face of the communication capability (issue #2034).
//
// src/prompt-domains/probe.js loads every file in this directory under the relay's
// own env and asks `isReady()` — the SAME predicate that gates tools/list in
// src/capability-relay/index.js (both call env.js toolReady on the contract entry),
// so the prompt text appears exactly when the tool does. No second definition of
// readiness: this file only looks the capability up and asks.
const { loadContract } = require('../contract.js');
const { toolReady } = require('../env.js');

function communicationTool(env = process.env) {
  try {
    const contract = loadContract();
    return contract.tools.find(t => (t.toolId || '').startsWith('communication.')) || null;
  } catch {
    return null; // unreadable contract → not ready, never a thrown probe
  }
}

function isReady(env = process.env) {
  const tool = communicationTool(env);
  return Boolean(tool && toolReady(tool, env));
}

module.exports = { isReady, communicationTool };
