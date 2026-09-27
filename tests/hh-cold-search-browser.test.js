import { it as vitestIt, expect } from 'vitest';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { hasChromium } = require('./helpers/has-chromium.cjs');
// Browser-only suite: skipped when Playwright Chromium isn't installed (CI installs it).
const it = vitestIt.skipIf(!hasChromium);
const { generateProactivePageHtml } = require('../src/domains/hh/lib').hhLib('hh-proactive-page');
it('browser switches vacancies and persists monitor/archive actions with the displayed vacancy ID', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); const errors = []; const actions = []; const states = {};
    page.on('pageerror', e => errors.push(e.message));
    await page.route('https://hh-fixture.test/**', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (request.method() === 'POST') {
        const body = request.postDataJSON(); actions.push(body);
        const patches = { enable: { enabled: true }, disable: { enabled: false }, archive: { archived: true, enabled: false }, restore: { archived: false }, star: { starred: true }, unstar: { starred: false } };
        states[body.vacancy_id] = { ...states[body.vacancy_id], ...patches[body.action] };
        await route.fulfill({ json: { ok: true } }); return;
      }
      const vacancyId = url.searchParams.get('vacancy_id') || 'A';
      await route.fulfill({ contentType: 'text/html', body: generateProactivePageHtml({ vacancy_title: 'Vacancy ' + vacancyId, candidates: [] }, 'user', 'https://hh-fixture.test', 'test-token', {}, {
        activeVacancies: [{ id: 'A', title: 'Vacancy A' }, { id: 'B', title: 'Vacancy B' }], vacancyId, monitoring: states[vacancyId] || {},
      }) });
    });
    await page.goto('https://hh-fixture.test/hh/proactive?vacancy_id=A');
    await page.locator('#nameSearch').fill('Designer');
    await page.getByTestId('monitor-toggle').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="monitor-toggle"]').textContent.includes('Отключить'));
    expect(await page.locator('#nameSearch').inputValue()).toBe('Designer');
    await page.locator('.vacancy-tab', { hasText: 'Vacancy B' }).click();
    expect(await page.locator('#nameSearch').inputValue()).toBe('');
    await page.locator('#nameSearch').fill('Sales');
    await page.getByTestId('monitor-toggle').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="monitor-toggle"]').textContent.includes('Отключить'));
    await page.getByTestId('vacancy-archive').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="vacancy-archive"]').textContent.includes('Вернуть'));
    await page.reload(); expect(await page.getByTestId('vacancy-monitoring').innerText()).toContain('вакансия в архиве');
    await page.locator('.vacancy-tab', { hasText: 'Vacancy A' }).click();
    expect(await page.locator('#nameSearch').inputValue()).toBe('Designer');
    expect(await page.getByTestId('monitor-toggle').innerText()).toContain('Отключить');
    expect(actions.map(a => [a.vacancy_id, a.action])).toEqual([['A', 'enable'], ['B', 'enable'], ['B', 'archive']]);
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
}, 20000);

it('late AI response cannot overwrite a newer modal; requests carry the displayed vacancy', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    let oldRoute, signalOld;
    const oldReady = new Promise(resolve => { signalOld = resolve; });
    const requests = [];
    await page.route('https://hh-fixture.test/**', async route => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON(); requests.push(body);
        if (body.candidate_id === 'old') { oldRoute = route; signalOld(); return; }
        return route.fulfill({ json: { evaluation: 'New evaluation' } });
      }
      await route.fulfill({ contentType: 'text/html', body: generateProactivePageHtml({ candidates: [] }, 'user', 'https://hh-fixture.test', 'token', {}, { vacancyId: 'A' }) });
    });
    await page.goto('https://hh-fixture.test/hh/proactive?vacancy_id=A');
    await page.evaluate(() => openAiModal('old', 'Old'));
    await oldReady;
    await page.evaluate(() => openAiModal('new', 'New'));
    await page.waitForFunction(() => document.getElementById('modalBody').textContent.includes('New evaluation'));
    await oldRoute.fulfill({ json: { evaluation: 'Stale evaluation' } });
    await page.waitForLoadState('networkidle');
    expect(await page.locator('#modalBody').innerText()).toContain('New evaluation');
    expect(requests.map(r => r.vacancy_id)).toEqual(['A', 'A']);
  } finally { await browser.close(); }
}, 15000);
