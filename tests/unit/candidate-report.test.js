// Candidate-for-client report (issue #982): requirements log, HTML template,
// quick answers and the MCP tools that share the notes file.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const report = require('../../src/candidate-report.js');
const { getQuickAnswer } = require('../../src/runner');

const roots = [];
function freshDir() {
  const d = mkdtempSync(join(tmpdir(), 'cand-report-'));
  roots.push(d);
  return d;
}
afterAll(() => roots.forEach(d => rmSync(d, { recursive: true, force: true })));

const NOW = new Date(2026, 8, 18, 12, 0); // 18.09

describe('notes file', () => {
  let wd;
  beforeEach(() => { wd = freshDir(); });

  it('writes the issue layout: three sections, dated history', () => {
    report.addNote(wd, 'dmitriy-chayka', 'Не писать «рассматривает удалённый формат» — офис в МСК', { now: NOW, nameForNew: 'Дмитрий Чайка' });
    report.addNote(wd, 'dmitriy-chayka', 'Включить ссылку на видео скрининга', { now: NOW });
    const md = readFileSync(report.notesPath(wd, 'dmitriy-chayka'), 'utf8');
    expect(md).toContain('# Требования к профилю: Дмитрий Чайка');
    expect(md).toContain('## Что включать\n- Включить ссылку на видео скрининга');
    expect(md).toContain('## Что НЕ включать / формулировки\n- Не писать «рассматривает удалённый формат» — офис в МСК');
    expect(md).toContain('- 18.09 — добавлено: Включить ссылку на видео скрининга');
  });

  it('round-trips through parseNotes and keeps history', () => {
    report.addNote(wd, 'a', 'Писать от первого лица', { now: NOW });
    report.addNote(wd, 'a', 'Убрать фразу про NeuroFinance', { now: NOW });
    const n = report.readNotes(wd, 'a');
    expect(n.exclude).toEqual(['Писать от первого лица', 'Убрать фразу про NeuroFinance']);
    expect(n.history).toHaveLength(2);
  });

  it('classifies: negative lead + formulation rules → exclude, explicit inclusion → include', () => {
    expect(report.classifyNote('не упоминать удалёнку')).toBe('exclude');
    expect(report.classifyNote('убери фразу про фонд')).toBe('exclude');
    expect(report.classifyNote('нюансы подавать честно, не как плюсы')).toBe('exclude');
    expect(report.classifyNote('включи матрицу соответствия')).toBe('include');
    expect(report.classifyNote('добавь ссылку на видео')).toBe('include');
  });

  it('does not duplicate an identical requirement or add a history line for it', () => {
    report.addNote(wd, 'a', 'Не упоминать удалёнку', { now: NOW });
    const r = report.addNote(wd, 'a', 'не упоминать удалёнку', { now: NOW });
    expect(r.duplicate).toBe(true);
    const n = report.readNotes(wd, 'a');
    expect(n.exclude).toHaveLength(1);
    expect(n.history).toHaveLength(1);
  });

  it('notes file is 0600 (candidate PII context)', () => {
    report.addNote(wd, 'a', 'Не упоминать удалёнку');
    const { statSync } = require('fs');
    expect(statSync(report.notesPath(wd, 'a')).mode & 0o777).toBe(0o600);
  });
});

describe('candidate resolution', () => {
  it('matches surname in any case form, ambiguous and unknown are reported', () => {
    const wd = freshDir();
    report.addNote(wd, 'дмитрий-чайка', 'Не упоминать удалёнку');
    report.addNote(wd, 'антон-яковенко', 'Не упоминать удалёнку');
    expect(report.resolveCandidate(wd, 'Чайка')).toEqual({ slug: 'дмитрий-чайка' });
    expect(report.resolveCandidate(wd, 'Чайку')).toEqual({ slug: 'дмитрий-чайка' });
    expect(report.resolveCandidate(wd, 'Дмитрия Чайки')).toEqual({ slug: 'дмитрий-чайка' });
    expect(report.resolveCandidate(wd, 'Иванов')).toEqual({ none: true });
    report.addNote(wd, 'дмитрий-иванов', 'Не упоминать удалёнку');
    expect(report.resolveCandidate(wd, 'Дмитрий').ambiguous).toHaveLength(2);
  });

  it('no name → last candidate worked on', () => {
    const wd = freshDir();
    report.addNote(wd, 'антон-яковенко', 'Не упоминать удалёнку');
    report.addNote(wd, 'дмитрий-чайка', 'Не упоминать удалёнку');
    expect(report.resolveCandidate(wd, '')).toEqual({ slug: 'дмитрий-чайка' });
  });
});

describe('banned phrases', () => {
  const notes = {
    name: 'x', include: [],
    exclude: [
      'Не писать «рассматривает удалённый формат» — офис в МСК',
      'Убрать фразу «Основной фокус — зарубежный фондовый рынок»',
      'Нюансы подавать честно, не как плюсы',
      'Писать про «фонд» подробно', // not a negative rule → not a ban
    ],
    history: [],
  };

  it('extracts quoted phrases only from negative rules', () => {
    expect(report.forbiddenPhrases(notes)).toEqual([
      'рассматривает удалённый формат',
      'Основной фокус — зарубежный фондовый рынок',
    ]);
  });

  it('finds them case/ё/whitespace-insensitively anywhere in the data', () => {
    const data = { summary: 'Он  РАССМАТРИВАЕТ удаленный   формат работы', experience: [{ details: ['ок'] }] };
    expect(report.findViolations(data, notes)).toEqual([{ phrase: 'рассматривает удалённый формат' }]);
    expect(report.findViolations({ summary: 'чисто' }, notes)).toEqual([]);
  });
});

describe('HTML template', () => {
  const data = {
    candidate: { name: 'Дмитрий Чайка', age: '23 года', position: 'Финансовый советник, БКС', contacts: ['+7 900 000-00-00'], badges: ['план 115%', 'max сделка 42 млн'], photo_url: 'https://x.test/a.jpg' },
    client: { company: 'АТОН', vacancy: 'Финансовый советник' },
    summary: 'Я работаю с 130–140 клиентами.\n\nПлан выполняю на 115%.',
    matrix: [
      { requirement: 'Опыт в продажах ФУ', status: 'yes', comment: '3 года' },
      { requirement: 'Офис в МСК', status: 'partial', comment: 'сейчас в Таиланде' },
      { requirement: 'Английский', status: 'no' },
    ],
    experience: [{ period: '2023–н.в.', company: 'БКС', role: 'Советник', details: ['130–140 клиентов'] }],
    conclusion: 'Рекомендую к встрече.\n\nНюанс: релокация.',
    video_url: 'https://video.test/abc',
  };

  it('renders header, matrix statuses, conclusion, video and print CSS', () => {
    const { html, warnings } = report.renderProfileHtml(data);
    expect(warnings).toEqual([]);
    expect(html).toContain('<h1>Дмитрий Чайка</h1>');
    expect(html).toContain('план 115%');
    expect(html).toContain('class="st yes"');
    expect(html).toContain('class="st partial"');
    expect(html).toContain('class="st no"');
    expect(html).toContain('Вывод рекрутера');
    expect(html).toContain('href="https://video.test/abc"');
    expect(html).toContain('@media print');
    expect(html).toContain('@page{size:A4;margin:0}');
    expect(html.match(/<p>Я работаю/g)).toHaveLength(1);
    expect(html).toContain('<p>План выполняю'); // paragraphs split on blank line
  });

  it('escapes HTML and refuses non-http urls (no script/javascript: injection)', () => {
    const { html } = report.renderProfileHtml({
      ...data,
      candidate: { name: '<script>alert(1)</script>', photo_url: 'javascript:alert(1)' },
      video_url: 'javascript:alert(2)',
    });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('javascript:');
  });

  it('warns about missing sections instead of failing; name is mandatory', () => {
    const { warnings } = report.renderProfileHtml({ candidate: { name: 'X' } });
    expect(warnings.join('|')).toMatch(/summary.*matrix.*conclusion.*video_url/);
    expect(() => report.renderProfileHtml({ candidate: {} })).toThrow(/name/);
  });

  it('publishSlug is ASCII, stable, and distinct per candidate/profile', () => {
    const a = report.publishSlug('efi', 'дмитрий-чайка');
    expect(a).toMatch(/^profile-dmitriy-chayka-[0-9a-f]{6}$/);
    expect(report.publishSlug('efi', 'дмитрий-чайка')).toBe(a);
    expect(report.publishSlug('efi', 'антон-яковенко')).not.toBe(a);
    expect(report.publishSlug('other', 'дмитрий-чайка')).not.toBe(a);
  });
});

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

describe('MCP tools share the notes file with the quick answers', () => {
  const users = process.env.USERS_DIR;
  const prevUser = process.env.USER_ID;
  let tools;

  beforeEach(() => {
    process.env.USER_ID = 'rec-test';
    mkdirSync(join(users, 'rec-test'), { recursive: true });
    rmSync(join(users, 'rec-test', 'candidate-reports'), { recursive: true, force: true });
    // Modules read USER_ID at load; reload for a deterministic env.
    for (const k of Object.keys(require.cache)) if (/97b-candidate|97-publish/.test(k)) delete require.cache[k];
    tools = require('../../src/mcp-skills/tools/97b-candidate-client-report.js').tools;
  });
  afterAll(() => {
    if (prevUser === undefined) delete process.env.USER_ID; else process.env.USER_ID = prevUser;
    rmSync(join(users, 'rec-test'), { recursive: true, force: true });
  });

  const DATA = {
    candidate: { name: 'Дмитрий Чайка' },
    summary: 'Он рассматривает удалённый формат.',
    matrix: [{ requirement: 'Офис', status: 'yes' }],
    conclusion: 'Рекомендую.',
    video_url: 'https://v.test/1',
  };

  it('a note added by quick answer is enforced on render; fixing the text unblocks publishing', async () => {
    const wd = join(users, 'rec-test');
    getQuickAnswer('добавь в требования к профилю Чайка: не писать «рассматривает удалённый формат»', 'rec-test', wd);

    const ctx = await tools.candidate_report_context.handler({ candidate: 'Чайку' });
    expect(ctx.slug).toBe('чайка');
    expect(ctx.banned_phrases).toEqual(['рассматривает удалённый формат']);

    const bad = await tools.candidate_report_render.handler({ candidate: 'Чайка', data: DATA, publish: false });
    expect(bad.ok).toBe(false);
    expect(bad.violations).toEqual([{ phrase: 'рассматривает удалённый формат' }]);
    expect(existsSync(report.htmlPath(wd, 'чайка'))).toBe(false);

    const ok = await tools.candidate_report_render.handler({
      candidate: 'Чайка', publish: false,
      data: { ...DATA, summary: 'Готов работать в офисе в Москве.' },
    });
    expect(ok.ok).toBe(true);
    expect(existsSync(ok.html_file)).toBe(true);

    // Regeneration gets the previous data back — the recruiter doesn't have to restate anything.
    const again = await tools.candidate_report_context.handler({ candidate: 'Чайка' });
    expect(again.previous_data.summary).toBe('Готов работать в офисе в Москве.');
    expect(again.notes_markdown).toContain('профиль перегенерирован');
  });

  it('render publishes via publish_page with an ASCII slug and password', async () => {
    const r = await tools.candidate_report_render.handler({
      candidate: 'Дмитрий Чайка', data: { ...DATA, summary: 'Ок.' }, password: 's3cret',
    });
    expect(r.ok).toBe(true);
    expect(r.url).toMatch(/\/p\/profile-dmitriy-chayka-[0-9a-f]{6}\?password=s3cret$/);
    expect(r.is_protected).toBe(true);
  });

  it('add_note tool writes into the same file', async () => {
    const r = await tools.candidate_report_add_note.handler({ candidate: 'Яковенко', text: 'Нюансы подавать честно' });
    expect(r.section).toBe('exclude');
    expect(existsSync(join(users, 'rec-test', 'candidate-reports', 'яковенко-report-notes.md'))).toBe(true);
  });

  it('errors clearly when candidate is unknown and no last candidate', async () => {
    const r = await tools.candidate_report_add_note.handler({ text: 'x y z' });
    expect(r.error).toMatch(/candidate/);
  });
});
