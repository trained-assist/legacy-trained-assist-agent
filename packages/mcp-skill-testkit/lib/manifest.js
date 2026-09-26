'use strict';

// L1 building block: validate a source manifest against the core-owned contract
// schema (contracts/mcp-skill-sources.schema.json). A copy ships with the kit so
// a domain repo needs no core checkout; pass an explicit schemaPath to pin the
// core revision you are targeting.

const fs = require('fs');
const { join } = require('path');

const DEFAULT_SCHEMA = join(__dirname, '..', 'schema', 'mcp-skill-sources.schema.json');

function loadAjv() {
  const mod = require('ajv');
  return mod && mod.default ? mod.default : mod;
}

function assertManifestConforms(manifestPath, schemaPath = DEFAULT_SCHEMA) {
  if (!manifestPath) throw new Error('assertManifestConforms: `manifestPath` is required');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

  const Ajv = loadAjv();
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  if (!validate(manifest)) {
    const detail = (validate.errors || [])
      .map((e) => `${e.instancePath || '/'} ${e.message}`)
      .join('; ');
    const err = new Error(`manifest does not conform to ${schemaPath}: ${detail}`);
    err.errors = validate.errors;
    err.code = 'MANIFEST_NONCONFORMANT';
    throw err;
  }
  return { ok: true, manifest };
}

module.exports = { assertManifestConforms, DEFAULT_SCHEMA };
