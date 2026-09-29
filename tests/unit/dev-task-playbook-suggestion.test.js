// Slice C of #1573: auto-offer the audience-default playbook on development-like
// tasks. Pure module — the tests pin the three opt-in-safe boundaries:
//   • not a dev task      → ''
//   • playbook unavailable → ''
//   • disabled via env     → ''
// plus the guardrail text (never auto-activate) and the dev heuristic.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  isDevelopmentTask, buildDevPlaybookSuggestion, DEV_TASK_RE,
} = require('../../src/dev-task-playbook-suggestion');

const availableStore = {
  resolve: id => (id === 'development' ? { id, version: 1, scope: 'system', source: 'sibling' } : null),
};
const unavailableStore = { resolve: () => null };

describe('isDevelopmentTask heuristic', () => {
  const dev = [
    'поставь изменение X в боте',
    'внеси изменение в отчётную логику',
    'почини баг — бот не отправляет уведомление',
    'исправь ошибку в обработке токена',
    'реализуй экспорт в CSV',
    'implement issue #1573',
    'отрефактори этот модуль',
    'сделай фичу: напоминания по расписанию',
    'напиши тесты на резолвер',
    'создай PR по этой ветке',
    'нужно смержить ветку после CI',
    'баг в коде',        // Cyrillic standalone — guards the ASCII \b trap
    'мерж ветки',
    'скрипт сломался',
  ];
  for (const t of dev) it(`dev: ${t}`, () => expect(isDevelopmentTask(t)).toBe(true));

  const notDev = [
    'какие скилы доступны?',
    'покажи отчёт по продажам за сентябрь',
    'отправь сообщение кандидату Иванову',
    'найди компанию по ИНН 7707083893',
    'сделай дайджест откликов',
    '/secrets_list',
    '',
    '   ',
  ];
  for (const t of notDev) it(`not dev: ${JSON.stringify(t)}`, () => expect(isDevelopmentTask(t)).toBe(false));

  it('DEV_TASK_RE is exported and stable', () => expect(DEV_TASK_RE).toBeInstanceOf(RegExp));
});

describe('engineering playbook family (software-engineering-playbooks)', () => {
  const familyStore = {
    resolve: id => (['feature', 'debugging', 'new-software'].includes(id) ? { id, version: 1, scope: 'system', source: 'sibling' } : null),
  };

  it('offers every family member that resolves, with a one-line hint each', () => {
    const section = buildDevPlaybookSuggestion({
      task: 'почини баг — бот не отправляет уведомление', profileId: 'alice', audience: 'default',
      store: familyStore, env: {},
    });
    for (const id of ['feature', 'debugging', 'new-software']) expect(section).toContain(`\`${id}\``);
    expect(section).toContain('playbook_run');
    expect(section).toContain('activate: true');
    expect(section).toMatch(/НЕ переспрашивай/);
    expect(section).toMatch(/не согласована/);
    expect(section).toMatch(/НЕ веди отдельный checklist\.md/);
    expect(section).not.toMatch(/НИКОГДА не запускай/);
  });

  it('lists only the members that resolve', () => {
    const partial = { resolve: id => (['feature', 'debugging'].includes(id) ? { id } : null) };
    const section = buildDevPlaybookSuggestion({
      task: 'сделай фичу: экспорт', profileId: 'alice', audience: 'default', store: partial, env: {},
    });
    expect(section).toContain('`debugging`');
    expect(section).not.toContain('`new-software`');
  });

  it('is empty when the default family playbook is not available', () => {
    expect(buildDevPlaybookSuggestion({
      task: 'сделай фичу: экспорт', profileId: 'alice', audience: 'default', store: unavailableStore, env: {},
    })).toBe('');
  });
});

describe('buildDevPlaybookSuggestion boundaries', () => {
  it('returns the offer for a dev task when the playbook resolves', () => {
    const section = buildDevPlaybookSuggestion({
      task: 'поставь изменение X', profileId: 'alice', audience: 'default',
      store: availableStore, env: { AUDIENCE_DEFAULT_PLAYBOOK: JSON.stringify({ default: 'development' }) },
    });
    expect(section).toContain('development');
    // One entry point: playbook_run compiles directly; the legacy static view is not in the path.
    expect(section).not.toContain('ba_development_playbook');
    expect(section).toContain('playbook_run');
    expect(section).toContain('activate: true');
    expect(section).toMatch(/без согласия план не активируй/);
  });

  it('returns "" for a non-development task (prompt unchanged)', () => {
    expect(buildDevPlaybookSuggestion({
      task: 'покажи отчёт по продажам', profileId: 'alice', audience: 'default',
      store: availableStore, env: {},
    })).toBe('');
  });

  it('returns "" when the playbook is not available to the profile (opt-in-safe)', () => {
    expect(buildDevPlaybookSuggestion({
      task: 'поставь изменение X', profileId: 'alice', audience: 'default',
      store: unavailableStore, env: {},
    })).toBe('');
  });

  it('returns "" when DEV_PLAYBOOK_SUGGESTION=off', () => {
    expect(buildDevPlaybookSuggestion({
      task: 'поставь изменение X', profileId: 'alice', audience: 'default',
      store: availableStore, env: { DEV_PLAYBOOK_SUGGESTION: 'off' },
    })).toBe('');
  });

  it('uses generic playbook_run wording for a non-development audience default', () => {
    const store = { resolve: id => (id === 'freelance-project-spec' ? { id, version: 1, scope: 'system', source: 'system' } : null) };
    const section = buildDevPlaybookSuggestion({
      task: 'реализуй фичу', profileId: 'alice', audience: 'freelance',
      store, env: {},
    });
    expect(section).toContain('freelance-project-spec');
    expect(section).not.toContain('ba_development_playbook');
  });

  it('never throws when store.resolve throws', () => {
    const store = { resolve: () => { throw new Error('boom'); } };
    expect(() => buildDevPlaybookSuggestion({
      task: 'поставь изменение X', profileId: 'alice', audience: 'default', store, env: {},
    })).not.toThrow();
    expect(buildDevPlaybookSuggestion({
      task: 'поставь изменение X', profileId: 'alice', audience: 'default', store, env: {},
    })).toBe('');
  });
});

describe('recommended family member by task text', () => {
  const { recommendEngineeringPlaybook } = require('../../src/dev-task-playbook-suggestion');
  const familyStore = {
    resolve: id => (['feature', 'debugging', 'new-software'].includes(id) ? { id, version: 1, scope: 'system', source: 'sibling' } : null),
  };

  const bugs = [
    'еще бага. чат: -3814002203 не отвечает',
    'бот перестал присылать фото',
    'сервер упал',
    'в логах error при сохранении',
    'почини кнопку в новой фиче',
  ];
  for (const t of bugs) it(`debugging: ${t}`, () => expect(recommendEngineeringPlaybook(t)).toBe('debugging'));

  it('new-software for a from-scratch service', () =>
    expect(recommendEngineeringPlaybook('сделай новый сервис с нуля для оплаты')).toBe('new-software'));

  for (const t of ['реализуй экспорт в CSV', 'сделай фичу: напоминания', '']) {
    it(`no strong signal: ${JSON.stringify(t)}`, () => expect(recommendEngineeringPlaybook(t)).toBe(null));
  }

  it('a bug report gets an explicit debugging pick, not feature', () => {
    const section = buildDevPlaybookSuggestion({ task: 'еще бага: бот не отвечает в чате', store: familyStore, env: {} });
    expect(section).toContain('Для этой задачи: `debugging`');
    expect(section).not.toContain('самый частый случай');
  });

  it('no pick line when the recommended member does not resolve', () => {
    const noDebug = { resolve: id => (['feature', 'new-software'].includes(id) ? { id } : null) };
    const section = buildDevPlaybookSuggestion({ task: 'баг: бот не отвечает', store: noDebug, env: {} });
    expect(section).not.toContain('Для этой задачи');
  });
});
