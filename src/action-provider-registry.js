"use strict";

const Ajv = require('ajv');
const contract = require('../contracts/action-v1/contract.schema.json');
const clone = value => JSON.parse(JSON.stringify(value));
const error = (code, message) => Object.assign(new Error(message), { code });

// Metadata only. Execution, scoped capabilities, consent and durable history are
// owned by invokeAction; a validated descriptor is never an authorization grant.
class ActionProviderRegistry {
  #providers = new Set();
  #actions = new Map();
  #providerMeta = new Map();
  #validateV1;
  #validateV2;

  constructor() {
    const ajv = new Ajv({ strict: false, allErrors: true });
    ajv.addSchema(contract);
    // Version selects the manifest validator. v1 is unchanged; v2 adds the
    // first-class domain sections (contextFields/collections/connections/
    // webSurfaces) and is a superset that still requires the v1 actions[].
    this.#validateV1 = ajv.compile({ $ref: `${contract.$id}#/$defs/provider` });
    this.#validateV2 = ajv.compile({ $ref: `${contract.$id}#/$defs/providerV2` });
  }

  register(manifest) {
    // Snapshot metadata so a provider cannot mutate policy after registration.
    let snapshot;
    try { snapshot = clone(manifest); }
    catch { throw error('INVALID_ARGUMENTS', 'Provider manifest must be JSON'); }
    const isV2 = snapshot && snapshot.version === 2;
    const validateManifest = isV2 ? this.#validateV2 : this.#validateV1;
    if (!validateManifest(snapshot)) {
      throw error('INVALID_ARGUMENTS', `Invalid provider ${isV2 ? 'v2' : 'v1'} manifest`);
    }
    if (isV2) this.#validateV2Policy(snapshot);
    if (this.#providers.has(snapshot.providerId)) {
      throw error('CONFLICT', `Provider already registered: ${snapshot.providerId}`);
    }
    const pending = new Map();
    for (const action of snapshot.actions) {
      if (this.#actions.has(action.name) || pending.has(action.name)) {
        throw error('CONFLICT', `Duplicate action: ${action.name}`);
      }
      if ((['external_message', 'destructive'].includes(action.effect) && !action.requiresApproval) ||
          (action.effect === 'read' && action.retrySafety !== 'read_only') ||
          (action.effect !== 'read' && action.retrySafety === 'read_only')) {
        throw error('INVALID_ARGUMENTS', `Unsafe action policy: ${action.name}`);
      }
      const validateSettings = action.schedule ? compileSchedule(action) : null;
      let validate;
      try {
        // Per-action compiler prevents one provider's $id replacing another's.
        // No async/remote schema resolution and no coercion/default insertion.
        const ajv = new Ajv({ strict: false, strictSchema: true, allErrors: true });
        validate = ajv.compile(action.inputSchema);
        if (validate.$async) throw new Error('Async schemas are unsupported');
      } catch {
        throw error('INVALID_ARGUMENTS', `Invalid input schema: ${action.name}`);
      }
      pending.set(action.name, { providerId: snapshot.providerId, action, validate, validateSettings });
    }
    // Registration is atomic: a bad final action cannot leak earlier entries.
    for (const [name, entry] of pending) this.#actions.set(name, entry);
    this.#providers.add(snapshot.providerId);
    // Retain the declared v2 sections for surface/context/collection lookup
    // (the route and effective-context resolvers read these). Metadata only —
    // it grants nothing; invokeAction still authorizes every call.
    this.#providerMeta.set(snapshot.providerId, {
      version: isV2 ? 2 : 1,
      providerId: snapshot.providerId,
      contextFields: snapshot.contextFields ?? [],
      collections: snapshot.collections ?? [],
      connections: snapshot.connections ?? [],
      webSurfaces: snapshot.webSurfaces ?? [],
    });
    return this.list(snapshot.providerId);
  }

  // Cross-field rules JSON Schema cannot express (spec §6). Registration checks,
  // not authorization: invokeAction still enforces consent/resource access.
  #validateV2Policy(manifest) {
    const byName = new Map(manifest.actions.map(a => [a.name, a]));

    const collections = new Set();
    for (const c of manifest.collections ?? []) {
      if (collections.has(c.name)) throw error('INVALID_ARGUMENTS', `Duplicate collection: ${c.name}`);
      collections.add(c.name);
    }

    const fieldKeys = new Set();
    for (const f of manifest.contextFields) {
      if (fieldKeys.has(f.key)) throw error('INVALID_ARGUMENTS', `Duplicate context field: ${f.key}`);
      fieldKeys.add(f.key);
    }

    const surfaceIds = new Set();
    for (const s of manifest.webSurfaces ?? []) {
      if (surfaceIds.has(s.id)) throw error('INVALID_ARGUMENTS', `Duplicate web surface: ${s.id}`);
      surfaceIds.add(s.id);
      const target = byName.get(s.queryAction);
      if (!target) throw error('INVALID_ARGUMENTS', `Unknown query action: ${s.queryAction}`);
      if (target.effect !== 'read' || target.retrySafety !== 'read_only') {
        throw error('INVALID_ARGUMENTS', `Web surface query action must be read/read_only: ${s.queryAction}`);
      }
    }

    for (const conn of manifest.connections ?? []) {
      for (const name of conn.requiredFor) {
        if (!byName.has(name)) throw error('INVALID_ARGUMENTS', `Connection references unknown action: ${name}`);
      }
    }
  }

  list(providerId) {
    return [...this.#actions.values()]
      .filter(entry => providerId === undefined || entry.providerId === providerId)
      .map(({ providerId, action }) => ({ providerId, ...clone(action) }));
  }

  get(name) {
    const entry = this.#actions.get(name);
    if (!entry) throw error('ACTION_NOT_FOUND', 'Action is not registered');
    return { providerId: entry.providerId, ...clone(entry.action) };
  }

  // Metadata lookups return null for an unknown provider/surface so a route can
  // answer 404 without inventing error codes. v1 providers normalize to empty
  // domain sections, so callers never branch on version.
  listProviders() {
    return [...this.#providerMeta.keys()];
  }

  getProvider(providerId) {
    const meta = this.#providerMeta.get(providerId);
    return meta ? clone(meta) : null;
  }

  getSurface(providerId, surfaceId) {
    const meta = this.#providerMeta.get(providerId);
    if (!meta) return null;
    const surface = meta.webSurfaces.find(s => s.id === surfaceId);
    return surface ? clone(surface) : null;
  }

  validateCall(name, args, trigger) {
    const descriptor = this.get(name);
    if (!descriptor.allowedTriggers.includes(trigger)) {
      throw error('FORBIDDEN', 'Action does not allow this trigger');
    }
    if (!this.#actions.get(name).validate(args)) {
      // Do not include arguments or AJV error data (may contain credentials).
      throw error('INVALID_ARGUMENTS', 'Action arguments do not match the input schema');
    }
    return descriptor;
  }

  // Job arguments against the action's declared schedule settings (S3.1).
  // No declared settingsSchema → the input schema alone governs.
  validateSettings(name, args) {
    const entry = this.#actions.get(name);
    if (!entry) throw error('ACTION_NOT_FOUND', 'Action is not registered');
    return entry.validateSettings ? entry.validateSettings(args) : true;
  }
}

// Schedule declaration policy (#1489 S3.2). A provider may only declare a
// default schedule for an action it lets cron run, never for one that needs a
// per-call approval (no silent default for external messages/destructive), and
// the default must respect its own minimum interval. Returns the compiled
// settings validator (or null).
function compileSchedule(action) {
  const sch = action.schedule;
  if (!action.allowedTriggers.includes('cron')) {
    throw error('INVALID_ARGUMENTS', `Schedule declared but cron trigger not allowed: ${action.name}`);
  }
  if (sch.defaultCron !== undefined) {
    if (action.requiresApproval) {
      throw error('INVALID_ARGUMENTS', `Approval-gated action cannot declare a default schedule: ${action.name}`);
    }
    let gap;
    try { gap = require('./cron-service').minGapMinutes(sch.defaultCron); }
    catch { throw error('INVALID_ARGUMENTS', `Invalid defaultCron: ${action.name}`); }
    if (gap < sch.minIntervalMinutes) {
      throw error('INVALID_ARGUMENTS', `defaultCron runs more often than minIntervalMinutes: ${action.name}`);
    }
  }
  if (!sch.settingsSchema) return null;
  try {
    const ajv = new Ajv({ strict: false, strictSchema: true, allErrors: true });
    const validate = ajv.compile(sch.settingsSchema);
    if (validate.$async) throw new Error('Async schemas are unsupported');
    return validate;
  } catch {
    throw error('INVALID_ARGUMENTS', `Invalid settings schema: ${action.name}`);
  }
}

// Legacy MCP discovery uses the same no-shadowing boundary during migration.
// This does not infer invocation policy from legacy tool names or schemas.
function mergeToolCatalogs(...catalogs) {
  const tools = new Map();
  for (const catalog of catalogs) {
    for (const tool of catalog) {
      if (tools.has(tool.name)) throw error('CONFLICT', `Duplicate action: ${tool.name}`);
      tools.set(tool.name, tool);
    }
  }
  return [...tools.values()];
}

module.exports = { ActionProviderRegistry, mergeToolCatalogs };
