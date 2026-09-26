// ESM entry for @trained-assist/mcp-skill-testkit. Thin re-export of index.js.
import mod from './index.js';

export const {
  startMcpServer,
  fakeProvider,
  replayFixtures,
  assertManifestConforms,
  expectToolContract,
  checkDomainSkillRepo,
  reportDomainSkillRepo,
  loadFixtures,
  resultText,
  FAKE_PROVIDER_ENTRYPOINT,
  DEFAULT_TOOLS,
  DEFAULT_SCHEMA,
  REQUIRED_ARTIFACTS,
} = mod;

export default mod;
