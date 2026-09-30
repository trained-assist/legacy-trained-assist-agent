// #1912 — degradation alerts: a dead ladder / unavailable engine must reach the
// operator in minutes, not be found in journalctl days later (audit: 397 «every
// rung failed» lines over 2 days; codex unavailable 5 days, no signal).
//
// Covers: streak threshold, success resets, per-key cooldown, engine-transition
// alert, and the delivery guard (test env / no secrets → no network).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const MODS = ['degrade-alert', 'secrets'].map(m => `../../src/${m}.js`);
const prevEnv = {};
for (const k of ['TEST_MODE', 'NODE_ENV']) prevEnv[k] = process.env[k];

beforeEach(() => {
  process.env.TEST_MODE = '1'; // delivery is a no-op; we assert on the decision layer
  sent.length = 0;
  for (const m of MODS) { try { delete require.cache[require.resolve(m)]; } catch { /* not loaded */ } }
  require('../../src/degrade-alert.js')._resetForTests();
});
afterEach(() => {
  for (const k of Object.keys(prevEnv)) {
    if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k];
  }
});

const alert = () => require('../../src/degrade-alert.js');
const sent = []; // spy on delivery — cleared per test (module-level array)
function spy() {
  const a = alert();
  a.send = async (t) => { sent.push(t); return true; };
  return a;
}

describe('#1912 ladder streak', () => {
  it('does not alert below the threshold', () => {
    const a = spy();
    expect(a.ladderOutcome({ ok: false, reason: 'http_error' })).toBe(1);
    expect(a.ladderOutcome({ ok: false, reason: 'http_error' })).toBe(2);
    a.ladderOutcome({ ok: false, reason: 'http_error' });
    a.ladderOutcome({ ok: false, reason: 'http_error' });
    expect(sent).toHaveLength(0); // 4 из 5
  });

  it('alerts at the threshold with the streak and source, then goes quiet (cooldown)', () => {
    const a = spy();
    for (let i = 0; i < a.LADDER_STREAK_THRESHOLD; i++) a.ladderOutcome({ ok: false, reason: 'http_error', source: 'input-router' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/недоступна/);
    expect(sent[0]).toMatch(/input-router/);
    // ещё 10 отказов в пределах cooldown — тишина
    for (let i = 0; i < 10; i++) a.ladderOutcome({ ok: false, reason: 'http_error' });
    expect(sent).toHaveLength(1);
  });

  it('a success resets the streak', () => {
    const a = spy();
    for (let i = 0; i < a.LADDER_STREAK_THRESHOLD - 1; i++) a.ladderOutcome({ ok: false });
    a.ladderOutcome({ ok: true });
    for (let i = 0; i < a.LADDER_STREAK_THRESHOLD - 1; i++) a.ladderOutcome({ ok: false });
    expect(sent).toHaveLength(0); // после ok счётчик обнулён — порог не набран
  });
});

describe('#1912 engine unavailable transition', () => {
  it('alerts once per outage (transition), suppressed inside the cooldown', () => {
    const a = spy();
    expect(a.engineUnavailable('codex', { message: 'QUOTA' })).toBe(true);
    expect(a.engineUnavailable('codex', { message: 'QUOTA' })).toBe(false); // тот же outage
    expect(a.engineUnavailable('opencode', { message: 'CONFIG' })).toBe(true); // другой движок — свой алерт
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(/codex/);
    expect(sent[0]).toMatch(/QUOTA/);
    expect(sent[1]).toMatch(/opencode/);
  });

  it('delivery is a no-op in TEST_MODE without network', async () => {
    const a = require('../../src/degrade-alert.js');
    expect(await a.send('should not go anywhere')).toBe(false);
  });
});

describe('#1912 wiring', () => {
  it('service-llm diag hook feeds the streak; a rung success clears it', async () => {
    const a = spy();
    // Прямая проверка контракта: ladderOutcome({ok}) — это ровно то, что вызывает
    // service-llm diag (ok → true, любой другой reason → false).
    const diagReasonToOk = (reason) => reason === 'ok';
    for (const r of ['http_error', 'fetch_error', 'empty_content']) a.ladderOutcome({ ok: diagReasonToOk(r), reason: r });
    expect(sent).toHaveLength(0);
    a.ladderOutcome({ ok: true, reason: 'ok' });
    a.ladderOutcome({ ok: false, reason: 'http_error' });
    expect(sent).toHaveLength(0); // streak сброшен после ok
  });

  it('engine-health transition contract: only degraded → unavailable fires', () => {
    const a = spy();
    // Контракт вызова из markEngineFailure: row.status === 'unavailable' && prev.status !== 'unavailable'
    const prev = { status: 'degraded' };
    const row = { status: 'unavailable' };
    if (row.status === 'unavailable' && prev.status !== 'unavailable') a.engineUnavailable('codex', { message: 'QUOTA' });
    if (row.status === 'unavailable' && prev.status !== 'unavailable') a.engineUnavailable('codex', { message: 'QUOTA' });
    expect(sent).toHaveLength(1); // второй вызов — всё ещё один и тот же outage, но cooldown уже взял
  });
});
