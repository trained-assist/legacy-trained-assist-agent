import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createSession,
  appendUserMessage,
  appendReply,
  listSessions,
  getSession,
  buildContext,
  resolveChatSession,
  getLastOcModel,
  setLastOcModel,
  getCurrentSessionId as getCurrentSessionIdRef,
} from '../src/session-store.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createSession', () => {
  it('returns an id and writes session file + index', () => {
    const id = createSession(tmpDir, { task: 'Test task' });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    const sessionFile = path.join(tmpDir, 'sessions', `${id}.json`);
    expect(fs.existsSync(sessionFile)).toBe(true);

    const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    expect(data.id).toBe(id);
    expect(data.topic).toBe('Test task');
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].role).toBe('user');
  });

  it('uses provided id if given', () => {
    const id = createSession(tmpDir, { task: 'hello', id: 's-custom-123' });
    expect(id).toBe('s-custom-123');
  });
});

describe('appendUserMessage', () => {
  it('adds user message to session', () => {
    const id = createSession(tmpDir, { task: 'first task' });
    appendUserMessage(tmpDir, id, 'second message');

    const session = getSession(tmpDir, id);
    expect(session.messages).toHaveLength(2);
    expect(session.messages[1].role).toBe('user');
    expect(session.messages[1].content).toBe('second message');
  });

  it('skips a user message identical to the previous one (restart [ПРОДОЛЖЕНИЕ] stacking)', () => {
    const id = createSession(tmpDir, { task: 'task' });
    appendUserMessage(tmpDir, id, '[ПРОДОЛЖЕНИЕ] Сервер перезапустился');
    appendUserMessage(tmpDir, id, '[ПРОДОЛЖЕНИЕ] Сервер перезапустился');
    appendUserMessage(tmpDir, id, '[ПРОДОЛЖЕНИЕ] Сервер перезапустился');

    const session = getSession(tmpDir, id);
    expect(session.messages).toHaveLength(2); // task + one continuation, not 4
    expect(session.messages.filter(m => m.content === '[ПРОДОЛЖЕНИЕ] Сервер перезапустился')).toHaveLength(1);
  });

  it('still records a distinct follow-up after an identical message', () => {
    const id = createSession(tmpDir, { task: 'task' });
    appendUserMessage(tmpDir, id, '[ПРОДОЛЖЕНИЕ] Сервер перезапустился');
    appendUserMessage(tmpDir, id, 'реальное продолжение');

    const session = getSession(tmpDir, id);
    expect(session.messages.map(m => m.content)).toEqual(['task', '[ПРОДОЛЖЕНИЕ] Сервер перезапустился', 'реальное продолжение']);
  });
});

describe('appendReply', () => {
  it('stores full reply without truncation', () => {
    const id = createSession(tmpDir, { task: 'task' });
    const longReply = 'x'.repeat(5000);
    appendReply(tmpDir, id, longReply);

    const session = getSession(tmpDir, id);
    const reply = session.messages.find(m => m.role === 'assistant');
    expect(reply).toBeDefined();
    expect(reply.content.length).toBe(5000);
  });

  it('adds assistant message with correct role', () => {
    const id = createSession(tmpDir, { task: 'task' });
    appendReply(tmpDir, id, 'Claude response here');

    const session = getSession(tmpDir, id);
    const reply = session.messages.find(m => m.role === 'assistant');
    expect(reply.content).toBe('Claude response here');
  });
});

describe('listSessions', () => {
  it('returns created session in list', () => {
    const id = createSession(tmpDir, { task: 'List test' });
    const list = listSessions(tmpDir, 10);
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(id);
    expect(list[0].topic).toBe('List test');
  });

  it('respects limit', () => {
    createSession(tmpDir, { task: 'A' });
    createSession(tmpDir, { task: 'B' });
    createSession(tmpDir, { task: 'C' });
    expect(listSessions(tmpDir, 2)).toHaveLength(2);
  });
});

describe('getSession', () => {
  it('returns full session with messages', () => {
    const id = createSession(tmpDir, { task: 'Full session test' });
    const session = getSession(tmpDir, id);
    expect(session.id).toBe(id);
    expect(Array.isArray(session.messages)).toBe(true);
  });

  it('returns null for non-existent session', () => {
    expect(getSession(tmpDir, 'nonexistent')).toBeNull();
  });
});

describe('buildContext', () => {
  it('returns string containing the session topic', () => {
    const id = createSession(tmpDir, { task: 'Build context task' });
    appendReply(tmpDir, id, 'assistant reply');

    const ctx = buildContext(tmpDir, id);
    expect(typeof ctx).toBe('string');
    expect(ctx).toContain('Build context task');
  });

  it('returns null for missing session', () => {
    expect(buildContext(tmpDir, 'no-such-id')).toBeNull();
  });
});

describe('resolveChatSession — chatId sign-split heal', () => {
  const CHAT = -1003814002203; // real group chatId (negative, sign preserved on the pointer)

  it('returns the explicit id unchanged when its session file exists', () => {
    const id = createSession(tmpDir, { task: 'real task', chatId: CHAT });
    expect(resolveChatSession(tmpDir, id, CHAT)).toBe(id);
  });

  it('heals a divergent id by falling back to the chat current-session pointer', () => {
    // The chat's real, content-bearing session (created with the raw negative chatId).
    const realId = createSession(tmpDir, { task: 'links + doc + full ТЗ', id: `s--1003814002203-1000`, chatId: CHAT });
    // The gateway hands back a sign-lost id (Math.abs) that has NO file on disk.
    const staleId = `s-1003814002203-2000`;
    expect(getSession(tmpDir, staleId)).toBeNull();
    // Must resolve to the real session, not spawn a blank one.
    expect(resolveChatSession(tmpDir, staleId, CHAT)).toBe(realId);
  });

  it('returns null (→ caller creates fresh) when neither id nor pointer resolve', () => {
    expect(resolveChatSession(tmpDir, 's-1003814002203-2000', CHAT)).toBeNull();
  });

  it('does not cross chats: an unknown id with no pointer for that chat stays unresolved', () => {
    createSession(tmpDir, { task: 'other chat', chatId: -42 });
    // CHAT has no session / pointer of its own → no accidental adoption of chat -42's session.
    expect(resolveChatSession(tmpDir, 's-1003814002203-9999', CHAT)).toBeNull();
  });
});

// AUDIENCE-SCOPE-SPEC: two bots (e.g. general-purpose + recruiter) share the same
// username+chatId. `audience` scopes sessions/projects per bot so they never mix —
// while every session/project created before this feature existed (no `audience`
// field on disk) must keep resolving exactly as it did, under the implicit 'default'.
describe('audience scoping', () => {
  const CHAT = 555;

  it('a session created under audience A is invisible to listSessions(..., "B")', () => {
    const idA = createSession(tmpDir, { task: 'recruiter task', chatId: CHAT, audience: 'recruiter' });
    const listB = listSessions(tmpDir, 10, 'other');
    expect(listB.find(s => s.id === idA)).toBeUndefined();

    const listA = listSessions(tmpDir, 10, 'recruiter');
    expect(listA.find(s => s.id === idA)).toBeDefined();
  });

  it('the current-session pointer for the same chatId is independent between two audiences', () => {
    const idDefault = createSession(tmpDir, { task: 'general task', id: 's-default-1', chatId: CHAT, audience: 'default' });
    const idRecruiter = createSession(tmpDir, { task: 'recruiter task', id: 's-recruiter-1', chatId: CHAT, audience: 'recruiter' });

    expect(getCurrentSessionIdRef(tmpDir, CHAT, 'default')).toBe(idDefault);
    expect(getCurrentSessionIdRef(tmpDir, CHAT, 'recruiter')).toBe(idRecruiter);
    // Cross-check: neither pointer leaks into the other audience.
    expect(getCurrentSessionIdRef(tmpDir, CHAT, 'default')).not.toBe(idRecruiter);
    expect(getCurrentSessionIdRef(tmpDir, CHAT, 'recruiter')).not.toBe(idDefault);
  });

  it('existing sessions with no audience field resolve under "default"', () => {
    // Simulate a pre-audience session record written before this feature existed.
    const id = createSession(tmpDir, { task: 'legacy task', chatId: CHAT });
    const fp = path.join(tmpDir, 'sessions', `${id}.json`);
    const full = JSON.parse(fs.readFileSync(fp, 'utf8'));
    delete full.audience;
    fs.writeFileSync(fp, JSON.stringify(full, null, 2));
    const sessions = JSON.parse(fs.readFileSync(path.join(tmpDir, 'sessions.json'), 'utf8'));
    const idx = sessions.findIndex(s => s.id === id);
    delete sessions[idx].audience;
    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), JSON.stringify(sessions, null, 2));

    const listDefault = listSessions(tmpDir, 10, 'default');
    expect(listDefault.find(s => s.id === id)).toBeDefined();
    const listRecruiter = listSessions(tmpDir, 10, 'recruiter');
    expect(listRecruiter.find(s => s.id === id)).toBeUndefined();
  });

  it('omitting audience in listSessions defaults to "default" (no accidental cross-bot mixing)', () => {
    createSession(tmpDir, { task: 'general task', id: 's-default-2', chatId: CHAT, audience: 'default' });
    const recruiterId = createSession(tmpDir, { task: 'recruiter task', id: 's-recruiter-2', chatId: CHAT, audience: 'recruiter' });
    const list = listSessions(tmpDir, 10); // no audience arg
    expect(list.find(s => s.id === recruiterId)).toBeUndefined();
  });
});

// issue #1061 Фаза 4: track the OpenCode ladder's resolved model per session/role so the
// runner can tell whether it changed between two turns of the same session.
describe('getLastOcModel / setLastOcModel', () => {
  it('returns null when no model has been recorded yet', () => {
    const id = createSession(tmpDir, { task: 'first turn' });
    expect(getLastOcModel(tmpDir, id, 'build')).toBeNull();
  });

  it('round-trips the model recorded for a role', () => {
    const id = createSession(tmpDir, { task: 'first turn' });
    setLastOcModel(tmpDir, id, 'build', 'opencode/gpt-6-astra');
    expect(getLastOcModel(tmpDir, id, 'build')).toBe('opencode/gpt-6-astra');
  });

  it('overwrites on a later turn, reflecting the ladder degrading', () => {
    const id = createSession(tmpDir, { task: 'first turn' });
    setLastOcModel(tmpDir, id, 'build', 'opencode/gpt-6-astra');
    setLastOcModel(tmpDir, id, 'build', 'deepseek-v4.1-flash');
    expect(getLastOcModel(tmpDir, id, 'build')).toBe('deepseek-v4.1-flash');
  });

  it('tracks roles independently', () => {
    const id = createSession(tmpDir, { task: 'first turn' });
    setLastOcModel(tmpDir, id, 'build', 'opencode/gpt-6-astra');
    setLastOcModel(tmpDir, id, 'plan', 'gpt-5.6-sol');
    expect(getLastOcModel(tmpDir, id, 'build')).toBe('opencode/gpt-6-astra');
    expect(getLastOcModel(tmpDir, id, 'plan')).toBe('gpt-5.6-sol');
  });

  it('is a no-op when the session file does not exist', () => {
    expect(() => setLastOcModel(tmpDir, 's-missing', 'build', 'x')).not.toThrow();
    expect(getLastOcModel(tmpDir, 's-missing', 'build')).toBeNull();
  });
});
