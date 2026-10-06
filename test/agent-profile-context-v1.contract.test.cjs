'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');

const ROOT = path.resolve(__dirname, '..');
const dir = path.join(ROOT, 'contracts', 'agent-profile-context-v1');
const contract = JSON.parse(fs.readFileSync(path.join(dir, 'contract.json'), 'utf8'));
const schema = JSON.parse(fs.readFileSync(path.join(dir, 'profile-context.schema.json'), 'utf8'));

test('Agent profile-context artifact is a closed, valid producer-owned v1 contract', () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const valid = { principalId: 'person_001', profileId: 'profile_001',
    sessionId: 'session_001', profileGeneration: 1 };
  assert.equal(validate(valid), true, ajv.errorsText(validate.errors));
  assert.equal(validate({ ...valid, profileId: 'profile/forged' }), false);
  assert.equal(validate({ ...valid, browserSupplied: true }), false);
  assert.equal(validate({ ...valid, profileGeneration: 0 }), false);
  assert.equal(contract.urn, 'urn:trained-assist:agent-profile-context:v1');
  assert.equal(contract.version, 1);
  assert.equal(contract.owner, 'trained-assist-agent');
  assert.equal(contract.status, 'contract_only');
  assert.equal(contract.authority.profileInputFromBrowserAllowed, false);
  assert.equal(contract.authority.legacyPerProfileJwtAllowed, false);
  assert.equal(contract.authority.browserReadableSelectionCookieAllowed, false);
  assert.equal(contract.operations.resolveBrowserSession.usesBrowserSuppliedProfileId, false);
  assert.equal(contract.operations.resolveCurrentSession.revalidatesMembershipAndSelection, true);
  assert.equal(contract.failureSemantics.authorityUnavailable, 'typed_unavailable_error');
  assert.equal(contract.failureSemantics.unavailableAllowsProtectedAction, false);
});
