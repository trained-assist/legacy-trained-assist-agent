'use strict';

// @trained-assist/mcp-skill-testkit — reusable harness for testing domain-skill
// MCP servers. One implementation, consumed natively (core) or as a
// devDependency (trained-assist-<domain>-skill repos). See README.md.

const { startMcpServer } = require('./lib/start-mcp-server');
const { fakeProvider, FAKE_PROVIDER_ENTRYPOINT, DEFAULT_TOOLS } = require('./lib/fake-provider');
const { replayFixtures, loadFixtures } = require('./lib/replay-fixtures');
const { assertManifestConforms, DEFAULT_SCHEMA } = require('./lib/manifest');
const { expectToolContract, resultText } = require('./lib/tool-contract');
const { checkDomainSkillRepo, reportDomainSkillRepo, REQUIRED_ARTIFACTS } = require('./lib/conformance');

module.exports = {
  startMcpServer,
  fakeProvider,
  replayFixtures,
  assertManifestConforms,
  expectToolContract,
  checkDomainSkillRepo,
  reportDomainSkillRepo,
  // extras used by core / advanced consumers
  loadFixtures,
  resultText,
  FAKE_PROVIDER_ENTRYPOINT,
  DEFAULT_TOOLS,
  DEFAULT_SCHEMA,
  REQUIRED_ARTIFACTS,
};
