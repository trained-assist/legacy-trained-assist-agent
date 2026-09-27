// Set roots before any real module is imported. Test fixtures must never observe
// the live maintenance gate or leave fake requests in production's pending queue.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'agent-vitest-'));
for (const [key, child] of Object.entries({ AGENT_DATA_DIR: 'data', USERS_DIR: 'users', AGENT_TOKENS_DIR: 'tokens' })) {
  const directory = join(root, child);
  mkdirSync(directory, { recursive: true });
  process.env[key] = directory;
}
process.once('exit', () => rmSync(root, { recursive: true, force: true }));
// Runner fixtures fake the `claude` binary; production's default engine is opencode (2026-09-27).
if (!process.env.AGENT_DEFAULT_ENGINE) process.env.AGENT_DEFAULT_ENGINE = 'claude';
