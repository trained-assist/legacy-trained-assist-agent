'use strict';

// invokeAction — the single entry point that runs a registered provider action
// (contracts/action-v1/contract.schema.json#/$defs/invocation; spec §2, §5).
//
// Every trigger — user, cron, durable_task, webhook, system — goes through here.
// MCP tool calls, the /domain web route and cron all end up in one implementation
// so authorization, validation, approval and history are identical everywhere.
//
// This module is transport-agnostic: the provider call is an injected `transport`
// function, so the invoker has no env/IO of its own and can be unit-tested. The
// real transport (scoped child via src/mcp-action.js runMcpTool) is wired in a
// separate slice.
//
// Error split (per contract): *service* errors (bad envelope, unknown action,
// forbidden trigger, approval required, idempotency conflict, provider down) are
// thrown with a stable `code`; *execution* outcomes (provider succeeded/failed)
// are returned as a versioned ActionResult.

const crypto = require('crypto');
const Ajv = require('ajv');
const contract = require('../contracts/action-v1/contract.schema.json');

const SERVICE_ERROR_CODES = [
  'INVALID_ARGUMENTS', 'ACTION_NOT_FOUND', 'FORBIDDEN',
  'APPROVAL_REQUIRED', 'PROVIDER_UNAVAILABLE', 'CONFLICT',
];

function serviceError(code, message) {
  return Object.assign(new Error(message), { code });
}

// Map a transport failure onto a stable contract error code + retryability.
function mapTransportError(err) {
  const code = err && err.code;
  if (code === 'timeout' || code === 'TIMEOUT') return { code: 'TIMEOUT', retryable: true };
  if (code === 'ACTION_NOT_FOUND') return { code: 'ACTION_NOT_FOUND', retryable: false };
  if (code === 'PROVIDER_UNAVAILABLE' || code === 'spawn_error' || code === 'empty_response' || code === 'bad_response') {
    return { code: 'PROVIDER_UNAVAILABLE', retryable: true };
  }
  return { code: 'ACTION_FAILED', retryable: false };
}

function createActionInvoker({ registry, executions, transport, now = () => Date.now() }) {
  if (!registry || !executions || typeof transport !== 'function') {
    throw new Error('createActionInvoker requires { registry, executions, transport }');
  }
  const ajv = new Ajv({ strict: false, allErrors: true });
  ajv.addSchema(contract);
  const validateInvocation = ajv.compile({ $ref: `${contract.$id}#/$defs/invocation` });

  function resultFromRow(row) {
    if (row.status === 'succeeded') return { version: 1, executionId: row.id, status: 'succeeded', output: row.result };
    return { version: 1, executionId: row.id, status: row.status, error: row.error };
  }

  // `options` carries core-side decisions that are NOT part of the versioned
  // envelope: approval (a user/consent decision), and execution identity/lease
  // for recovered attempts.
  async function invokeAction(request = {}, options = {}) {
    if (!validateInvocation(request)) {
      // Never echo arguments/AJV data (may carry credentials).
      throw serviceError('INVALID_ARGUMENTS', 'Action invocation does not match the v1 envelope');
    }
    const { profileId, projectId = null, action, arguments: args, trigger, idempotencyKey,
      origin = null, channel = null } = request;

    // Registration + trigger + argument schema. Throws ACTION_NOT_FOUND / FORBIDDEN / INVALID_ARGUMENTS.
    const descriptor = registry.validateCall(action, args, trigger);

    // Idempotency: one logical invocation per (profile, project, key) across triggers.
    const existing = executions.findByKey({ profileId, projectId, idempotencyKey });
    if (existing) {
      if (existing.action !== action || JSON.stringify(existing.arguments) !== JSON.stringify(args)) {
        throw serviceError('CONFLICT', 'Idempotency key reused with different action or arguments');
      }
      // A cron occurrence is claimed first (cron-service, inside the claim
      // transaction) and executed here afterwards: only the claimer holding the
      // claim's lease may start it; anyone else sees the recorded state.
      const claimed = options.claimedExecutionId && existing.id === options.claimedExecutionId &&
        existing.status === 'claimed';
      if (!claimed) return resultFromRow(existing);
    }

    if (descriptor.requiresApproval && options.approved !== true) {
      throw serviceError('APPROVAL_REQUIRED', 'Action requires explicit approval');
    }

    if (existing) {
      const started = executions.startClaimed(existing.id, { leaseOwner: options.leaseOwner, now: now() });
      if (!started) return resultFromRow(executions.get(existing.id));
      return run(existing.id, options.leaseOwner);
    }

    const executionId = options.executionId || crypto.randomUUID();
    const leaseOwner = options.leaseOwner || `${process.pid}:${executionId}`;
    try {
      executions.beginExecution({
        id: executionId, profileId, projectId, action, arguments: args, trigger,
        idempotencyKey, origin, channel, leaseOwner, now: now(),
      });
    } catch (err) {
      // Lost a race on the unique key — return the winner's execution.
      const row = executions.findByKey({ profileId, projectId, idempotencyKey });
      if (row) return resultFromRow(row);
      throw err;
    }
    return run(executionId, leaseOwner);

    async function run(executionId, leaseOwner) {
    try {
      const output = await transport({ action, arguments: args, profileId, projectId, executionId, trigger });
      executions.finishExecution(executionId, { status: 'succeeded', result: output, leaseOwner, now: now() });
      return { version: 1, executionId, status: 'succeeded', output };
    } catch (err) {
      const { code, retryable } = mapTransportError(err);
      const status = code === 'TIMEOUT' ? 'unknown' : 'failed';
      const error = { code, message: String((err && err.message) || err).slice(0, 500), retryable };
      executions.finishExecution(executionId, { status, error, leaseOwner, now: now() });
      return { version: 1, executionId, status, error };
    }
    }
  }

  return { invokeAction };
}

module.exports = { createActionInvoker, SERVICE_ERROR_CODES };
