// The LLM judge must see what the step actually did: the agent's reply for THIS run
// (validation runs before the reply is stored as evidence) and the plan's git branch —
// including anything left uncommitted. Live e2e: without these the judge answered
// "only the step instructions were provided" for every semantic check.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const V = require('../../src/playbook-validators.js');

function planRepo(taskId) {
  const root = mkdtempSync(join(tmpdir(), 'judge-ws-'));
  const dir = join(root, 'o-sandbox', 'ws-1', 'code');
  mkdirSync(dir, { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('checkout', '-q', '-b', `eng/p-plan-${taskId.slice(0, 8)}`);
  writeFileSync(join(dir, 'README.md'), '# todo\n'); git('add', '.'); git('commit', '-qm', 'docs: scenario for todo-cli');
  writeFileSync(join(dir, 'INFRA.md'), 'not committed\n');
  return root;
}

describe('judge inputs', () => {
  it('collects the plan branch, its commits and uncommitted files', () => {
    const root = planRepo('abcdef12-0000');
    const ev = V.collectPlanWorkspaceEvidence({ profileId: 'p', taskId: 'abcdef12-0000', root });
    expect(ev).toContain('eng/p-plan-abcdef12');
    expect(ev).toContain('docs: scenario for todo-cli');
    expect(ev).toMatch(/Uncommitted[^\n]*\n\?\? INFRA\.md/);
    expect(V.collectPlanWorkspaceEvidence({ profileId: 'p', taskId: 'ffffffff-1', root })).toBeNull();
  });

  it('the judge prompt carries the agent reply, the plan git state and earlier steps', async () => {
    const seen = [];
    const llmValidate = async (ctx) => { seen.push(V.buildLlmValidatorPrompt(ctx).user); return { status: 'pass', reason: 'ok' }; };
    const item = { title: 'Сценарий пользователя', validation: { use_case_value_and_steps_written: true } };
    const res = await V.evaluateItemValidationsModeAware(item, {
      task: { id: 'abcdef12-0000', goal: 'todo-cli' }, profileId: 'p', registry: {}, mode: 'programmatic+llm',
      llmValidate, planText: 'шаг 0: репо пустое', reply: 'ИТОГ ШАГА\n- сценарий в docs/user-scenarios/todo-cli.md, коммит 3f2a9c1',
    });
    expect(res[0].status).toBe('pass');
    expect(seen[0]).toContain('Agent reply for this step:');
    expect(seen[0]).toContain('коммит 3f2a9c1');
    expect(seen[0]).toContain('Earlier steps of this plan');
    expect(seen[0]).toContain('Plan workspace (git)');
  });
});
