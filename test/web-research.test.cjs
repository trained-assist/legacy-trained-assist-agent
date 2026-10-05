'use strict';
// web_research (99d-web-research.js) — исследование из интернета БЕЗ вложенного движка.
//
// Главный пин этого файла — регрессия на саму причину удаления hermes_web_research:
// тул не должен запускать ни одного движка. Вложенный spawn давал ~50% отказов с
// пустой ошибкой (оборванный MCP-вызов, причина съедена мостом), поэтому здесь
// проверяется не только поведение, но и отсутствие в модуле всей машинерии запуска.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const mod = require('../src/mcp-skills/tools/99d-web-research.js');
const { lastKeepaliveAt } = require('../src/mcp-keepalive');

const SERP = [
  { title: 'ИТС: УНФ 3.0.14', url: 'https://its.1c.ru/db/metod81/content/8009/hdoc', snippet: 'Ячеистые склады' },
  { title: 'v8.1c.ru: ячейки для склада', url: 'https://v8.1c.ru/metod/article/yacheyki-dlya-sklada-v-1s-unf.htm', snippet: '' },
];

// DuckDuckGo html markup as 99c-search-searxng's parseDdg expects it.
const DDG_HTML =
  '<div class="result"><a class="result__a" href="https://its.1c.ru/db/metod81/content/8009/hdoc">ИТС УНФ</a>' +
  '<a class="result__snippet" href="https://its.1c.ru/db/metod81/content/8009/hdoc">Ячеистые склады</a></div>';

const fakeSearch = async () => ({ engine: 'searxng', results: SERP });
const fakePages = async (urls) => urls.map(u => ({ url: u, markdown: `# ${u}\n\nтекст страницы` }));

// ── 1. Никакого вложенного движка ─────────────────────────────────────────────
test('the module spawns no engine: no runner, no engine command, no nested hermes', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'mcp-skills', 'tools', '99d-web-research.js'), 'utf8');
  for (const bad of ['runEngineProcess', 'buildEngineCommand', 'hermesRunWithTools', 'hermes-tools-run', 'HERMES_DEPTH', 'child_process']) {
    assert.doesNotMatch(src, new RegExp(bad), `99d-web-research.js must not reference ${bad}`);
  }
});

test('the registry no longer exposes hermes_web_research, and web_research is mounted', () => {
  const registry = require('../src/mcp-skills/registry.js');
  const names = registry.listAllTools().map(t => t.name);
  assert.ok(!names.includes('hermes_web_research'), 'hermes_web_research is gone');
  assert.ok(names.includes('web_research'), 'web_research is mounted');
  // The anti-recursion floor existed only because the tool spawned an engine.
  assert.equal(registry.moduleHidden, undefined, 'moduleHidden is gone with the nested run');
});

// ── 2. Запрос ───────────────────────────────────────────────────────────────
test('queryFromTask takes the first sentence and caps it', () => {
  assert.equal(mod.queryFromTask(''), '');
  assert.equal(mod.queryFromTask('   '), '');
  // The split is on sentence end («. »): «3.0.14.» ends the sentence because the
  // period is followed by a space — pinned so a change here is a decision.
  assert.equal(mod.queryFromTask('Исследуй УНФ 3.0.14. Ответь по пунктам: 1) склад 2) маркировка'), 'Исследуй УНФ 3.0.14.');
  assert.equal(mod.queryFromTask('Какие типовые документы УНФ подходят для заявки на комплектацию? Нужны ссылки'),
    'Какие типовые документы УНФ подходят для заявки на комплектацию?');
  assert.equal(mod.queryFromTask('Одна фраза без точки'), 'Одна фраза без точки');
  const long = 'x'.repeat(400);
  assert.equal(mod.queryFromTask(long).length, 160);
});

// ── 3. grounded ─────────────────────────────────────────────────────────────
test('isGrounded: a real http(s) link counts, a prose label does not', () => {
  assert.equal(mod.isGrounded({ results: [{ url: 'https://its.1c.ru/x' }] }), true);
  assert.equal(mod.isGrounded({ pages: [{ url: 'http://example.com' }] }), true);
  assert.equal(mod.isGrounded({ results: [{ url: 'Deepgram documentation' }] }), false);
  assert.equal(mod.isGrounded({}), false);
  assert.equal(mod.isGrounded(null), false);
});

// ── 4. Сбор материала ───────────────────────────────────────────────────────
test('gather: SERP + top-N pages, clipped to `pages`', async () => {
  const b = await mod.gather({ query: 'УНФ', num: 8, pages: 1, maxChars: 1000, searchImpl: fakeSearch, fetchPagesImpl: fakePages });
  assert.equal(b.engine, 'searxng');
  assert.equal(b.results.length, 2);
  assert.equal(b.pages.length, 1, 'only the requested number of pages is fetched');
  assert.equal(b.pages[0].url, SERP[0].url);
  assert.equal(b.grounded, undefined, 'grounded is the handler\'s call, not gather\'s');
});

test('gather: pages=0 skips the fetch entirely', async () => {
  let called = false;
  const b = await mod.gather({
    query: 'УНФ', num: 8, pages: 0, maxChars: 1000,
    searchImpl: fakeSearch,
    fetchPagesImpl: async () => { called = true; return []; },
  });
  assert.equal(called, false);
  assert.equal(b.pages.length, 0);
});

test('gather: a failed page fetch is reported per page, never thrown', async () => {
  const b = await mod.gather({
    query: 'УНФ', num: 8, pages: 2, maxChars: 1000,
    searchImpl: fakeSearch,
    fetchPagesImpl: async () => ({ engine: 'exa', error: 'HTTP 429 rate-limited' }),
  });
  assert.equal(b.pages.length, 1);
  assert.match(b.pages[0].error, /429/);
});

test('collectSerp falls back to Exa when the keyless chain fails, and never throws', async () => {
  const saved = process.env.EXA_MCP_URL;
  // A dead local port: the fallback fails in milliseconds instead of reaching the
  // real network (a laptop with egress would otherwise make this test slow and flaky).
  process.env.EXA_MCP_URL = 'http://127.0.0.1:9/mcp';
  try {
    const out = await mod.collectSerp('УНФ', 8, {
      fetchImpl: async () => ({ status: 429, headers: { get: () => '' }, text: async () => '' }),
    });
    assert.equal(out.engine, null, 'both backends down → no engine claimed');
    assert.ok(out.reason && out.reason.length > 0, 'a stated reason instead of silence');
  } finally {
    if (saved === undefined) delete process.env.EXA_MCP_URL; else process.env.EXA_MCP_URL = saved;
  }
});

// ── 5. Keepalive: инвариант, который не был покрыт ──────────────────────────
// Раньше тест проверял только, что env-переменная ПЕРЕДАНА движку. Ничто не проверяло,
// что во время долгого вызова mtime keepalive реально двигается — а именно это спасает
// родительский прогон от 5-минутного inactivity-kill (claude-runner.js:1088).
test('the handler keeps the run alive while it works (watchdog invariant)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-research-ka-'));
  const file = path.join(dir, 'ka');
  const saved = {
    ka: process.env.AGENT_KEEPALIVE_FILE,
    exa: process.env.EXA_MCP_URL,
    chain: process.env.FREE_SEARCH_BACKEND,
    ddg: process.env.FREE_SEARCH_DDG_COOLDOWN_MS,
    sx: process.env.FREE_SEARCH_SEARXNG_COOLDOWN_MS,
    brave: process.env.FREE_SEARCH_BRAVE_COOLDOWN_MS,
  };
  process.env.AGENT_KEEPALIVE_FILE = file;
  process.env.EXA_MCP_URL = 'http://127.0.0.1:9/mcp';
  // Hermetic: one backend, cooldowns off (a previous test in this file deliberately
  // burns the chain's budget — 99c-search-searxng remembers that in module state, and a
  // cooled-down backend short-circuits WITHOUT calling fetch, which would silently make
  // this test assert nothing).
  process.env.FREE_SEARCH_BACKEND = 'duckduckgo';
  for (const k of ['FREE_SEARCH_DDG_COOLDOWN_MS', 'FREE_SEARCH_SEARXNG_COOLDOWN_MS', 'FREE_SEARCH_BRAVE_COOLDOWN_MS']) {
    process.env[k] = '0';
  }
  try {
    let freshDuringCall = false;
    let calls = 0;
    const r = await mod.tools.web_research.handler({
      query: 'УНФ 3.0.14',
      pages: 1,
      num: 8,
      max_chars: 1000,
      // A slow fetch proves the file is touched DURING the call, not only before it.
      fetchImpl: async () => {
        calls++;
        await new Promise(res => setTimeout(res, 60));
        freshDuringCall = lastKeepaliveAt(file) > Date.now() - 5000;
        return { status: 200, headers: { get: () => 'text/html' }, text: async () => DDG_HTML };
      },
    });
    assert.ok(calls > 0, 'the injected fetch really was used');
    assert.equal(freshDuringCall, true, 'keepalive file is fresh while the tool is in flight');
    assert.equal(r.grounded, true, 'a real SERP link grounds the bundle');
    assert.ok(r.saved_to && fs.existsSync(r.saved_to), 'the bundle is saved to disk');
  } finally {
    const restore = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    restore('AGENT_KEEPALIVE_FILE', saved.ka);
    restore('EXA_MCP_URL', saved.exa);
    restore('FREE_SEARCH_BACKEND', saved.chain);
    restore('FREE_SEARCH_DDG_COOLDOWN_MS', saved.ddg);
    restore('FREE_SEARCH_SEARXNG_COOLDOWN_MS', saved.sx);
    restore('FREE_SEARCH_BRAVE_COOLDOWN_MS', saved.brave);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty query is a bad_request, not a silent empty bundle', async () => {
  const r = await mod.tools.web_research.handler({ query: '   ' });
  assert.equal(r.error, 'bad_request');
});
