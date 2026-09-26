/**
 * Unit tests for src/session-trace.js — the "полный лог" reader that turns the
 * engine's durable trace (opencode.db parts) into display-ready events grouped
 * by the s-session message timeline.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function loadTrace() {
  const p = require.resolve('../src/session-trace.js');
  delete require.cache[p];
  return require('../src/session-trace.js');
}

// A tiny real SQLite db holding parts for one opencode session, built with the
// better-sqlite3 the module itself uses.
function buildDb() {
  const Database = require('better-sqlite3');
  const dir = mkdtempSync(join(tmpdir(), 'trace-test-'));
  const fp = join(dir, 'opencode.db');
  const db = new Database(fp);
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY);');
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT);');
  const ins = db.prepare('INSERT INTO part (id, session_id, message_id, time_created, data) VALUES (?,?,?,?,?)');
  const parts = [
    ['p1', 'ses_x', 'm1', 1000, JSON.stringify({ type: 'text', text: 'hello', time: { created: 1000 } })],
    ['p2', 'ses_x', 'm2', 2000, JSON.stringify({ type: 'reasoning', text: 'thinking about it', time: { start: 2000 } })],
    ['p3', 'ses_x', 'm2', 3000, JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'a.txt\nb.txt' }, time: { start: 3000 } })],
    ['p4', 'ses_x', 'm3', 4000, JSON.stringify({ type: 'step-start', time: { start: 4000 } })],
    ['p5', 'ses_x', 'm3', 5000, JSON.stringify({ type: 'step-finish', reason: 'end_turn', tokens: { input: 1, output: 2 }, cost: 0.01, time: { start: 5000 } })],
    ['p6', 'ses_x', 'm3', 6000, JSON.stringify({ type: 'compaction', auto: true, time: { start: 6000 } })],
  ];
  for (const p of parts) ins.run(...p);
  db.exec("INSERT INTO session (id) VALUES ('ses_x');");
  db.close();
  return { dir, fp };
}

describe('session-trace', () => {
  let fixture;
  beforeEach(() => { fixture = buildDb(); });
  afterEach(() => { rmSync(fixture.dir, { recursive: true, force: true }); });

  it('reads and normalizes all part kinds from the engine db', () => {
    const trace = loadTrace();
    trace.setDbPath(fixture.fp);
    const res = trace.readTrace('/tmp', { engineSessions: { opencode: 'ses_x' } });
    expect(res.ok).toBe(true);
    expect(res.engine).toBe('opencode');
    expect(res.events).toHaveLength(6);
    const kinds = res.events.map(e => e.kind);
    expect(kinds).toEqual(['text', 'reasoning', 'tool', 'step-start', 'step-finish', 'compaction']);
    const tool = res.events.find(e => e.kind === 'tool');
    expect(tool.tool).toBe('bash');
    expect(tool.input).toContain('ls');
    expect(tool.output).toContain('a.txt');
    const reasoning = res.events.find(e => e.kind === 'reasoning');
    expect(reasoning.text).toBe('thinking about it');
  });

  it('groups events into s-session message windows by timestamp', () => {
    const trace = loadTrace();
    trace.setDbPath(fixture.fp);
    const messages = [{ at: 1500 }, { at: 4500 }, { at: 7000 }];
    const res = trace.readTrace('/tmp', { engineSessions: { opencode: 'ses_x' }, messages });
    expect(res.ok).toBe(true);
    // Bucket = first message whose `at` >= event.at:
    // p1@1000 -> msg0@1500 | p2,p3@2000/3000 + p4@4000 -> msg1@4500 | p5,p6 -> msg2@7000
    expect(res.byMessage.map(b => b.map(e => e.kind))).toEqual([
      ['text'],
      ['reasoning', 'tool', 'step-start'],
      ['step-finish', 'compaction'],
    ]);
  });

  it('returns ok:false when the session has no opencode engine id', () => {
    const trace = loadTrace();
    const res = trace.readTrace('/tmp', { engineSessions: { claude: 'b1eb5ece' } });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('no-opencode-session');
    expect(res.engine).toBe('claude');
  });

  it('returns ok:false when the db is missing', () => {
    const trace = loadTrace();
    trace.setDbPath('/nonexistent/opencode.db');
    const res = trace.readTrace('/tmp', { engineSessions: { opencode: 'ses_x' } });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('db-unavailable');
  });

  it('returns ok:false when the engine session id is unknown to the db', () => {
    const trace = loadTrace();
    trace.setDbPath(fixture.fp);
    const res = trace.readTrace('/tmp', { engineSessions: { opencode: 'ses_missing' } });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('session-not-found');
  });

  it('truncates long tool output', () => {
    const trace = loadTrace();
    const long = 'x'.repeat(5000);
    const out = trace.truncate(long, 4000);
    expect(out).toContain('обрезано');
    expect(out.length).toBeLessThan(4050);
  });
});