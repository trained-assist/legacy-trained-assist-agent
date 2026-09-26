// Deterministic scenario gate. No cloud deploy or production credentials.
// Same model as trained-assist-agent scripts/staging/run.mjs, but the isolation
// guard comes from @trained-assist/mcp-skill-testkit (no vendoring).
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const suites = JSON.parse(readFileSync(new URL('./suites.json', import.meta.url)));
const root = resolve('.');
const output = resolve('staging-results');
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), 'domain-staging-'));
const guard = require.resolve('@trained-assist/mcp-skill-testkit/isolation-guard');
const blockedLog = join(temporary, 'outbound-blocked.log');
const env = {
  PATH: process.env.PATH, CI: 'true', NODE_ENV: 'test',
  STAGING_ROOT: temporary, STAGING_ISOLATION: '1', STAGING_RUNNER_PID: String(process.pid), STAGING_BLOCKED_LOG: blockedLog,
  NODE_OPTIONS: `--require=${guard}`,
  HOME: join(temporary, 'home'),
  TMPDIR: join(temporary, 'tmp'),
  USERS_DIR: join(temporary, 'home', 'users'),
  AGENT_DATA_DIR: join(temporary, 'data'),
  AGENT_TOKENS_ROOT: join(temporary, 'tokens'),
};
for (const dir of [env.HOME, env.TMPDIR, env.USERS_DIR, env.AGENT_DATA_DIR, env.AGENT_TOKENS_ROOT]) mkdirSync(dir, { recursive: true });

const sourceFiles = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean))].sort();
const sourceHash = createHash('sha256');
for (const file of sourceFiles) {
  const bytes = existsSync(file) ? readFileSync(file) : Buffer.from('[deleted]');
  sourceHash.update(JSON.stringify([file, bytes.length]));
  sourceHash.update(bytes);
}
const manifest = {
  schema: 2, sourceSha256: sourceHash.digest('hex'),
  dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
  node: process.version, kind: 'deterministic-replay',
  sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  repository: process.env.GITHUB_REPOSITORY || null,
  run: process.env.GITHUB_RUN_ID || null,
  suites, startedAt: new Date().toISOString(), result: 'failure',
};
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit', timeout: 300_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Scenario command failed (${result.status}): ${args.join(' ')}`);
}
try {
  // The guard itself must refuse a non-isolated setup, or the gate proves nothing.
  const probe = spawnSync(process.execPath, ['-e', '0'], { env: { ...env, HOME: process.env.HOME || '/' }, encoding: 'utf8' });
  if (probe.status === 0) throw new Error('isolation guard did not reject a HOME outside STAGING_ROOT');

  const nodeSuites = suites.node || [];
  const vitestSuites = suites.vitest || [];
  if (!nodeSuites.length && !vitestSuites.length) throw new Error('No mandatory scenarios configured');
  for (const file of [...vitestSuites, ...nodeSuites]) if (!existsSync(file)) throw new Error(`Required scenario suite missing: ${file}`);
  for (const file of nodeSuites) run(['--test', file]);
  if (vitestSuites.length) run(['node_modules/vitest/vitest.mjs', 'run', ...vitestSuites]);
  manifest.result = 'success';
} catch (error) {
  manifest.error = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  manifest.isolation = { guard: '@trained-assist/mcp-skill-testkit/isolation-guard', roots: ['HOME', 'TMPDIR', 'USERS_DIR', 'AGENT_DATA_DIR', 'AGENT_TOKENS_ROOT'] };
  manifest.outboundBlocked = existsSync(blockedLog) ? readFileSync(blockedLog, 'utf8').split('\n').filter(Boolean) : [];
  manifest.finishedAt = new Date().toISOString();
  writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  rmSync(temporary, { recursive: true, force: true });
}
