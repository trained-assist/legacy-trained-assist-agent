'use strict';

// Hermes Phase 1.5 (docs/HERMES-INTEGRATION-CHECKLIST.md) — tool-augmented worker.
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
// would duplicate that, and for web search specifically there is no self-hosted
// search API in this repo — only Claude Code's own built-in WebSearch tool.
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

function buildPrompt(task, context, outputSchema) {
  const schemaHint = JSON.stringify(outputSchema, null, 2);
  return (
    'Ты — Hermes, исследовательский воркер внутри trained-assist. Только исследуй и подготовь ' +
    'отчёт со ссылками (file:line или URL). Ничего не коммить, не открывай PR и не отмечай ' +
    'чек-листы. У тебя есть доступ к ' +
    'инструментам (Playwright-браузер, встроенный веб-поиск/фетч, внутренние MCP-скилы) — ' +
    'инструментам (Playwright-браузер, встроенный веб-поиск/фетч, внутренние MCP-скилы) — ' +
    'используй их, чтобы реально выполнить задачу (сходить в сеть, открыть страницы, найти ' +
    'источники), а не отвечать по памяти. Заверши работу и выведи ПОСЛЕДНИМ сообщением ТОЛЬКО ' +
    'валидный JSON по схеме ниже — без markdown-обёртки, без пояснений вне JSON.\n\n' +
    `Задача:\n${task}\n\nКонтекст:\n${context || '(не задан)'}\n\n` +
    `Схема ответа (JSON Schema):\n${schemaHint}`
  );
}

/**
 * hermesRunWithTools — Hermes-задача, которой нужен реальный интернет (браузер/поиск),
 * не только текст в контексте. Спавнит scoped headless CLI-сессию (по умолчанию claude —
 * единственный движок с встроенным WebSearch) с уже существующим per-user `.mcp.json`,
 * без Telegram-стрима/строки в session-store/pending-task журнале.
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
  const hermesDepth = (Number.parseInt(process.env.HERMES_DEPTH || '0', 10) || 0) + 1;
  const { mcpConfig, servers: bridgedServers } = writeRunMcpConfig(
    workDir, username, { extraEnv: { HERMES_DEPTH: String(hermesDepth) } },
    { bridged: isolationConfig().envAllowlist });
  const prompt = buildPrompt(task, context, outputSchema);
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

module.exports = { hermesRunWithTools };
