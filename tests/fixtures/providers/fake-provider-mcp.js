#!/usr/bin/env node
'use strict';
// Thin re-export of the canonical fake provider in
// @trained-assist/mcp-skill-testkit (Phase 2, issue #1440). Running this file
// executes the bundled provider script with the same argv/flags.
require('../../../packages/mcp-skill-testkit/fake-provider-mcp.js');
