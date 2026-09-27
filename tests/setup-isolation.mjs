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
// Same for OpenCode's live state (key pool, model health — the ladder log lives next to it) — see
// scripts/run-cjs-tests.js for the 2026-09-27 incident this prevents.
for (const [key, file] of Object.entries({
  OPENCODE_GO_KEYS_STATE_FILE: 'go-keys-state.json',
  OPENCODE_GO_AUTH_FILE: 'auth.json', OPENCODE_MODEL_HEALTH_FILE: 'model-health.json',
})) process.env[key] = join(root, file);
// Provider keys from the developer's shell must not leak into tests (CI has none) — a test that
// needs one sets it explicitly.
for (const key of ['OPENROUTER_API_KEY', 'OPENCODE_GO_API_KEYS', 'OPENCODE_GO_API_KEY', 'LLM_LADDER_TOKEN']) delete process.env[key];
process.env.LLM_LADDER_DISABLED = '1'; // never call the live llm-ladder worker from tests
process.once('exit', () => rmSync(root, { recursive: true, force: true }));
// Runner fixtures fake the `claude` binary; production's default engine is opencode (2026-09-27).
if (!process.env.AGENT_DEFAULT_ENGINE) process.env.AGENT_DEFAULT_ENGINE = 'claude';
