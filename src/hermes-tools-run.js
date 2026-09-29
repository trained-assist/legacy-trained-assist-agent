'use strict';

// Hermes Phase 1.5 — tool-augmented worker.
// hermesRun() (hermes-run.js) is a single raw LLM call with ZERO tools: it can't
// browse, fetch, or search. hermesRunWithTools() instead spawns a scoped, headless
// CLI-engine invocation (claude/codex/opencode) reusing the SAME per-user
// `.mcp.json` every normal session already gets (writeMcpConfig in browser.js —
// playwright + trained-skills MCP servers), with no Telegram/session coupling.
//
// Why this shape, not a bespoke tool-calling loop against OpenRouter/GigaChat:
// the Playwright MCP server and every trained-skills tool (ru_browser_fetch,
// website_request, company/INN lookups, etc.) already exist and are already
// wired for claude/codex/opencode (see fix/mcp-codex-opencode-gap, PR #1040).
// Re-implementing browser automation + a function-calling loop from scratch
// would duplicate that.
//
// Web search (triage 2026-09-28): every engine reaches it differently —
//   claude    → built-in WebSearch/WebFetch, always there;
//   opencode  → built-in `websearch` EXCEPT it is only registered for the
//               `opencode`/`opencode-go` providers or with OPENCODE_ENABLE_EXA,
//               which runEngineProcess now sets for every opencode run;
//   codex     → neither, so it gets search only through trained-skills tools.
// That mismatch is why research used to come back with zero URLs while the prompt
// promised a search tool: never describe an instrument in the prompt that the
// resolved engine does not actually have — say so plainly instead (buildPrompt).
//
// Search ladder (2026-09-28, #1792): level 1 is OURS — `search_serp_free`
// (src/mcp-skills/tools/99c-search-searxng.js, no key, no quota). It runs in this
// server process before the engine even starts, so the model always receives a real
// SERP in the prompt regardless of what search the engine exposes. Level 2 = the
// engine's built-in websearch, level 3 = fetch/browser for a concrete URL.
//
// Research runs on the Gemini-backed OpenCode ladder. Set HERMES_RESEARCH_ENGINE=claude
// for the temporary rollback path.

const fs = require('fs');
const path = require('path');

const { writeRunMcpConfig } = require('./browser');
const { isolationConfig } = require('./agent-isolation');
const { userWorkDir } = require('./data-paths');
const { buildEngineCommand, runEngineProcess } = require('./runner/claude-runner');
const { parseLlmJson } = require('./llm-client');
const { loadUserTokens } = require('./user-tokens');
const ocLadder = require('./opencode-ladder-provider');

// Inside the profile workspace, not the tokens dir (issue #1649): the engine's cwd
// must never be a place that holds the profile's credential files.
function hermesWorkDir(username) {
  const dir = path.join(userWorkDir(username), 'hermes-tmp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Level 1: keyless search, run here before the engine starts ───────────────

// A research task is free text, not a query — take its first sentence and cap it.
function searchQueryFromTask(task) {
  const flat = String(task || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const first = flat.split(/(?<=[.!?…])\s+/)[0] || flat;
  return first.slice(0, 160).trim();
}

/**
 * Run `search_serp_free` once against the task and return the SERP for the prompt.
 * Never throws and never fails the research run: a blocked/slow upstream comes back
 * as { results: [], reason } so buildPrompt can say "level 1 is down, go to level 2".
 * `fetchImpl` is a test seam (see test/hermes-search-first-level.test.cjs).
 */
async function prefetchLevel1(task, { fetchImpl } = {}) {
  const query = searchQueryFromTask(task);
  if (!query || process.env.HERMES_PREFETCH_SEARCH === '0') return null;
  try {
    const { tools } = require('./mcp-skills/tools/99c-search-searxng');
    const handler = tools && tools.search_serp_free && tools.search_serp_free.handler;
    if (typeof handler !== 'function') return null;
    const out = await handler({ query, num: 8 }, fetchImpl ? { fetchImpl } : {});
    if (out && Array.isArray(out.results) && out.results.length) return { query, results: out.results };
    return { query, results: [], reason: (out && (out.message || out.error)) || 'пустая выдача' };
  } catch (e) {
    return { query, results: [], reason: (e && e.message) || 'search failed' };
  }
}

function formatLevel1(level1) {
  if (!level1) return '';
  if (level1.results.length) {
    const rows = level1.results
      .map((r, i) => `${i + 1}. ${r.title} — ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
      .join('\n');
    return (
      'УРОВЕНЬ 1 — предварительный поиск уже сделан за тебя (search_serp_free, запрос «' +
      `${level1.query}»), ${level1.results.length} результатов:\n${rows}\n\n`
    );
  }
  return (
    `УРОВЕНЬ 1 — предварительный поиск search_serp_free не дал результатов: ${level1.reason}. ` +
    'Не выдумывай источники — переходи на УРОВЕНЬ 2 (встроенный веб-поиск) и дальше открывай страницы.\n\n'
  );
}

function buildPrompt(task, context, outputSchema, level1 = null) {
  const schemaHint = JSON.stringify(outputSchema, null, 2);
  return (
    'Ты — Hermes, исследовательский воркер внутри trained-assist. Только исследуй и подготовь ' +
    'отчёт со ссылками (file:line или URL). Ничего не коммить, не открывай PR и не отмечай ' +
    'чек-листы.\n\n' +
    // Never claim an instrument the resolved engine may not have. Before 2026-09-28 this
    // promised «встроенный веб-поиск» unconditionally — opencode had no such tool — so the
    // model never complained about the missing search, it just invented sources.
    'Порядок инструментов (уровни):\n' +
    '1) search_serp_free (MCP trained-skills, ключей и квот не требует) — ОСНОВНОЙ поиск: ' +
    'все поисковые запросы, включая уточняющие, делай им. Если предварительного поиска ниже ' +
    'нет — сделай один пробный вызов поиска, прежде чем решить, что живых данных нет.\n' +
    '2) Встроенный веб-поиск движка (websearch/WebSearch) — только если уровень 1 вернул ' +
    'ошибку или мало полезного.\n' +
    '3) Загрузка страниц и браузер (Playwright MCP) — когда нужен конкретный URL или ' +
    'содержимое страницы.\n' +
    'Если поиск недоступен — НЕ ВЫДУМЫВАЙ источники: явно напиши, что живых данных нет, ' +
    'и опирайся только на то, что реально удалось открыть.\n\n' +
    formatLevel1(level1) +
    'Ссылки обязаны быть настоящими: URL из поисковой выдачи или страницы, которую ты ' +
    'открыл. Каждое неочевидное утверждение подкрепи полем `sources` (title + url + quote). ' +
    'Пустой `sources` при наличии утверждений означает, что research не состоялся.\n\n' +
    'Работай инструментами (найди в поиске, открой страницы, сведи источники), а не по ' +
    'памяти. Заверши работу и выведи ПОСЛЕДНИМ сообщением ТОЛЬКО валидный JSON по схеме ' +
    'ниже — без markdown-обёртки, без пояснений вне JSON.\n\n' +
    `Задача:\n${task}\n\nКонтекст:\n${context || '(не задан)'}\n\n` +
    `Схема ответа (JSON Schema):\n${schemaHint}`
  );
}

/**
 * hermesRunWithTools — Hermes-задача, которой нужен реальный интернет (поиск/браузер),
 * не только текст в контексте. Спавнит scoped headless CLI-сессию (по умолчанию opencode
 * с профилем `research`, см. runEngineProcess → OPENCODE_ENABLE_EXA) с уже существующим
 * per-user `.mcp.json`, без Telegram-стрима/строки в session-store/pending-task журнале.
 */
async function hermesRunWithTools({ username, task, context = '', outputSchema, engine = null, ocProfile = null, taskId }) {
  if (!task || !task.trim()) throw new Error('hermesRunWithTools: task обязателен');
  if (!outputSchema) throw new Error('hermesRunWithTools: outputSchema обязателен — Hermes всегда возвращает структурированный JSON');
  if (!username) throw new Error('hermesRunWithTools: username обязателен — нужен для скоупа .mcp.json и токенов');

  const workDir = hermesWorkDir(username);
  const id = taskId || `hermes-tools-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Stamp the nested run's depth into the MCP servers' env (browser.js extraEnv). The
  // server side (100-hermes.js) refuses to launch a Hermes from inside a Hermes, which
  // gives the self-reproducing chain (hermes_research → engine → hermes_research → …)
  // a hard floor. Without it a nested engine sees hermes_research again and re-spawns.
  // The same stamp makes registry.js drop the whole hermes tool module, so a nested run
  // cannot even SEE hermes_research — the refusal is only the second line of defence.
  const hermesDepth = (Number.parseInt(process.env.HERMES_DEPTH || '0', 10) || 0) + 1;
  const { mcpConfig, servers: bridgedServers } = writeRunMcpConfig(
    workDir, username,
    { extraEnv: { HERMES_DEPTH: String(hermesDepth) }, siblings: false },
    { bridged: isolationConfig().envAllowlist });
  // Level 1 runs HERE (server process, no isolation/env-allowlist concerns) so the model
  // starts from a real SERP even when the engine's own search is missing or rate-limited.
  const level1 = await prefetchLevel1(task);
  const prompt = buildPrompt(task, context, outputSchema, level1);
  const resolvedEngine = engine || process.env.HERMES_RESEARCH_ENGINE || 'opencode';
  const resolvedProfile = ocProfile || (resolvedEngine === 'opencode' ? 'research' : null);
  const ocProfileOverrides = resolvedEngine === 'opencode'
    ? ocLadder.buildOcProfileOverrides(resolvedProfile) : null;
  const [engineBin, engineArgs] = buildEngineCommand({ engine: resolvedEngine, ocProfile: resolvedProfile, ocRole: 'explore', prompt, mcpConfig, opencodeModel: ocProfileOverrides?.agent?.explore?.model });

  const { ANTHROPIC_API_KEY: _stripped, ...cleanEnv } = process.env;
  const userTokens = loadUserTokens(username, username);

  const result = await runEngineProcess({
    engine: resolvedEngine,
    taskId: id,
    chatId: 'hermes',
    thinkingStart: Date.now(),
    msgId: null, // no Telegram message to edit — keeps this fully headless
    BOT_TOKEN: '',
    secrets: {},
    // The profile workspace is the isolation gate; hermes-tmp is only the cwd inside it.
    user: { username, id: username, name: username, cwd: workDir, workDir: userWorkDir(username) },
    cleanEnv,
    userTokens,
    sessionFilePath: null,
    restartShutdown: () => false,
    activeTimers: new Map(),
    tgEdit: async () => {},
    tgSend: async () => {},
    outputCallback: null,
    engineBin,
    engineArgs,
    cwd: workDir,
    env: cleanEnv,
    mcpConfig,
    ocProfileOverrides,
    bridgedServers,
  });

  const text = result.claudeResult || result.lastAssistantMsg || result.fullOutput?.text || '';
  if (!text.trim()) {
    throw new Error(
      `hermesRunWithTools: пустой ответ от ${resolvedEngine} (exitCode=${result.exitCode}, ` +
      `timedOut=${result.timedOut}, processError=${result.processError || 'none'})`
    );
  }
  return parseLlmJson(text);
}

module.exports = { hermesRunWithTools, buildPrompt, prefetchLevel1, searchQueryFromTask };
