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
// Defaulting engine to 'claude' gets Hermes real web search for free, with zero
// new external credentials, instead of standing up a paid search-API integration.

const fs = require('fs');
const path = require('path');
const os = require('os');

const { writeMcpConfig } = require('./browser');
const { buildEngineCommand, runEngineProcess } = require('./runner/claude-runner');
const { parseLlmJson } = require('./llm-client');
const { loadUserTokens } = require('./user-tokens');
const { getDefaultSourceRuntime } = require('./mcp-source-runtime');

function hermesWorkDir(username) {
  const dir = path.join(os.homedir(), 'agent-tokens', String(username), 'hermes-tmp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function buildPrompt(task, context, outputSchema) {
  const schemaHint = JSON.stringify(outputSchema, null, 2);
  return (
    'Ты — Hermes, исследовательский воркер внутри trained-assist. У тебя есть доступ к ' +
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
async function hermesRunWithTools({ username, task, context = '', outputSchema, engine = 'claude', taskId }) {
  if (!task || !task.trim()) throw new Error('hermesRunWithTools: task обязателен');
  if (!outputSchema) throw new Error('hermesRunWithTools: outputSchema обязателен — Hermes всегда возвращает структурированный JSON');
  if (!username) throw new Error('hermesRunWithTools: username обязателен — нужен для скоупа .mcp.json и токенов');

  const workDir = hermesWorkDir(username);
  const id = taskId || `hermes-tools-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Host MCP source runtime (PR2b, issue #1358) — same inert-by-default wiring as
  // runner/index.js: no-op unless MCP_SKILL_SOURCES_CONFIG names an enabled source.
  const sourceRuntime = getDefaultSourceRuntime();
  let sourceRun = null;
  if (sourceRuntime.enabled) {
    try {
      sourceRun = await sourceRuntime.prepareRun({
        hostRunBinding: {
          engineRunId: id, rootTaskId: id, profileId: username,
          projectId: null, trigger: 'system', origin: 'mcp', resourceBindingVersion: 'v1',
        },
        runtimeDir: path.join(workDir, '.mcp-runs', id),
      });
    } catch (e) { console.warn('[hermes-tools-run] mcp source runtime prepareRun:', e.message); }
  }

  const mcpConfig = writeMcpConfig(workDir, username, { extraServers: sourceRun?.servers });
  const prompt = buildPrompt(task, context, outputSchema);
  const [engineBin, engineArgs] = buildEngineCommand({ engine, prompt, mcpConfig });

  const { ANTHROPIC_API_KEY: _stripped, ...cleanEnv } = process.env;
  const userTokens = loadUserTokens(username, username);

  let result;
  try {
    result = await runEngineProcess({
      engine,
      taskId: id,
      chatId: 'hermes',
      thinkingStart: Date.now(),
      msgId: null, // no Telegram message to edit — keeps this fully headless
      BOT_TOKEN: '',
      secrets: {},
      user: { username, id: username, name: username, cwd: workDir, workDir },
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
    });
  } finally {
    if (sourceRun) sourceRun.release();
  }

  const text = result.claudeResult || result.lastAssistantMsg || result.fullOutput?.text || '';
  if (!text.trim()) {
    throw new Error(
      `hermesRunWithTools: пустой ответ от ${engine} (exitCode=${result.exitCode}, ` +
      `timedOut=${result.timedOut}, processError=${result.processError || 'none'})`
    );
  }
  return parseLlmJson(text);
}

module.exports = { hermesRunWithTools };
