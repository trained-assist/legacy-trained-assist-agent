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
// Same for OpenCode's ladder log — see scripts/run-cjs-tests.js for the 2026-09-27 incident this
// prevents.
process.env.LADDER_LOG_DIR = join(root, 'ladder-log');
// Post-run sweep (#1916 PR-D): a settled run arms a sweep, and every runner test settles one.
// Without a fake bucket it would build a REAL GCS client (ADC on a dev box → the production
// bucket) and, once an upload succeeded, unlink the fixture the next assertion reads. Point it
// at a temp bucket and defer it past the life of the process; a test that WANTS the sweep
// overrides both values in-file (in-process assignment wins).
process.env.GCS_FAKE_DIR = join(root, 'gcs');
process.env.POST_RUN_SWEEP_DELAY_MS = '3600000';
// Provider keys from the developer's shell must not leak into tests (CI has none) — a test that
// needs one sets it explicitly.
for (const key of ['OPENROUTER_API_KEY', 'OPENCODE_GO_API_KEYS', 'OPENCODE_GO_API_KEY', 'LLM_LADDER_TOKEN']) delete process.env[key];
// The credential-store master key must never come from the developer's shell: tests
// assert on plaintext fixtures (and one asserts the plaintext fallback explicitly).
// A test that needs encryption sets CRED_ENCRYPTION_KEY itself.
delete process.env.CRED_ENCRYPTION_KEY;
// Never call the live llm-ladder worker from tests: unroutable host + dummy token (mocked fetch
// sees the worker's OpenAI-shaped protocol; anything unmocked fails soft).
process.env.LLM_LADDER_URL = 'http://llm-ladder.invalid';
process.env.LLM_LADDER_TOKEN = 'test-ladder-token';
process.once('exit', () => rmSync(root, { recursive: true, force: true }));
// Runner fixtures fake the `claude` binary; production's default engine is opencode (2026-09-27).
if (!process.env.AGENT_DEFAULT_ENGINE) process.env.AGENT_DEFAULT_ENGINE = 'claude';
// The runner's RAM watchdog waits up to 60s when os.freemem() < 512MB — on macOS (page
// cache not counted as free) that made runner tests hang/time out locally but not in CI.
if (process.env.MIN_FREE_RAM_MB === undefined) process.env.MIN_FREE_RAM_MB = '0';
