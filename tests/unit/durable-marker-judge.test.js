// #1907 / #1908 — a reply WITHOUT the DURABLE terminal marker is not automatically
// a quality miss (audit 2026-09-30: 94% of OpenCode step failures were «no marker»,
// 66 of them escalated bachelor/master → doctor for a protocol miss).
//
// Three behaviours locked here:
//   1. engine/infra failure text returned as the reply (crash, dead ladder, auth)
//      → crash-like recovery: class from the classifier, NO quality escalation;
//   2. a real agent answer the judge calls 'done' → the step completes through the
//      SAME validated path as a marked reply (deterministic checks still gate it);
//   3. judge 'uncertain' → retry at the SAME model level, never escalate to doctor.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const MODS = ['gtd-controller', 'durable-task-store', 'durable-task-migrations', 'durable-wait',
  'data-paths', 'playbook-validators', 'playbook-executor', 'playbook-hooks',
  'durable-marker-judge', 'failure-classifier'].map(m => `../../src/${m}.js`);
const KEYS = ['USERS_DIR', 'AGENT_DATA_DIR', 'AGENT_TOKENS_DIR', 'AGENT_TOKENS_ROOT'];
const PROFILE = 'u1';

let root; const saved = {};
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), 'marker-judge-'));
  // The profile work dir IS the step's cwd for command_exit_zero — without it every
  // command check fails with ENOENT, which used to hide behind a validator name the
  // engine does not know (`command`), so the step "passed" without running anything.
  mkdirSync(join(root, 'u', PROFILE), { recursive: true });
  process.env.USERS_DIR = join(root, 'u'); process.env.AGENT_DATA_DIR = join(root, 'd');
  process.env.AGENT_TOKENS_DIR = join(root, 't'); process.env.AGENT_TOKENS_ROOT = join(root, 't');
  for (const m of MODS) { try { delete require.cache[require.resolve(m)]; } catch { /* not loaded */ } }
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(root, { recursive: true, force: true });
});

const drain = (ms = 20) => new Promise(r => setTimeout(r, ms));
const tick = (G, opts) => G.runDueDurable({
  secrets: {}, now: Date.now(), isTaskRunning: () => false, ...opts,
});

function plan(G, over = {}) {
  const store = G.durableStore();
  const r = store.createPlan({
    profile_id: PROFILE, goal: 'marker judge', user_value: 'uv',
    acceptance_criteria: [{ description: 'c' }],
    execution_policy: { validation_mode: 'programmatic', ...(over.policy || {}) },
    items: [{
      title: 'step one', execution_kind: 'agent', executor_role: 'developer',
      minimum_model_level: 'bachelor', context_budget: 'small',
      validation: { command_exit_zero: 'true' }, max_attempts: 3, ...(over.item || {}),
    }],
  });
  store.updateTask(r.task.id, PROFILE, { status: 'active' });
  return { store, task: r.task, item: r.items[0] };
}

describe('#1907 marker judge', () => {
  it("judge 'done' completes the step and evidence keeps the verdict", async () => {
    const G = require('../../src/gtd-controller.js');
    const { store, task, item } = plan(G);
    await tick(G, {
      runTask: async () => 'ИТОГ ШАГА: сделал, PR #12 открыт\nбез маркера в конце',
      markerJudge: async () => ({ verdict: 'done', reason: 'итог и PR на месте' }),
    });
    await drain();
    const after = store.getTaskItem(item.id);
    expect(after.status).toBe('done');
    const ev = JSON.parse(after.evidence_json);
    expect(ev.marker_judge).toEqual({ verdict: 'done', reason: 'итог и PR на месте' });
    expect(store.getTask(task.id, PROFILE).status).toBe('done');
  });

  it("judge 'done' does NOT close a step whose declared checks are all inconclusive", async () => {
    // The guard that keeps a free-rung model from closing a step on its word alone:
    // an item that DECLARED checks must have at least one of them pass. A step
    // carrying invented validator names (601 of them in the live plans) resolves
    // every check to `inconclusive` — so it fails loudly into normal recovery
    // instead of being silently marked done.
    const G = require('../../src/gtd-controller.js');
    const { store, item } = plan(G, { item: { validation: { coverage_table_committed: '' } } });
    await tick(G, {
      runTask: async () => 'ИТОГ ШАГА: сделал, всё хорошо\nбез маркера в конце',
      markerJudge: async () => ({ verdict: 'done', reason: 'модель решила, что сделано' }),
    });
    await drain();
    const after = store.getTaskItem(item.id);
    expect(after.status).not.toBe('done');
    expect(String(after.last_error || '')).toContain('marker-judge:no-passing-check');
  });

  it("judge 'done' does NOT bypass a failing deterministic check (#1861 gate)", async () => {
    const G = require('../../src/gtd-controller.js');
    const { store, item } = plan(G, { item: { validation: { command_exit_zero: 'exit 1' } } });
    await tick(G, {
      runTask: async () => 'всё готово, честно\nИТОГ ШАГА: done-ish',
      markerJudge: async () => ({ verdict: 'done', reason: 'прозвучало готово' }),
    });
    await drain();
    const after = store.getTaskItem(item.id);
    expect(after.status).not.toBe('done');
    expect(String(after.last_error)).toMatch(/command_exit_zero|validation/i);
  });

  it("judge 'uncertain' retries at the SAME level and never escalates (no doctor burn)", async () => {
    const G = require('../../src/gtd-controller.js');
    const { store, item } = plan(G);
    for (let attempt = 1; attempt <= 3; attempt++) {
      await tick(G, {
        runTask: async () => `короткий ответ без деталей, попытка ${attempt}`,
        markerJudge: async () => ({ verdict: 'uncertain', reason: 'too-short' }),
      });
      await drain();
      const after = store.getTaskItem(item.id);
      expect(after.current_model_level).toBe('bachelor'); // никогда не ушёл в doctor
      if (attempt < 3) {
        expect(after.status).toBe('pending');
        expect(after.last_recovery_action).toBe('retry_same_with_reasons');
      }
    }
    expect(store.getTaskItem(item.id).status).toBe('failed'); // bounded, не вечный ретрай
  });

  it("judge 'failed' keeps the quality ladder (attempt 3 escalates)", async () => {
    const G = require('../../src/gtd-controller.js');
    // A level map where master IS distinct from bachelor: nextDistinctLevel only
    // escalates when the profile actually changes (default map bachelor=master=deepseek).
    process.env.PLAYBOOK_LEVEL_MAP = JSON.stringify({
      bachelor: { engine: 'opencode', ocProfile: 'free' },
      master: { engine: 'opencode', ocProfile: 'service' },
      doctor: { engine: 'claude', ocProfile: null },
    });
    try {
      const { store, item } = plan(G);
      for (let attempt = 1; attempt <= 2; attempt++) {
        await tick(G, {
          runTask: async () => `не сделал работу, попытка ${attempt}`,
          markerJudge: async () => ({ verdict: 'failed', reason: 'работа не сделана' }),
        });
        await drain();
      }
      const after = store.getTaskItem(item.id);
      expect(after.status).toBe('pending');
      expect(after.current_model_level).toBe('master'); // эскалация только за реальный fail
    } finally {
      delete process.env.PLAYBOOK_LEVEL_MAP;
    }
  });

  it('no judge call happens when the marker IS present', async () => {
    const G = require('../../src/gtd-controller.js');
    const { store, item } = plan(G);
    let judgeCalls = 0;
    await tick(G, {
      runTask: async () => 'ok\nDURABLE: done',
      markerJudge: async () => { judgeCalls += 1; return { verdict: 'failed', reason: 'не должен быть вызван' }; },
    });
    await drain();
    expect(store.getTaskItem(item.id).status).toBe('done');
    expect(judgeCalls).toBe(0);
  });
});

describe('#1908 engine failure returned as the reply', () => {
  const CASES = [
    ['crash', '⚠️ Процесс завершился с ошибкой (код 1). Попробуй ещё раз.'],
    ['dead ladder', '⛔ Вся лестница моделей «deepseek» временно недоступна (все ступени отказали в llm-ladder) — попробуй позже.'],
    ['auth', 'Not logged in · Please run /login'],
    ['russian auth', '⚠️ Авторизация OpenCode истекла — оператор уже уведомлён, скоро починим.'],
  ];
  for (const [name, reply] of CASES) {
    it(`${name}: classified by the classifier, no quality escalation, no level bump`, async () => {
      const G = require('../../src/gtd-controller.js');
      const { store, item } = plan(G);
      let judgeCalls = 0;
      await tick(G, {
        runTask: async () => reply,
        markerJudge: async () => { judgeCalls += 1; return { verdict: 'uncertain', reason: 'should-not-run' }; },
      });
      await drain();
      const after = store.getTaskItem(item.id);
      expect(judgeCalls).toBe(0); // детерминированный путь, судья не зовётся
      expect(after.status).toBe('pending'); // retry, не terminal после первой попытки
      expect(after.current_model_level).toBe('bachelor'); // НЕ quality-эскалация в doctor
      expect(after.last_recovery_action).not.toMatch(/^escalate:/);
      expect(['AUTH', 'CONFIG', 'TRANSIENT', 'QUOTA', 'CONTEXT']).toContain(after.last_failure_class);
    });
  }
});

describe('#1911 step timeout → TIMEOUT class, no quality escalation', () => {
  it('timeout text: retries at the same level with the policy backoff, never escalates', async () => {
    const G = require('../../src/gtd-controller.js');
    const { store, item } = plan(G);
    await tick(G, {
      runTask: async () => '⏱ Шаг не уложился в бюджет: 600с. Частичный результат сохранён в истории сессии — повтори с меньшим объёмом.',
    });
    await drain();
    const after = store.getTaskItem(item.id);
    expect(after.status).toBe('pending');
    expect(after.last_failure_class).toBe('TIMEOUT'); // не UNKNOWN → не quality-путь
    expect(after.current_model_level).toBe('bachelor'); // без эскалации в doctor
    expect(after.last_recovery_action).toBe('backoff_retry_same');
    expect(after.due_at).toBeGreaterThan(Date.now()); // бэкофф реально применён
  });
});

describe('durable-marker-judge unit', () => {
  it('judgeMarkerlessReply: empty and too-short replies never reach the LLM', async () => {
    const { judgeMarkerlessReply } = require('../../src/durable-marker-judge.js');
    const boom = { available: () => true, serviceJson: async () => { throw new Error('must not be called'); } };
    expect((await judgeMarkerlessReply({ said: '   ', item: {}, task: {}, serviceLlm: boom })).reason).toBe('empty-reply');
    expect((await judgeMarkerlessReply({ said: 'ok', item: {}, task: {}, serviceLlm: boom })).reason).toBe('too-short');
  });

  it('judgeMarkerlessReply: no provider → uncertain without a call', async () => {
    const { judgeMarkerlessReply } = require('../../src/durable-marker-judge.js');
    const r = await judgeMarkerlessReply({
      said: 'ИТОГ ШАГА: всё сделано, подробности ниже…'.padEnd(300, '.'),
      item: {}, task: {}, serviceLlm: { available: () => false, serviceJson: async () => { throw new Error('no'); } },
    });
    expect(r).toEqual({ verdict: 'uncertain', reason: 'no-llm-provider' });
  });

  it('judgeMarkerlessReply: normalizes the LLM JSON and bad verdicts → uncertain', async () => {
    const { judgeMarkerlessReply } = require('../../src/durable-marker-judge.js');
    const said = 'ИТОГ ШАГА: '.padEnd(300, 'x');
    const good = await judgeMarkerlessReply({
      said, item: {}, task: {},
      serviceLlm: { available: () => true, serviceJson: async () => ({ verdict: 'done', reason: 'ок' }) },
    });
    expect(good).toEqual({ verdict: 'done', reason: 'ок' });
    const bad = await judgeMarkerlessReply({
      said, item: {}, task: {},
      serviceLlm: { available: () => true, serviceJson: async () => ({ verdict: 'yes' }) },
    });
    expect(bad.verdict).toBe('uncertain');
  });

  it('looksLikeEngineFailure: runner failures match, agent prose does not', () => {
    const { looksLikeEngineFailure } = require('../../src/durable-marker-judge.js');
    expect(looksLikeEngineFailure('⚠️ Процесс завершился с ошибкой (код 1). Попробуй ещё раз.')).toBe(true);
    expect(looksLikeEngineFailure('⛔ Сервис моделей llm-ladder недоступен (лестница «deepseek») — задача не выполнена, попробуй позже.')).toBe(true);
    expect(looksLikeEngineFailure('⚠️ Работа прервана (код 1). Завершение задачи не подтверждено.')).toBe(true);
    // агентская проза про ошибку — это контент, её судит судья, а не инфра-путь
    expect(looksLikeEngineFailure('Тесты упали из-за того, что CI не запустился, чиню.')).toBe(false);
    // ответ с ИТОГ ШАГА — это работа агента, даже если цитирует сбой движка
    expect(looksLikeEngineFailure('ИТОГ ШАГА: сделал всё, но процесс завершился с ошибкой в конце')).toBe(false);
  });
});

describe('#1910 execution attribution', () => {
  it('startExecution records attempt_number; patchExecution adds model+usage without touching status', async () => {
    const G = require('../../src/gtd-controller.js');
    const { store, task, item } = plan(G);
    const executionId = 'exec-attr-1';
    store.startExecution({
      id: executionId, task_id: task.id, task_item_id: item.id,
      engine: 'opencode', profile: 'service', model_level: 'bachelor', executor_role: 'developer',
    });
    let row = store.getExecution(executionId);
    expect(row.attempt_number).toBe(1); // не NULL — аудит: колонка была пустой во всех 622 строках
    expect(row.status).toBe('running');

    store.patchExecution(executionId, {
      model: 'opencode-go/deepseek-v4-flash-0731',
      result_json: JSON.stringify({ usage: { input: 100, output: 20, cache_read: 5000, cache_write: 300 }, at: 1 }),
    });
    row = store.getExecution(executionId);
    expect(row.model).toBe('opencode-go/deepseek-v4-flash-0731');
    expect(JSON.parse(row.result_json).usage.cache_read).toBe(5000);
    expect(row.status).toBe('running'); // status остаётся за settle-путём

    store.finishExecution(executionId, { status: 'success' });
    row = store.getExecution(executionId);
    expect(row.status).toBe('success');
    expect(row.model).toBe('opencode-go/deepseek-v4-flash-0731'); // не затёрто
    expect(row.attempt_number).toBe(1);
  });

  it('second attempt records attempt_number = 2', async () => {
    const G = require('../../src/gtd-controller.js');
    const { store, task, item } = plan(G);
    for (const n of [1, 2]) {
      const id = `exec-attr-${n}`;
      store.startExecution({ id, task_id: task.id, task_item_id: item.id, engine: 'opencode' });
      store.finishExecution(id, { status: 'failed' });
      expect(store.getExecution(id).attempt_number).toBe(n);
    }
  });
});
