'use strict';

// Host-side ActionBroker (design §3.1/§3.2, PR2). A *narrow* private callback
// that lets a core-owned adapter process reach `invokeAction` without ever
// opening the operational SQLite itself. The host server is the single
// execution owner: it holds `ActionExecutions`, resolves policy/approval,
// derives the idempotency key host-side and finalizes history. The adapter
// only owns the provider process/private copy/journal.
//
// Transport: newline-delimited JSON over a private local Unix socket on the
// same Linux host. A capability is registered at engine launch, is scoped to
// exactly one run/provider binding, and is revoked when that run stops. Raw
// credentials never travel over this socket.
//
// Call flow:
//   adapter --call--> broker
//   broker  --provider--> adapter        (invokeAction's transport callback)
//   adapter --providerResult--> broker   (adapter -> provider child over MCP)
//   broker  --result--> adapter
//
// This module has no dependency on better-sqlite3 / ActionExecutions internals:
// the caller injects `executions`, so the host owns the durable store.

const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { createActionInvoker } = require('./action-invoke');
const { stableStringify } = require('./mcp-skill-generation');

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_DEADLINE_MS = 45_000;

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(16).toString('hex')}`;
}

function deriveIdempotencyKey(runBinding, action, args) {
  // Host-stable: derived from the run/task identity + canonical action/args —
  // never taken from model arguments or a JSON-RPC request id.
  const basis = stableStringify({
    engineRunId: runBinding.engineRunId,
    rootTaskId: runBinding.rootTaskId,
    attemptId: runBinding.attemptId ?? null,
    providerId: runBinding.providerId ?? null,
    action,
    arguments: args ?? {},
  });
  return 'mcp-' + crypto.createHash('sha256').update(basis).digest('hex').slice(0, 40);
}

function writeLine(socket, message) {
  if (!socket.writable) return false;
  socket.write(JSON.stringify(message) + '\n');
  return true;
}

function attachLineReader(socket, onMessage, onError) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE_BYTES) {
      onError(Object.assign(new Error('Broker line exceeds bounded size'), { code: 'bad_response' }));
      socket.destroy();
      return;
    }
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      try { onMessage(msg); } catch (e) { onError(e); }
    }
  });
  socket.on('error', onError);
}

// ── Host broker ────────────────────────────────────────────────────────────

class ActionBroker {
  #executions;
  #now;
  #capabilities = new Map();
  #server = null;
  #path = null;
  #sockets = new Set();

  constructor({ executions, now = () => Date.now() } = {}) {
    if (!executions) throw new TypeError('executions is required (host owns ActionExecutions)');
    this.#executions = executions;
    this.#now = now;
  }

  get path() { return this.#path; }
  get size() { return this.#capabilities.size; }

  registerCapability(capability, { generation, runBinding, approved = false, deadlineMs = DEFAULT_DEADLINE_MS, coreServers = null, providerEnvs = null } = {}) {
    if (typeof capability !== 'string' || !capability) throw new TypeError('capability required');
    if (!generation || !generation.actions) throw new TypeError('generation with actions required');
    if (!runBinding || typeof runBinding !== 'object') throw new TypeError('runBinding required');
    this.#capabilities.set(capability, {
      generation, runBinding, approved: approved === true, deadlineMs,
      coreServers, providerEnvs: providerEnvs || null, revoked: false, registeredAt: this.#now(),
    });
    return { capability, endpoint: this.#path };
  }

  revokeCapability(capability, reason = 'revoked') {
    const entry = this.#capabilities.get(capability);
    if (!entry) return false;
    entry.revoked = true;
    entry.revokeReason = reason;
    this.#capabilities.delete(capability);
    return true;
  }

  listen(socketPath) {
    if (this.#server) throw new Error('Broker is already listening');
    fs.mkdirSync(require('path').dirname(socketPath), { recursive: true, mode: 0o700 });
    try { fs.rmSync(socketPath, { force: true }); } catch { /* absent */ }
    this.#path = socketPath;
    this.#server = net.createServer((socket) => this.#onConnection(socket));
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(socketPath, () => {
        try { fs.chmodSync(socketPath, 0o600); } catch { /* best effort */ }
        resolve({ path: socketPath });
      });
    });
  }

  #onConnection(socket) {
    this.#sockets.add(socket);
    const pending = new Map(); // providerCallId -> {resolve, reject, timer}
    socket.on('close', () => {
      this.#sockets.delete(socket);
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Object.assign(new Error('Adapter disconnected'), { code: 'PROVIDER_UNAVAILABLE' })); }
      pending.clear();
    });
    attachLineReader(socket, (msg) => {
      if (msg.type === 'providerResult') {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(Object.assign(new Error(msg.error?.message || 'provider failed'), { code: msg.error?.code || 'ACTION_FAILED' }));
        return;
      }
      if (msg.type === 'call') return void this.#handleCall(socket, pending, msg);
      if (msg.type === 'providerEnv') return void this.#handleProviderEnv(socket, msg);
    }, (err) => {
      try { writeLine(socket, { v: 1, type: 'protocolError', error: { message: err.message } }); } catch { /* ignore */ }
    });
  }

  // Host-built provider env (src/mcp-provider-env.js), handed only to the
  // adapter holding a live capability, only for a provider of this run.
  #handleProviderEnv(socket, msg) {
    const respond = (ok, extra) => writeLine(socket, { v: 1, type: 'result', id: msg.id, ok, ...extra });
    if (typeof msg.id !== 'string' || typeof msg.capability !== 'string' || typeof msg.providerId !== 'string') {
      return respond(false, { error: { code: 'INVALID_ARGUMENTS', message: 'Malformed providerEnv request' } });
    }
    const entry = this.#capabilities.get(msg.capability);
    if (!entry || entry.revoked) return respond(false, { error: { code: 'FORBIDDEN', message: 'Unknown or revoked capability' } });
    // No env map registered (host without a policy) → adapter keeps PATH only.
    if (!entry.providerEnvs) return respond(true, { result: { env: null } });
    const env = Object.prototype.hasOwnProperty.call(entry.providerEnvs, msg.providerId) ? entry.providerEnvs[msg.providerId] : null;
    if (!env) return respond(false, { error: { code: 'FORBIDDEN', message: 'Provider not in this run' } });
    return respond(true, { result: { env: { ...env } } });
  }

  async #handleCall(socket, pending, msg) {
    const respond = (id, ok, extra) => writeLine(socket, { v: 1, type: 'result', id, ok, ...extra });
    if (typeof msg.id !== 'string' || typeof msg.capability !== 'string' || typeof msg.action !== 'string') {
      return respond(msg.id, false, { error: { code: 'INVALID_ARGUMENTS', message: 'Malformed broker call' } });
    }
    const entry = this.#capabilities.get(msg.capability);
    if (!entry || entry.revoked) {
      return respond(msg.id, false, { error: { code: 'FORBIDDEN', message: 'Unknown or revoked capability' } });
    }

    const args = (msg.arguments && typeof msg.arguments === 'object' && !Array.isArray(msg.arguments)) ? msg.arguments : {};
    const runBinding = entry.runBinding;
    const idempotencyKey = deriveIdempotencyKey(runBinding, msg.action, args);

    // The transport bridges back to the adapter's provider child over the same
    // socket. It is the ONLY way invokeAction reaches a managed provider.
    const transport = ({ action, arguments: callArgs }) => new Promise((resolve, reject) => {
      const providerId = newId('prov');
      const timer = setTimeout(() => {
        pending.delete(providerId);
        reject(Object.assign(new Error('Provider call timed out'), { code: 'timeout' }));
      }, entry.deadlineMs);
      pending.set(providerId, { resolve, reject, timer });
      const sent = writeLine(socket, {
        v: 1, type: 'provider', id: providerId, callId: msg.id, action,
        arguments: callArgs || {}, profileId: runBinding.profileId ?? null, projectId: runBinding.projectId ?? null,
      });
      if (!sent) { clearTimeout(timer); pending.delete(providerId); reject(Object.assign(new Error('Adapter disconnected'), { code: 'PROVIDER_UNAVAILABLE' })); }
    });

    const invoker = createActionInvoker({
      registry: entry.generation.actions,
      executions: this.#executions,
      transport,
      now: this.#now,
    });

    const envelope = {
      version: 1,
      profileId: runBinding.profileId,
      projectId: runBinding.projectId ?? null,
      action: msg.action,
      arguments: args,
      trigger: runBinding.trigger,
      origin: 'mcp',
      idempotencyKey,
    };
    if (runBinding.channel) envelope.channel = runBinding.channel;

    try {
      const result = await invoker.invokeAction(envelope, { approved: entry.approved });
      return respond(msg.id, true, { result });
    } catch (err) {
      const code = err && err.code ? err.code : 'ACTION_FAILED';
      return respond(msg.id, false, { error: { code, message: String(err && err.message || err).slice(0, 500) } });
    }
  }

  async close() {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    if (!this.#server) return;
    await new Promise((resolve) => this.#server.close(resolve));
    if (this.#path) { try { fs.rmSync(this.#path, { force: true }); } catch { /* ignore */ } }
    this.#server = null;
    this.#path = null;
  }
}

// ── Adapter-side client ────────────────────────────────────────────────────

class ActionBrokerClient {
  #socket;
  #capability;
  #pending = new Map(); // callId -> {resolve, reject}
  #onProvider;
  #closed = false;

  constructor({ socket, capability, onProvider } = {}) {
    if (!socket) throw new TypeError('socket required');
    if (typeof capability !== 'string' || !capability) throw new TypeError('capability required');
    if (typeof onProvider !== 'function') throw new TypeError('onProvider required');
    this.#socket = socket;
    this.#capability = capability;
    this.#onProvider = onProvider;
    attachLineReader(socket, (msg) => this.#onMessage(msg), () => this.#failAll(new Error('Broker connection error')));
    socket.on('close', () => this.#failAll(new Error('Broker connection closed')));
  }

  static connect(socketPath, { capability, onProvider } = {}) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      const onError = (err) => { socket.removeListener('connect', onConnect); reject(err); };
      const onConnect = () => { socket.removeListener('error', onError); resolve(new ActionBrokerClient({ socket, capability, onProvider })); };
      socket.once('error', onError);
      socket.once('connect', onConnect);
    });
  }

  #onMessage(msg) {
    if (msg.type === 'result') {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(Object.assign(new Error(msg.error?.message || 'call failed'), { code: msg.error?.code || 'ACTION_FAILED' }));
      return;
    }
    if (msg.type === 'provider') {
      Promise.resolve()
        .then(() => this.#onProvider({ action: msg.action, arguments: msg.arguments, callId: msg.callId }))
        .then(
          (result) => writeLine(this.#socket, { v: 1, type: 'providerResult', id: msg.id, ok: true, result: result ?? null }),
          (err) => writeLine(this.#socket, { v: 1, type: 'providerResult', id: msg.id, ok: false,
            error: { code: (err && err.code) || 'ACTION_FAILED', message: String(err && err.message || err).slice(0, 500) } }),
        );
    }
  }

  #failAll(err) {
    if (this.#closed && this.#pending.size === 0) return;
    this.#closed = true;
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
  }

  call(action, args = {}) {
    const id = newId('call');
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const sent = writeLine(this.#socket, { v: 1, type: 'call', id, capability: this.#capability, action, arguments: args || {} });
      if (!sent) { this.#pending.delete(id); reject(Object.assign(new Error('Broker not writable'), { code: 'PROVIDER_UNAVAILABLE' })); }
    });
  }

  providerEnv(providerId) {
    const id = newId('env');
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: (r) => resolve(r?.env || null), reject });
      const sent = writeLine(this.#socket, { v: 1, type: 'providerEnv', id, capability: this.#capability, providerId });
      if (!sent) { this.#pending.delete(id); reject(Object.assign(new Error('Broker not writable'), { code: 'PROVIDER_UNAVAILABLE' })); }
    });
  }

  close() { try { this.#socket.end(); } catch { /* ignore */ } }
}

module.exports = { ActionBroker, ActionBrokerClient, deriveIdempotencyKey, DEFAULT_DEADLINE_MS };
