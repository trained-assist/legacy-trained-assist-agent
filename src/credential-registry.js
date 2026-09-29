'use strict';
// Credential consumers registry (#1891, epic #1885): who reads which credential
// and from where — env names and relative file paths only, never values.
// Schema: contracts/credentials.schema.json. Readers: the CI contract
// (scripts/check-credential-reachability.js) and the profile-migrate phase
// credentials-reachability. Nothing on the runtime path reads this file.
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

const ROOT = path.join(__dirname, '..');
const DEFAULT_FILE = path.join(ROOT, 'config', 'credentials.json');
const SCHEMA_FILE = path.join(ROOT, 'contracts', 'credentials.schema.json');

let compiled = null;
function schemaValidator() {
  if (!compiled) {
    const ajv = new Ajv({ strict: false, allErrors: true });
    compiled = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8')));
  }
  return compiled;
}

// Throws on anything the schema rejects plus the cross-field rules a JSON schema
// cannot say cleanly. Returns the object for chaining.
function validate(obj, where = 'credentials registry') {
  const v = schemaValidator();
  if (!v(obj)) {
    const msg = v.errors.map(e => `${e.instancePath || '/'} ${e.message}`).join('; ');
    throw new Error(`${where}: ${msg}`);
  }
  const seen = new Set();
  obj.credentials.forEach((c, i) => {
    const at = `${where}: credentials[${i}] (${c.consumer})`;
    if (seen.has(c.consumer)) throw new Error(`${at}: duplicate consumer`);
    seen.add(c.consumer);
    const env = c.env || [];
    const files = c.files || [];
    if (env.length && !c.host) throw new Error(`${at}: ${env.join(", ")} declared without "host" (mcp | bridge) — nothing is bound to provide it`);
    if ((c.aliases || []).length && env.length !== 1) throw new Error(`${at}: aliases are for a single canonical env name`);
    if (c.scope === 'platform' && files.length) throw new Error(`${at}: platform credentials have no files (use scope "profile")`);
    if (c.scope === 'profile' && !files.length) throw new Error(`${at}: profile credentials need files[]`);
    if (!env.length && !files.length) throw new Error(`${at}: declares neither env nor files`);
  });
  return obj;
}

function load(file = DEFAULT_FILE) {
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`credentials registry ${file}: ${e.message}`);
  }
  return validate(obj, `credentials registry ${path.basename(file)}`);
}

// Every env name the host must provide, with the layer that must provide it.
function declaredEnv(reg) {
  const out = [];
  for (const c of reg.credentials) for (const name of c.env || []) out.push({ consumer: c.consumer, name, host: c.host });
  return out;
}

module.exports = { load, validate, declaredEnv, DEFAULT_FILE, SCHEMA_FILE };
