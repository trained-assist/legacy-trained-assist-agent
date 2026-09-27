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
  resolve: id => (id === 'feature' ? { id, version: 1, scope: 'system', source: 'sibling' } : null),
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

describe('buildDevPlaybookSuggestion boundaries', () => {
  it('returns the offer for a dev task when the playbook resolves', () => {
    const section = buildDevPlaybookSuggestion({
      task: 'поставь изменение X', profileId: 'alice', audience: 'default',
      store: availableStore, env: {},
    });
    expect(section).toContain('`feature`');
    expect(section).toContain('playbook_run');
    expect(section).toMatch(/НЕ запускай|не запускай/);
    expect(section).toContain('task_update status=active');
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
    expect(section).not.toContain('Инженерные плейбуки');
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

describe('engineering playbook choice by task wording', () => {
  const all = { resolve: id => (['feature', 'debugging', 'new-software'].includes(id) ? { id, version: 1 } : null) };
  const opts = { profileId: 'alice', audience: 'default', env: {} };

  it('a bug report offers the debugging playbook', () => {
    const section = buildDevPlaybookSuggestion({ ...opts, task: 'почини баг — бот не отправляет уведомление', store: all });
    expect(section).toContain('playbook_run(playbook_id: "debugging"');
  });

  it('a from-scratch service offers new-software', () => {
    const section = buildDevPlaybookSuggestion({ ...opts, task: 'разработай новый сервис с нуля для транскрибации', store: all });
    expect(section).toContain('playbook_run(playbook_id: "new-software"');
  });

  it('a plain change offers feature', () => {
    const section = buildDevPlaybookSuggestion({ ...opts, task: 'реализуй экспорт в CSV', store: all });
    expect(section).toContain('playbook_run(playbook_id: "feature"');
  });

  it('falls back to feature when the specific playbook is not available', () => {
    const section = buildDevPlaybookSuggestion({ ...opts, task: 'почини баг в экспорте', store: availableStore });
    expect(section).toContain('playbook_run(playbook_id: "feature"');
  });
});
