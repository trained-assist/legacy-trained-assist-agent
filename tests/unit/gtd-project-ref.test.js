// #1813 (гейт приёмки P1 #1789): GTD и orphan-checklist хранят адрес checklist.md
// ОТНОСИТЕЛЬНО корня профиля — перенос/копия профиля (profile-migrate, worktree,
// смена USERS_DIR) их не ломает. Внутри: (а) чтение legacy-абсолютного формата,
// (б) запись/чтение нового относительного, (в) мок переноса профиля в другой
// каталог (копия и rename), dedup смешанных форматов, orphan-store.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync, cpSync, renameSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const G = require('../../src/gtd-controller.js');
const O = require('../../src/orphan-checklists.js');
const projects = require('../../src/projects.js');

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gtd-projref-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

// Профиль с одним проектом и активным checklist.md в его корне.
// rel — как адрес выглядит в НОВОМ формате ('projects/<id>').
function makeProfile(name, { checklist = 'Goal: цель\n- [ ] раз\n- [ ] два\n', rootChecklist = null } = {}) {
  const workDir = join(root, name);
  mkdirSync(workDir, { recursive: true });
  const meta = projects.createProject(workDir, { type: 'generic', name: `проект ${name}` });
  const projectDir = projects.projectDir(workDir, meta.id);
  if (checklist != null) writeFileSync(join(projectDir, 'checklist.md'), checklist);
  if (rootChecklist != null) writeFileSync(join(workDir, 'checklist.md'), rootChecklist);
  writeFileSync(join(workDir, 'sessions.json'), '[]'); // маркер корня профиля
  return { workDir, projectDir, rel: join('projects', meta.id) };
}

// Запись ровно в том виде, в каком её писал старый код: абсолютный projectDir.
function writeLegacyGtd(workDir, rec) {
  mkdirSync(join(workDir, 'gtd'), { recursive: true });
  writeFileSync(join(workDir, 'gtd', `${rec.sessionId}.json`), JSON.stringify(rec, null, 2));
}

function rawGtd(workDir, sessionId) {
  return JSON.parse(readFileSync(join(workDir, 'gtd', `${sessionId}.json`), 'utf8'));
}

// ── (б) формат хранения ───────────────────────────────────────────────────────

describe('gtd-project-ref: формат хранения', () => {
  it('каталог ВНУТРИ профиля пишется как projectPath, абсолютный projectDir не сохраняется', () => {
    const { workDir, projectDir, rel } = makeProfile('alice');
    G.writeGtd(workDir, { sessionId: 's-1', status: 'open', dueAt: 1, projectDir });
    const raw = rawGtd(workDir, 's-1');
    expect(raw.projectPath).toBe(rel);
    expect(raw.projectDir).toBeUndefined();
  });

  it('корень профиля → projectPath «.»', () => {
    const { workDir } = makeProfile('bob');
    G.writeGtd(workDir, { sessionId: 's-1', status: 'open', dueAt: 1, projectDir: workDir });
    const raw = rawGtd(workDir, 's-1');
    expect(raw.projectPath).toBe('.');
    expect(raw.projectDir).toBeUndefined();
  });

  it('каталог ВНЕ профиля остаётся абсолютным projectDir (с профилем он не переезжает)', () => {
    const { workDir } = makeProfile('carol');
    const outside = mkdtempSync(join(tmpdir(), 'gtd-outside-'));
    try {
      G.writeGtd(workDir, { sessionId: 's-1', status: 'open', dueAt: 1, projectDir: outside });
      const raw = rawGtd(workDir, 's-1');
      expect(raw.projectDir).toBe(outside);
      expect(raw.projectPath).toBeUndefined();
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it('запись без адреса (projectDir: null) не получает ни одного поля адреса', () => {
    const { workDir } = makeProfile('dave');
    G.writeGtd(workDir, { sessionId: 's-1', status: 'open', dueAt: 1, projectDir: null });
    const raw = rawGtd(workDir, 's-1');
    expect(raw.projectDir).toBeUndefined();
    expect(raw.projectPath).toBeUndefined();
  });

  it('чтение нового формата: в памяти rec.projectDir всегда абсолютный', () => {
    const { workDir, projectDir, rel } = makeProfile('erin');
    G.writeGtd(workDir, { sessionId: 's-1', status: 'open', dueAt: 1, projectDir });
    expect(rawGtd(workDir, 's-1').projectPath).toBe(rel);
    const rec = G.readGtd(workDir, 's-1');
    expect(rec.projectDir).toBe(projectDir);
    expect(G.trackedChecklist(rec)?.goal).toBe('цель');
    expect(G.listGtd(workDir)[0].projectDir).toBe(projectDir);
  });
});

// ── (а) legacy-абсолютный формат ──────────────────────────────────────────────

describe('gtd-project-ref: чтение старого абсолютного формата', () => {
  it('legacy-запись с абсолютным projectDir читается и ведёт к своему checklist.md', () => {
    const { workDir, projectDir } = makeProfile('frank');
    writeLegacyGtd(workDir, { sessionId: 's-leg', status: 'open', dueAt: 1, projectDir });
    const rec = G.readGtd(workDir, 's-leg');
    expect(rec.projectDir).toBe(projectDir);
    expect(G.trackedChecklist(rec)?.goal).toBe('цель');
    expect(G.gtdProjectDir(workDir, rec)).toBe(projectDir);
  });

  it('следующая запись переводит legacy-абсолют в относительный (самоизлечение без миграции)', () => {
    const { workDir, projectDir, rel } = makeProfile('grace');
    writeLegacyGtd(workDir, { sessionId: 's-leg', status: 'open', dueAt: 1, projectDir });
    const rec = G.readGtd(workDir, 's-leg');
    expect(G.writeGtd(workDir, rec)).toBe(true);
    const raw = rawGtd(workDir, 's-leg');
    expect(raw.projectPath).toBe(rel);
    expect(raw.projectDir).toBeUndefined();
  });
});

// ── (в) перенос профиля ───────────────────────────────────────────────────────

describe('gtd-project-ref: перенос профиля (#1813)', () => {
  it('новый формат: после КОПИИ профиля запись читает checklist.md из нового расположения', () => {
    const { workDir: a, projectDir, rel } = makeProfile('heidi');
    G.writeGtd(a, { sessionId: 's-1', status: 'open', dueAt: 1, projectDir });
    const b = join(root, 'heidi-moved');
    cpSync(a, b, { recursive: true });

    const rec = G.readGtd(b, 's-1');
    const movedProjectDir = join(b, rel);
    expect(rec.projectDir).toBe(movedProjectDir);
    expect(G.trackedChecklist(rec)?.goal).toBe('цель');
    // старый каталог существует (это копия) — читаем всё равно НОВЫЙ
    expect(rec.projectDir.startsWith(`${b}/`)).toBe(true);
  });

  it('legacy-абсолют: после КОПИИ профиля адрес спасается по структуре projects/<id>', () => {
    const { workDir: a, projectDir, rel } = makeProfile('iris');
    writeLegacyGtd(a, { sessionId: 's-leg', status: 'open', dueAt: 1, projectDir });
    const b = join(root, 'iris-moved');
    cpSync(a, b, { recursive: true });

    const rec = G.readGtd(b, 's-leg');
    const movedProjectDir = join(b, rel);
    expect(rec.projectDir).toBe(movedProjectDir);
    expect(G.trackedChecklist(rec)?.goal).toBe('цель');
    // и при следующей записи файл самоизлечивается
    G.writeGtd(b, rec);
    expect(rawGtd(b, 's-leg').projectPath).toBe(rel);
  });

  it('legacy-абсолют: после RENAME (старого корня больше нет) адрес спасается тоже', () => {
    const { workDir: a, projectDir, rel } = makeProfile('judy');
    writeLegacyGtd(a, { sessionId: 's-leg', status: 'open', dueAt: 1, projectDir });
    const b = join(root, 'judy-moved');
    renameSync(a, b);

    const rec = G.readGtd(b, 's-leg');
    expect(rec.projectDir).toBe(join(b, rel));
    expect(G.trackedChecklist(rec)?.goal).toBe('цель');
  });

  it('legacy-запись уровня КОРНЯ: после копии адрес указывает на новый корень', () => {
    const { workDir: a } = makeProfile('kate', {
      checklist: null,
      rootChecklist: 'Goal: корневая цель\n- [ ] раз\n',
    });
    writeLegacyGtd(a, { sessionId: 's-root', status: 'open', dueAt: 1, projectDir: a });
    const b = join(root, 'kate-moved');
    cpSync(a, b, { recursive: true });

    const rec = G.readGtd(b, 's-root');
    expect(rec.projectDir).toBe(b);
    expect(G.readChecklist(rec.projectDir)?.goal).toBe('корневая цель');
  });

  it('каталог ВНЕ профиля после переноса остаётся собой — чужой путь не подставляется', () => {
    const { workDir: a } = makeProfile('lena');
    const outside = mkdtempSync(join(tmpdir(), 'gtd-outside-'));
    try {
      writeLegacyGtd(a, { sessionId: 's-out', status: 'open', dueAt: 1, projectDir: outside });
      const b = join(root, 'lena-moved');
      renameSync(a, b);
      expect(G.readGtd(b, 's-out').projectDir).toBe(outside);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});

// ── dedup смешанных форматов (приёмка #1813) ─────────────────────────────────

describe('gtd-project-ref: dedup смешанных форматов', () => {
  it('legacy-абсолютная запись того же проекта гасит новую — вторая GTD-запись не создаётся', async () => {
    const { workDir, projectDir } = makeProfile('maya', { checklist: 'Goal: цель\nOwner-session: s-new\n- [ ] раз\n' });
    writeLegacyGtd(workDir, { sessionId: 's-old', status: 'open', dueAt: Date.now() + 1e9, projectDir });
    const before = readdirSync(join(workDir, 'gtd')).length;

    const rec = await G.scheduleFromChecklist({
      workDir, sessionId: 's-new', projectDir, isSessionRunning: () => false,
    });

    expect(rec?.sessionId).toBe('s-old');
    expect(readdirSync(join(workDir, 'gtd')).length).toBe(before, 'вторая запись не создана');
  });

  it('относительная запись того же проекта гасит новый вызов — дубль не появляется', async () => {
    const { workDir, projectDir } = makeProfile('nina', { checklist: 'Goal: цель\nOwner-session: s-new\n- [ ] раз\n' });
    G.writeGtd(workDir, { sessionId: 's-old', status: 'open', dueAt: Date.now() + 1e9, projectDir });
    const before = readdirSync(join(workDir, 'gtd')).length;

    const rec = await G.scheduleFromChecklist({
      workDir, sessionId: 's-new', projectDir, isSessionRunning: () => false,
    });

    expect(rec?.sessionId).toBe('s-old');
    expect(readdirSync(join(workDir, 'gtd')).length).toBe(before, 'вторая запись не создана');
  });
});

// ── orphan-checklist store ────────────────────────────────────────────────────

describe('orphan-checklist store: относительный адрес', () => {
  it('(б) новая запись сохраняется с projectPath и читается обратно с абсолютным адресом', () => {
    const { workDir, projectDir, rel } = makeProfile('olga', { checklist: 'Goal: забытая цель\n- [ ] живая проверка\n' });
    const out = O.listForgotten({ workDir, username: 'olga', isSessionRunning: () => false });
    expect(out.length).toBe(1);

    const raw = JSON.parse(readFileSync(join(workDir, 'gtd-orphans.json'), 'utf8'));
    const stored = Object.values(raw.records)[0];
    expect(stored.projectPath).toBe(rel);
    expect(stored.projectDir).toBeUndefined();

    const found = O.findRecord(workDir, projectDir, 'забытая цель');
    expect(found?.projectDir).toBe(projectDir);
    expect(found?.id).toBe(stored.id);
  });

  it('(а)+(в) legacy-абсолютная запись после КОПИИ профиля: findRecord находит её, дубль не плодится', () => {
    const { workDir: a, projectDir, rel } = makeProfile('pola', { checklist: 'Goal: старая цель\n- [ ] пункт\n' });
    const id = O.sectionId(projectDir, 'старая цель');
    writeFileSync(join(a, 'gtd-orphans.json'), JSON.stringify({
      records: {
        [id]: {
          id, projectDir, goal: 'старая цель',
          firstSeenAt: 1, remindedAt: null, remindedHash: null,
          cancelledAt: null, doneAt: null, doingAt: null,
          username: 'pola', audience: 'default', chatId: '1', threadId: null,
          label: 'старая цель', openCount: 1, firstOpen: 'пункт', lastSeenAt: 1,
        },
      },
    }, null, 2));

    const b = join(root, 'pola-moved');
    cpSync(a, b, { recursive: true });
    const movedProjectDir = join(b, rel);

    // та же цель, новый (уже переехавший) адрес — запись находится по скану адреса
    const found = O.findRecord(b, movedProjectDir, 'старая цель');
    expect(found?.id).toBe(id, 'legacy id сохранён (кнопки в старых сообщениях живут)');
    expect(found?.projectDir).toBe(movedProjectDir);

    // listForgotten на новом месте обновляет СУЩЕСТВУЮЩУЮ запись, а не создаёт вторую
    const out = O.listForgotten({ workDir: b, username: 'pola', isSessionRunning: () => false });
    expect(out.length).toBe(1);
    const raw = JSON.parse(readFileSync(join(b, 'gtd-orphans.json'), 'utf8'));
    expect(Object.keys(raw.records)).toEqual([id]);
    expect(Object.values(raw.records)[0].projectPath).toBe(rel);
  });
});
