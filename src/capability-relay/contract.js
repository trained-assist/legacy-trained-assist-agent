'use strict';
// The capability relay contract (issue #2061 PR1, §2 of the issue).
//
// This contract file is the SINGLE source of the tools/schema mapping: the MCP
// `tools/list` is a view over it and the REST client posts to the toolId it names.
// Nothing translates names or rewrites schemas in between — that is what keeps a
// REST call and an MCP call on the same capability (§2 of the issue).

const fs = require('fs');
const path = require('path');
const { RelayError } = require('./errors.js');

const CONTRACT_URN = 'urn:trained-assist:capability-relay-contract:v1';
const CONTRACTS_DIR = path.resolve(__dirname, '..', '..', 'contracts');
const CONTRACT_FILE = path.join(CONTRACTS_DIR, 'capability-relay-v1.contract.json');
const SCHEMA_FILE = path.join(CONTRACTS_DIR, 'capability-relay-v1.contract.schema.json');

let cached = null;

function misconfigured(message) {
  return new RelayError('misconfigured', { message });
}

/** Read + validate the contract file. Cached per process: the file is deployed, not written. */
function loadContract({ file = CONTRACT_FILE, useCache = true } = {}) {
  if (useCache && cached && cached.file === file) return cached.contract;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw misconfigured(`capability contract unreadable at ${file}: ${e.code || e.message}`);
  }
  let contract;
  try {
    contract = JSON.parse(raw);
  } catch (e) {
    throw misconfigured(`capability contract is not valid JSON: ${e.message}`);
  }
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw misconfigured('capability contract is not an object');
  }
  if (contract.urn !== CONTRACT_URN) {
    throw misconfigured(`capability contract urn mismatch: ${contract.urn}`);
  }
  if (!Number.isInteger(contract.version) || contract.version < 1) {
    throw misconfigured('capability contract version must be a positive integer');
  }
  if (!contract.http || typeof contract.http.invokePath !== 'string' || !contract.http.invokePath.includes('{toolId}')) {
    throw misconfigured('capability contract http.invokePath must contain {toolId}');
  }
  if (!Array.isArray(contract.tools) || contract.tools.length === 0) {
    throw misconfigured('capability contract must declare at least one tool');
  }
  const seenName = new Set();
  const seenId = new Set();
  for (const tool of contract.tools) {
    if (!tool || typeof tool.name !== 'string' || typeof tool.toolId !== 'string') {
      throw misconfigured('every capability tool needs name and toolId');
    }
    if (typeof tool.description !== 'string' || !tool.description) {
      throw misconfigured(`capability tool ${tool.name} needs a description`);
    }
    if (typeof tool.mutates !== 'boolean') {
      throw misconfigured(`capability tool ${tool.name} must declare mutates`);
    }
    if (!tool.inputSchema || tool.inputSchema.type !== 'object') {
      throw misconfigured(`capability tool ${tool.name} needs an object inputSchema`);
    }
    if (seenName.has(tool.name)) throw misconfigured(`duplicate capability tool name: ${tool.name}`);
    if (seenId.has(tool.toolId)) throw misconfigured(`duplicate capability toolId: ${tool.toolId}`);
    seenName.add(tool.name);
    seenId.add(tool.toolId);
  }
  cached = { file, contract };
  return contract;
}

function contractVersion(contract = loadContract()) {
  return contract.version;
}

function schema() {
  return JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
}

/** MCP view of one contract tool — a projection, not a rewrite. */
function toolView(tool) {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

/** `tools/list` payload. 1:1 with contract.tools[], in contract order. */
function listTools(contract = loadContract()) {
  return contract.tools.map(toolView);
}

/** Find a contract tool by MCP name or by canonical toolId. */
function findTool(contract, nameOrId) {
  return contract.tools.find(t => t.name === nameOrId || t.toolId === nameOrId) || null;
}

function toolIdOf(contract, name) {
  const tool = findTool(contract, name);
  return tool ? tool.toolId : null;
}

/** Invoke URL for a toolId, built from the contract's path template. */
function invokePath(contract, toolId) {
  return contract.http.invokePath.replace('{toolId}', encodeURIComponent(toolId));
}

function invokeUrl(contract, toolId, endpoint) {
  const base = String(endpoint).replace(/\/+$/, '');
  return `${base}${invokePath(contract, toolId)}`;
}

/**
 * R7: no silent switch to another handler. A response must carry OUR contract
 * version; a different or missing one is an explicit version_mismatch.
 */
function checkResponseVersion(expected, got, { contract = loadContract(), source = 'response' } = {}) {
  if (got === undefined || got === null || got === '' || Number(got) !== expected) {
    throw new RelayError('version_mismatch', {
      message: `capability ${source} reports contract version ${got === undefined || got === null || got === '' ? 'none' : got}, relay speaks ${expected}`,
      safeReason: `contract_version_mismatch: ${got === undefined || got === null || got === '' ? 'none' : got} != ${expected}`,
      contractVersion: expected,
      detail: { source },
    });
  }
  return true;
}

module.exports = {
  CONTRACT_URN,
  CONTRACT_FILE,
  SCHEMA_FILE,
  loadContract,
  contractVersion,
  schema,
  toolView,
  listTools,
  findTool,
  toolIdOf,
  invokePath,
  invokeUrl,
  checkResponseVersion,
};