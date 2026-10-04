// #120 — fast path «спецификация уже одобрена» (compile half) + #121's step-selection
// criterion. Case 9a6854e4: an approved architecture sat in the goal while the run
// re-derived scenario/context/requirements/design for 26 minutes and 6 model runs.
//
// With `spec_ref` the framing stages collapse into ONE cheap verification step and only
// genuine gaps are re-opened. Delivery gates are never compressed — that is the whole
// contract of this path.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const require = createRequire(import.meta.url);

function freshEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'spec-ref-'));
  process.env.AGENT_DATA_DIR = dir;
  process.env.USERS_DIR = join(dir, 'users');
  for (const m of ['../../src/playbook-store.js', '../../src/playbook-compiler.js', '../../src/durable-task-plan.js']) {
    delete require.cache[require.resolve(m)];
  }
  const { PlaybookStore } = require('../../src/playbook-store.js');
  const { compilePlaybook } = require('../../src/playbook-compiler.js');
  return { PlaybookStore, compilePlaybook };
}

const get = (env, id) => new env.PlaybookStore({ profileId: 'e2e' }).get(id);

describe('#120 fast path: approved spec replaces the framing stages', () => {
  it('feature: the frame collapses into one cheap check, delivery gates untouched', () => {
    const env = freshEnv();
    const pb = get(env, 'feature');
    const plain = env.compilePlaybook(pb, { goal: 'g', vars: { repo: 'acme/x' } });
    const fast = env.compilePlaybook(pb, { goal: 'g', vars: { repo: 'acme/x' }, spec_ref: 'trained-assist/agent#2061' });

    expect(plain.items.length).toBeGreaterThan(fast.items.length);
    expect(fast.items[0].title).toBe('Сверка одобренной спецификации');
    expect(fast.items[0].minimum_model_level).toBe('bachelor');
    expect(fast.items[0].context_budget).toBe('small');
    expect(fast.items[0].execution_timeout_seconds).toBeLessThanOrEqual(300);
    expect(Object.keys(fast.items[0].validation).length).toBeGreaterThan(0);

    // The whole point: CI / merge / deploy / verify-real / archive survive untouched.
    for (const gate of ['Открыть PR', 'CI зелёный', 'PR смержен', 'Деплой прошёл и живой', 'Проверка сценария', 'Архивация']) {
      expect(fast.items.some(i => i.title.includes(gate)), `gate kept: ${gate}`).toBe(true);
    }
    const fastTitles = fast.items.map(i => i.title);
    const plainDeliver = plain.items.filter(i => ['apply', 'deliver', 'archive'].includes(i.stage)).map(i => i.title);
    for (const t of plainDeliver) expect(fastTitles).toContain(t);
  });

  it('the check step names the spec and the framing checklist it must cover', () => {
    const env = freshEnv();
    const fast = env.compilePlaybook(get(env, 'feature'), { goal: 'g', vars: { repo: 'acme/x' }, spec_ref: 'docs/spec.md' });
    const text = fast.items[0].instructions;
    expect(text).toContain('docs/spec.md');
    for (const item of ['ценность', 'контекст', 'требования', 'дизайн', 'план проверки']) {
      expect(text.toLowerCase()).toContain(item);
    }
    expect(text).toContain('task_item_add'); // gaps are opened, not re-derived
  });

  it('a raw goal compiles exactly as before — no regression', () => {
    const env = freshEnv();
    const pb = get(env, 'feature');
    const a = env.compilePlaybook(pb, { goal: 'g', vars: { repo: 'acme/x' } });
    const b = env.compilePlaybook(pb, { goal: 'g', vars: { repo: 'acme/x' } });
    expect(JSON.stringify(b.items)).toBe(JSON.stringify(a.items));
    expect(a.items[0].title).not.toBe('Сверка одобренной спецификации');
  });

  it('a playbook without framing stages gets no extra step (ci-run)', () => {
    const env = freshEnv();
    const pb = get(env, 'ci-run');
    const plain = env.compilePlaybook(pb, { goal: 'g', vars: { repo: 'acme/x' } });
    const fast = env.compilePlaybook(pb, { goal: 'g', vars: { repo: 'acme/x' }, spec_ref: 'docs/spec.md' });
    expect(fast.items.length).toBe(plain.items.length);
    expect(fast.items.some(i => i.title === 'Сверка одобренной спецификации')).toBe(false);
  });

  it('new-software collapses its design stage too, and the spec-check step passes the item contract', () => {
    const env = freshEnv();
    const pb = get(env, 'new-software');
    const plain = env.compilePlaybook(pb, { goal: 'g', vars: { repo: 'acme/x' } });
    const fast = env.compilePlaybook(pb, { goal: 'g', vars: { repo: 'acme/x' }, spec_ref: 'acme/spec.md' });
    expect(fast.items.length).toBeLessThan(plain.items.length);
    const { validateItem } = require('../../src/durable-task-plan.js');
    expect(() => validateItem(fast.items[0])).not.toThrow();
  });

  it('the compiled fast-path plan is accepted by the durable store (contract holds)', () => {
    const env = freshEnv();
    const { DurableTaskStore } = require('../../src/durable-task-store.js');
    const pb = get(env, 'feature');
    const compiled = env.compilePlaybook(pb, { goal: 'g', vars: { repo: 'acme/x' }, spec_ref: 'acme/spec.md' });
    const store = new DurableTaskStore(':memory:');
    const r = store.createPlan({
      profile_id: 'e2e', goal: compiled.goal, user_value: compiled.user_value,
      acceptance_criteria: compiled.acceptance_criteria, items: compiled.items,
      playbook_id: pb.id, playbook_version: pb.version,
    });
    expect(r.items.length).toBe(compiled.items.length);
    expect(r.items[0].title).toBe('Сверка одобренной спецификации');
  });
});
