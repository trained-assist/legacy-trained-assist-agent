'use strict';
// Regression / degradation guards for #1234 Sub-2: native Claude resume.
// A future refactor of buildEngineCommand must not silently drop `--resume` — the failure is
// invisible (resume quietly degrades to a lossy context rebuild, the exact #1234 symptom).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildEngineCommand } = require('../src/runner/claude-runner');

const base = {
  engine: 'claude', prompt: 'continue please',
  systemPromptText: null, ocSystemPrompt: null, opencodeModel: null,
  mcpConfig: '/tmp/mcp.json', systemPromptFile: null, user: { cwd: '/tmp' },
};

test('claude: --resume <id> is passed when a native session id is present', () => {
  const [bin, args] = buildEngineCommand({ ...base, resumeSessionId: 'sid-abc-123' });
  assert.equal(bin, process.env.CLAUDE_BIN || 'claude');
  const i = args.indexOf('--resume');
  assert.notEqual(i, -1, '--resume present');
  assert.equal(args[i + 1], 'sid-abc-123', '--resume takes the id');
  assert.equal(args[args.length - 1], 'continue please', 'prompt stays last');
  // stream-json/mcp-config must survive alongside resume (we are resuming, not reconfiguring away).
  assert.ok(args.includes('stream-json'));
  assert.ok(args.includes('--mcp-config'));
});

test('degradation guard: no resumeSessionId → no --resume (fresh session as before)', () => {
  for (const v of [undefined, null, '']) {
    const [, args] = buildEngineCommand({ ...base, resumeSessionId: v });
    assert.equal(args.includes('--resume'), false, `--resume must be absent for ${JSON.stringify(v)}`);
  }
});

test('codex: `exec resume <id>` on the resume path; -C only on the fresh path', () => {
  const [, resumeArgs] = buildEngineCommand({ ...base, engine: 'codex', resumeSessionId: 'thr-1' });
  assert.equal(resumeArgs[0], 'exec');
  assert.equal(resumeArgs[1], 'resume', 'codex resumes via the `resume` subcommand');
  assert.equal(resumeArgs[2], 'thr-1');
  assert.equal(resumeArgs.includes('--resume'), false, 'claude --resume must not leak into codex');
  assert.equal(resumeArgs.includes('-C'), false, '`codex exec resume` rejects -C (uses the process cwd)');
  assert.ok(resumeArgs.includes('--json'), 'json stream preserved on resume');
  assert.ok(resumeArgs.some(a => a.startsWith('tool_output_token_limit=')), 'tool-output cap preserved');
  assert.equal(resumeArgs[resumeArgs.length - 1], 'continue please', 'prompt stays last');

  const [, freshArgs] = buildEngineCommand({ ...base, engine: 'codex', resumeSessionId: null });
  assert.equal(freshArgs[1], '--json', 'fresh path is a plain `exec`');
  assert.notEqual(freshArgs.indexOf('-C'), -1, 'fresh path keeps -C');
});

test('opencode: `run --session <id>` on the resume path, none on a fresh run', () => {
  const [, ocArgs] = buildEngineCommand({ ...base, engine: 'opencode', resumeSessionId: 'ses-1' });
  assert.equal(ocArgs[0], 'run');
  const i = ocArgs.indexOf('--session');
  assert.notEqual(i, -1, 'opencode resumes via --session');
  assert.equal(ocArgs[i + 1], 'ses-1');
  assert.ok(ocArgs.includes('--format') && ocArgs.includes('json'), 'json stream preserved');
  assert.equal(ocArgs[ocArgs.length - 1], 'continue please', 'prompt stays last');

  const [, freshArgs] = buildEngineCommand({ ...base, engine: 'opencode', resumeSessionId: null });
  assert.equal(freshArgs.includes('--session'), false, 'no --session on a fresh run');
});

test('opencode: only a primary ocRole reaches `--agent`; subagent roles never do (#1725 root 3)', () => {
  // explore/review/general are OpenCode subagents: `run --agent` ignores them today and
  // native explore denies every MCP tool — passing them is a latent «step without tools».
  for (const role of ['explore', 'review', 'general']) {
    const [, args] = buildEngineCommand({ ...base, engine: 'opencode', ocRole: role });
    assert.equal(args.includes('--agent'), false, `subagent role ${role} must not be pinned`);
  }
  const [, withRole] = buildEngineCommand({ ...base, engine: 'opencode', ocRole: 'build' });
  const i = withRole.indexOf('--agent');
  assert.notEqual(i, -1, '--agent present for a primary role');
  assert.equal(withRole[i + 1], 'build');

  const [, noRole] = buildEngineCommand({ ...base, engine: 'opencode' });
  assert.equal(noRole.includes('--agent'), false, 'non-contract callers keep the historical argv');

  // The oc role must never leak into a claude/codex argv.
  const [, claudeArgs] = buildEngineCommand({ ...base, engine: 'claude', ocRole: 'build' });
  assert.equal(claudeArgs.includes('--agent'), false, 'claude argv never gets --agent');
});
