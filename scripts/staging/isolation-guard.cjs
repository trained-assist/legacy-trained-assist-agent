'use strict';
// Thin re-export of the canonical guard in @trained-assist/mcp-skill-testkit
// (Phase 2, issue #1440). Kept at this path so scripts/staging/run.mjs and
// test/staging-isolation-guard.test.cjs keep working unchanged.
module.exports = require('../../packages/mcp-skill-testkit/isolation-guard.cjs');
