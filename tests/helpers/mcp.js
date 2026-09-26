// Thin re-export over @trained-assist/mcp-skill-testkit (Phase 2, issue #1440).
// Core keeps this shim so `npm run test:cjs` / `test:staging` stay green while
// domain repos consume the same harness as a package.
// Usage:
//   const mcp = await startMcp({ userId, workDir, toolsDir });
//   const { tools } = await mcp.call('tools/list');
//   await mcp.stop();

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { startMcpServer } from '../../packages/mcp-skill-testkit/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY = join(__dirname, '../../src/mcp-skills/index.js');
const FIXTURES_DIR = join(__dirname, '../fixtures');

export async function startMcp({
  userId = 'test-mcp-user',
  workDir = process.cwd(),
  toolsDir = FIXTURES_DIR,
} = {}) {
  return startMcpServer({
    entrypoint: MCP_ENTRY,
    workDir,
    env: { USER_ID: userId, TOOLS_DIR: toolsDir },
  });
}

export { startMcpServer };
