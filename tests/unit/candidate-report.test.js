// Candidate-for-client report quick answers (issue #982). The notes library, HTML
// template and MCP tools live in trained-assist-hh-skill (#1470) and are tested there.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const report = require('../../src/domains/hh/lib').hhLib('hh-candidate-report');
const { getQuickAnswer } = require('../../src/runner');

const roots = [];
function freshDir() {
  const d = mkdtempSync(join(tmpdir(), 'cand-report-'));
  roots.push(d);
  return d;
}
afterAll(() => roots.forEach(d => rmSync(d, { recursive: true, force: true })));

const NOW = new Date(2026, 8, 18, 12, 0); // 18.09

describe('quick answers', () => {
  let wd;
  beforeEach(() => { wd = freshDir(); });
  const qa = (t) => getQuickAnswer(t, 'efi', wd);

  it('"добавь в требования: …" attaches to the last candidate — no Claude', () => {
    report.addNote(wd, 'дмитрий-чайка', 'Писать от первого лица', { nameForNew: 'Дмитрий Чайка' });
    const a = qa('добавь в требования: не упоминать удалёнку');
    expect(a).toMatch(/Записал/);
    expect(a).toContain('Дмитрий Чайка');
    expect(report.readNotes(wd, 'дмитрий-чайка').exclude).toContain('не упоминать удалёнку');
  });

  it('explicit "к профилю <имя>" creates a new candidate file; slash form works too', () => {
    expect(qa('добавь в требования к профилю Антон Яковенко: нюансы подавать честно')).toMatch(/Записал/);
    expect(existsSync(report.notesPath(wd, 'антон-яковенко'))).toBe(true);
    expect(qa('/report_add Яковенко: убрать фразу про Таиланд')).toMatch(/Записал/);
    expect(report.readNotes(wd, 'антон-яковенко').exclude).toHaveLength(2);
  });

  it('resolves declined surname to the existing candidate', () => {
    report.addNote(wd, 'дмитрий-чайка', 'Писать от первого лица');
    report.addNote(wd, 'антон-яковенко', 'Писать от первого лица');
    expect(qa('добавь в требования к профилю Чайки: не упоминать БКС')).toMatch(/Дмитрий Чайка|дмитрий-чайка/);
    expect(report.readNotes(wd, 'дмитрий-чайка').exclude).toContain('не упоминать БКС');
  });

  it('falls through to Claude when there is no candidate to attach to (may be about a vacancy)', () => {
    expect(qa('добавь в требования: знание английского')).toBeNull();
    report.addNote(wd, 'a', 'Писать от первого лица');
    // bare unknown target without "профиль" is not a candidate → don't hijack
    expect(qa('добавь в требования вакансии: знание английского')).toBeNull();
    expect(report.readNotes(wd, 'a').exclude).toHaveLength(1);
  });

  it('vacancy collecting mode keeps priority over the requirements command', () => {
    report.addNote(wd, 'a', 'Писать от первого лица');
    mkdirSync(join(wd, 'contexts', 'hh'), { recursive: true });
    const { initVacancyState } = require('../../src/domains/hh/lib').hhLib('hh-vacancy');
    initVacancyState(wd);
    expect(qa('добавь в требования: знание английского')).toMatch(/Принял/);
    expect(report.readNotes(wd, 'a').exclude).toHaveLength(1);
  });

  it('shows current requirements', () => {
    report.addNote(wd, 'дмитрий-чайка', 'Не писать «рассматривает удалённый формат»', { nameForNew: 'Дмитрий Чайка' });
    const a = qa('покажи текущие требования к профилю Чайка');
    expect(a).toContain('Что НЕ включать / формулировки');
    expect(a).toContain('рассматривает удалённый формат');
    expect(qa('/report_notes')).toContain('Дмитрий Чайка'); // last candidate
    expect(qa('покажи требования к профилю Иванов')).toMatch(/пока нет/);
  });

  it.each([
    'умеешь делать профиль кандидата для клиента?',
    'можешь сделать отчёт по кандидату для клиента',
    'как сделать профиль кандидата для клиента',
    'есть ли возможность делать резюме для клиента?',
  ])('capability: "%s" → instant answer with commands', (t) => {
    const a = qa(t);
    expect(a).toMatch(/перегенерируй профиль/);
    expect(a).toMatch(/добавь в требования/);
  });

  it.each([
    'сделай профиль кандидата Чайка для клиента АТОН',
    'можешь сделать профиль кандидата Чайка для клиента АТОН?',
    'перегенерируй профиль Чайка',
    'перегенерируй профиль Чайка от первого лица',
  ])('task: "%s" → NOT eaten, goes to Claude', (t) => {
    expect(qa(t)).toBeNull();
  });
});

