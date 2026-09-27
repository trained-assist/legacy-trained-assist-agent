// Regression tests for the /hh/review reject flow (issue: массовый отказ).
//   Bug 1 — rejection must use discard_by_employer ("Не подходит") on an open
//           vacancy, never discard_vacancy_closed ("Вакансия закрыта").
//   Bug 3 — ОТКЛОНИТЬ cards must show the fixed standard text, never the LLM draft.
//   Bug 4 — a reply after rejection must be synced and surfaced on the page.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { REJECT_REASON_ACTION, REJECTION_GREETING, standardRejectionText } = require('../../src/domains/hh/lib').hhLib('hh-rejection');
const { createHhNegotiations, HH_DISCARD_ACTIONS } = require('../../src/domains/hh/lib').hhLib('hh-negotiations');
const { generateReviewPageHtml } = require('../../src/domains/hh/lib').hhLib('hh-review-page-html');
const { createMockHhServer } = require('../helpers/mock-hh-server');

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hh-reject-flow-'));

describe('standard rejection', () => {
  it('rejects an open vacancy with discard_by_employer', () => {
    expect(REJECT_REASON_ACTION).toBe('discard_by_employer');
  });

  it('builds a name-aware standard text from one source', () => {
    expect(standardRejectionText('Полина')).toBe('Полина, здравствуйте! ' + REJECTION_GREETING);
    expect(standardRejectionText('')).toBe('Здравствуйте! ' + REJECTION_GREETING);
  });
});

describe('review page ОТКЛОНИТЬ cards', () => {
  it('renders the standard rejection, not the stored LLM draft', () => {
    const root = mkTmp();
    const username = 'reject-page-u1';
    const candDir = path.join(root, 'hh', username, 'candidates');
    fs.mkdirSync(candDir, { recursive: true });
    fs.writeFileSync(path.join(candDir, '5570000001.json'), JSON.stringify({
      messages: [],
      ats_result: {
        score: 1.2,
        verdict: 'ОТКЛОНИТЬ',
        draft_message: 'Уважаемый(ая) [Имя кандидата], ваш опыт заинтересовал нас, расскажите про AUM',
      },
    }));
    const neg = {
      id: '5570000001',
      created_at: '2026-09-16T10:00:00+03:00',
      updated_at: '2026-09-16T10:00:00+03:00',
      counters: { unread_messages: 0, messages: 1 },
      resume: { first_name: 'Полина', last_name: 'Куликова', title: 'Финансовый советник', alternate_url: 'https://hh.ru/resume/x' },
      _state: 'response',
    };
    try {
      const html = generateReviewPageHtml([neg], 'Vac', username, '', root, { vacancyId: 'v1' });
      expect(html).not.toContain('[Имя кандидата]');
      expect(html).not.toContain('заинтересовал');
      expect(html).toContain('Полина, здравствуйте!');
      expect(html).toContain(REJECTION_GREETING);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('shows a rejected candidate who replied after rejection', () => {
    const root = mkTmp();
    const username = 'reject-page-u2';
    const candDir = path.join(root, 'hh', username, 'candidates');
    fs.mkdirSync(candDir, { recursive: true });
    fs.writeFileSync(path.join(candDir, '5558672245.json'), JSON.stringify({
      messages: [
        { role: 'employer', text: 'Спасибо за отклик', timestamp: '2026-09-16T14:20:00+03:00' },
        { role: 'applicant', text: 'почему?', timestamp: '2026-09-16T14:51:00+03:00' },
      ],
    }));
    const discarded = [{
      id: '5558672245',
      created_at: '2026-09-10T10:00:00+03:00',
      updated_at: '2026-09-16T14:51:00+03:00',
      counters: { unread_messages: 1, messages: 3 },
      resume: { first_name: 'Илья', last_name: 'Петров', title: 'Разработчик', alternate_url: 'https://hh.ru/resume/y' },
      _state: 'discard',
    }];
    try {
      const html = generateReviewPageHtml([], 'Vac', username, '', root, { vacancyId: 'v1', discarded });
      expect(html).toContain('Ответили после отказа');
      expect(html).toContain('ответил после отказа');
      expect(html).toContain('почему?');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('discard-stage message sync', () => {
  it('queries the action-named discard collections, not a generic /negotiations/discard', () => {
    // HH has no `/negotiations/discard` (404) — rejections live in the collection
    // named after the action. Both actions the system can produce must be covered.
    expect(HH_DISCARD_ACTIONS).toEqual(['discard_by_employer', 'discard_vacancy_closed']);
  });

  it('unions replies from both discard actions and stores the post-rejection reply', async () => {
    const mkNeg = (id, stateId) => ({
      id,
      state: { id: stateId },
      vacancy_id: 'vac-001',
      created_at: '2026-09-16T14:20:00+03:00',
      updated_at: new Date().toISOString(),
      counters: { messages: 2, unread_messages: 1 },
      resume: { id: 'res-' + id, first_name: 'Илья', last_name: 'Петров' },
    });
    const srv = createMockHhServer({
      negotiations: [mkNeg('neg-d1', 'discard_by_employer'), mkNeg('neg-d2', 'discard_vacancy_closed')],
    });
    await srv.start();
    const prevBase = process.env.HH_API_BASE_URL;
    process.env.HH_API_BASE_URL = srv.baseUrl;
    srv.state.discarded.add('neg-d1');
    srv.state.rejectActions['neg-d1'] = 'discard_by_employer';
    srv.state.discarded.add('neg-d2');
    srv.state.rejectActions['neg-d2'] = 'discard_vacancy_closed';
    srv.state.messages['neg-d1'] = [
      { text: 'Спасибо за отклик', role: 'employer' },
      { text: 'почему?', role: 'applicant' },
    ];
    const root = mkTmp();
    try {
      // The generic path must be a 404 on real HH — guard against re-introducing it.
      const generic = await fetch(`${srv.baseUrl}/negotiations/discard?vacancy_id=vac-001&per_page=50&page=0`);
      expect(generic.status).toBe(404);

      const hh = createHhNegotiations({ refreshHhToken: async () => null, readChatId: () => {}, getSecretsCache: () => ({}) });
      const discarded = await hh.fetchDiscardedNegotiations('vac-001', 'tok');
      expect(discarded.map(n => n.id).sort()).toEqual(['neg-d1', 'neg-d2']);

      await hh.syncHhMessagesToHistory(root, 'discard-u1', discarded, 'tok', { incremental: false, cap: 5 });
      const hist = JSON.parse(fs.readFileSync(path.join(root, 'hh', 'discard-u1', 'candidates', 'neg-d1.json'), 'utf8'));
      expect(hist.messages.map(m => m.role)).toEqual(['employer', 'applicant']);
      expect(hist.messages[hist.messages.length - 1].text).toBe('почему?');
    } finally {
      await srv.stop();
      if (prevBase === undefined) delete process.env.HH_API_BASE_URL; else process.env.HH_API_BASE_URL = prevBase;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
