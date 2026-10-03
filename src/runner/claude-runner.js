'use strict';
// Engine process runner (issue #942 P1.3). Extracted from src/runner.js so the
// spawn → stream-json → timeout/close machinery is a self-contained, testable
// unit, independent of the task orchestration that lives in runner.js.
//
// Owns: building the engine argv (claude/codex/opencode), spawning the process,
// consuming stream-json stdout, progress editing (heartbeat/streaming/typing),
// and the 38min SIGTERM / 40min SIGKILL / 5min-inactivity lifecycle. Returns a
// structured result; runner.js decides retry/continuation/session policy on top.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { keepaliveFilePath, lastKeepaliveAt } = require('../mcp-keepalive');
const { prepareEngineSpawn } = require('./engine-isolation');
const { stopEngineProcess } = require('./engine-stop');
const traceStore = require('../session-trace-store');

const STREAM_INTERVAL_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 3000;
const STOP_BUTTON_AFTER_SECS = 0; // Controls belong to the launch status from its first edit.
const MAX_MSG_LEN = 3500;
const CLAUDE_TIMEOUT_MS = 40 * 60 * 1000; // 40 min hard limit

// Same running-task row on every progress edit: kill it (⛔) or feed it more
// context without waiting for it to finish (➕). Mirrors the web UI's
// Стоп/Дополнить pair (trained-assist-web#33) — the tg-bot's `sup|` callback
// handler owns the actual restart-with-supplement flow.
//
// Telegram caps callback_data at 64 BYTES and rejects the whole edit with
// 400 BUTTON_DATA_INVALID otherwise. Telegram taskIds are
// `<username>-tg-<64 hex>` (90+ bytes), so `stop|${taskId}` killed EVERY
// progress edit that carried these buttons — the "Думаю… (2с)" placeholder
// froze for the whole run and the bot looked dead (2026-09-25, flexi-consult).
// The tg-bot copies the key into stopok|/stopno|/supok|/supno| and stops by
// username, so it only needs a stable id, not the literal taskId: short ids
// pass through unchanged, long ones collapse to a deterministic hash.
const TG_CALLBACK_DATA_MAX_BYTES = 64;
const LONGEST_CONTROL_PREFIX = 'stopok|'; // longest prefix the tg-bot re-wraps the key in
function controlKey(taskId) {
  const id = String(taskId);
  if (Buffer.byteLength(LONGEST_CONTROL_PREFIX + id) <= TG_CALLBACK_DATA_MAX_BYTES) return id;
  return 'h' + require('crypto').createHash('sha256').update(id).digest('hex').slice(0, 24);
}
// «📜 Журнал» carries the session id the agent ACTUALLY ran on. The gateway's
// snapshot only knows the id it requested, and resolveChatSession may heal that
// onto another one (foreign chat, sign-split, pointer fallback) — a journal link
// built from the requested id opened a missing/wrong session in the web app.
// Old two-part buttons still work: the gateway falls back to the snapshot id.
function journalCallback(messageId, sessionId) {
  const withSession = `input_journal|${messageId}|${sessionId}`;
  return sessionId && /^[a-zA-Z0-9_.-]{1,128}$/.test(sessionId) && Buffer.byteLength(withSession) <= TG_CALLBACK_DATA_MAX_BYTES
    ? withSession : `input_journal|${messageId}`;
}
const inputInspectionRows = (messageId, sessionId = null) => messageId ? [[
  { text: '📋 Посмотреть input', callback_data: `input_run|${messageId}` },
  { text: '📜 Журнал', callback_data: journalCallback(messageId, sessionId) },
]] : [];
const runningControls = (taskId, inputMessageId = null, sessionId = null) => ({ reply_markup: { inline_keyboard: [[
  // «➕ Дополнить» на сообщении работающей задачи убрана (владелец 30.09,
  // решение №3; Ф3 плана рефакторинга, tg-bot#316): «сейчас очень плохо работает,
  // сверхнеудобно и коряво». Замена — стоп-опции на квитанции накопления шлюза
  // («🛑 Стоп и запуск с добавкой» / «⛔ Стоп → новая задача», RC-04/RC-05): решение
  // принимается там, где юзер реально видит накопленный ввод. Обработчики sup| на
  // стороне шлюза остаются для старых кнопок в истории (Ф6 выпилит).
  { text: '⛔ Стоп', callback_data: `stop|${controlKey(taskId)}` },
], ...inputInspectionRows(inputMessageId, sessionId)] } });
// progressEdit is best-effort+coalesced (see comment above `tgEdit` in
// tg-stream.js) — a 429 drop returns {ok:false}, a coalesce-skip returns
// {ok:true, skipped:true}. Either way the buttons did NOT reach the chat, so
// the "shown" flag must stay false and retry on the next tick.
const editLanded = result => !!(result && result.ok && !result.skipped);
const WARN_TIMEOUT_MS  = 38 * 60 * 1000; // 38 min — graceful SIGTERM + Telegram warning before hard kill
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 min silence → kill + auto-restart (all engines)
// Per-MCP-tool-call ceiling for every engine. Bounded by the 40-min hard limit anyway;
// the point is to stop engines' own short defaults (opencode 60s) from killing slow tools.
const MCP_TOOL_TIMEOUT_MS = 30 * 60 * 1000;

// OpenCode loop guard (#1583): a degraded model can enter an "active" loop where it
// keeps emitting output (so the inactivity kill never fires) but makes no real progress —
// e.g. narrating "Публикую доку через publish_page." and calling `echo "PUBLISHING"`
// ~270 times instead of invoking the actual MCP tool, until the 40-min timeout. Both
// inactivity (no output) and the wall-clock cap are blind to this, so we detect the
// repetition directly: the same assistant TEXT part (or the same tool+input pair) seen
// REPEAT_LIMIT times in a row is treated as a stuck loop and killed early with a clear
// error instead of burning the whole budget.
const LOOP_GUARD_REPEAT_LIMIT = 6;
const LOOP_GUARD_TEXT_MIN_LEN = 20; // ignore tiny echo fragments; count only meaningful repeats
// No-op streak (2026-09-29): a model that "wants" to call an MCP tool but can't emits
// bash placeholders that DIFFER from each other (`true`, `echo ok`, `echo done`,
// `python3 -c "print('x')"`) — the identical-signature guard above needs 6 equal calls
// in a row and let such a run spin ~5 min. Any NOOP_LIMIT consecutive no-op bash calls
// (nothing else in between) is the same stuck loop.
// 5→3 (2026-09-29): probes on the paid deepseek-v4-flash rung show that once 2 no-op calls
// are in the history the model repeats them 3/3 — waiting for the 5th only burns minutes.
const LOOP_GUARD_NOOP_LIMIT = 3;
// A bash command that can't do anything but print a short literal. Deliberately narrow:
// no pipes, redirects to files, `;`/`&&` chains or variables — those may be real work.
const NOOP_BASH_RE = /^(?:true|:|echo(?:\s+(?:"[^"$`]{0,40}"|'[^']{0,40}'|[\w.,!?-]{0,40}))?|python3?\s+-c\s+(?:"print\((?:'[^']{0,40}'|\d+)\)"|'print\((?:"[^"]{0,40}"|\d+)\)')|node\s+-e\s+'console\.log\((?:"[^"]{0,40}"|\d+)\)')(?:\s+2>&1)?$/;
function isNoopBash(tool, input) {
  if (tool !== 'bash') return false;
  const cmd = input && typeof input.command === 'string' ? input.command.trim() : null;
  if (cmd === null) return false;
  return cmd === '' || NOOP_BASH_RE.test(cmd);
}

// Per-run hard timeout (P3a durable step budget, `execution_timeout_seconds`).
// Clamped to the global cap so a step can only ever shorten, never extend, the
// engine's wall-clock budget. The graceful warning fires 2 min before the kill,
// floored at 30s so a very short budget still gets a warning beat. No option /
// a non-positive value keeps the historical fixed 40-min / 38-min pair.
// warnMs (optional, #1856 wrap_up): explicit graceful-signal moment for a short
// budget where «2 min before the kill» would fire almost immediately.
function computeEngineTimeoutMs(timeoutMs, warnMs = null) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { hardTimeoutMs: CLAUDE_TIMEOUT_MS, warnTimeoutMs: WARN_TIMEOUT_MS };
  }
  const hardTimeoutMs = Math.min(timeoutMs, CLAUDE_TIMEOUT_MS);
  const warnTimeoutMs = Number.isFinite(warnMs) && warnMs > 0 && warnMs < hardTimeoutMs
    ? warnMs
    : Math.max(30_000, hardTimeoutMs - 2 * 60 * 1000);
  return { hardTimeoutMs, warnTimeoutMs };
}

const TG_API = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');

// Reads the per-user .mcp.json (written by writeMcpConfig) and returns its mcpServers map.
// Shared translation source for codex (-c overrides) and opencode (OPENCODE_CONFIG file) below.
function loadMcpServers(mcpConfig) {
  try {
    const raw = JSON.parse(fs.readFileSync(mcpConfig, 'utf8'));
    return raw.mcpServers || {};
  } catch { return {}; }
}

// TOML inline-table literal, e.g. {FOO="bar",BAZ="qux"} — for codex's `-c key=value` overrides,
// where value is parsed as TOML. codex has no native --mcp-config flag (verified via `codex mcp
// list -c mcp_servers.<name>.{command,args,env}=...`); this stays per-invocation, not a
// persistent `codex mcp add`, so concurrent users never race on the shared ~/.codex/config.toml.
function tomlInlineTable(obj) {
  return '{' + Object.entries(obj).map(([k, v]) => `${k}=${JSON.stringify(String(v))}`).join(',') + '}';
}

function codexMcpArgs(mcpConfig) {
  const servers = loadMcpServers(mcpConfig);
  const args = [];
  for (const [name, srv] of Object.entries(servers)) {
    if (!srv.command) continue;
    args.push('-c', `mcp_servers.${name}.command=${JSON.stringify(srv.command)}`);
    if (srv.args) args.push('-c', `mcp_servers.${name}.args=${JSON.stringify(srv.args)}`);
    if (srv.env) args.push('-c', `mcp_servers.${name}.env=${tomlInlineTable(srv.env)}`);
    // Long tools (hermes_research: a whole CLI session) must not hit codex's per-tool cap.
    args.push('-c', `mcp_servers.${name}.tool_timeout_sec=${MCP_TOOL_TIMEOUT_MS / 1000}`);
  }
  return args;
}

// claude and opencode MCP servers inherit the engine process env; codex does NOT — it spawns
// them with only a fixed whitelist (HOME/PATH/USER/…) + the configured `env` (verified live,
// codex-cli 0.154). So under codex every MCP tool lost the run identity the runner sets (user,
// chat, session file, task, per-user tokens): get_chat_history answered "AGENT_USER_ID not set".
// Forward exactly the engine env's names via `env_vars` (by NAME — values never hit argv),
// inserted before the trailing prompt arg, so codex MCP sees what claude/opencode MCP see.
function withCodexMcpEnvForwarding(engineArgs, mcpConfig, envNames) {
  const names = [...new Set(envNames)].filter(n => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
  const servers = Object.entries(loadMcpServers(mcpConfig)).filter(([, srv]) => srv.command);
  if (!names.length || !servers.length || !engineArgs.length) return engineArgs;
  const extra = servers.flatMap(([name]) => ['-c', `mcp_servers.${name}.env_vars=${JSON.stringify(names)}`]);
  return [...engineArgs.slice(0, -1), ...extra, engineArgs[engineArgs.length - 1]];
}

// Single source of truth for the engine process working directory. runner/index.js
// resolves this ONCE and passes the identical value to both buildEngineCommand()
// (codex `-C` on the fresh path) and runEngineProcess() (spawn.cwd), so `-C` and
// the actual process cwd can never silently drift apart — including the resume
// path, where codex emits no `-C` and the process cwd is authoritative. Non-project
// (conversational/recruiter) tasks leave user.cwd unset, so this is the profile
// workDir — unchanged from before.
function resolveEngineCwd(user = {}) {
  return user.cwd || user.workDir;
}

// opencode has no per-invocation MCP flag either, but does merge config from the file at
// $OPENCODE_CONFIG on top of the global ~/.config/opencode/opencode.json (verified against
// opencode's own config docs), so a per-user file set via env var is the isolation-safe
// equivalent of claude's --mcp-config — no shared-file mutation, no cross-user race.
//
// configDir (NOT the code cwd): where the per-invocation config file is written. claude/codex
// keep their MCP wiring in user.workDir already; writing this file into the code cwd would leave
// an untracked runtime artifact (with env/secrets) inside the git worktree that becomes the
// task's cwd — it could leak into a diff/commit or fast_verify. Callers pass user.workDir, and
// the absolute path goes to opencode via OPENCODE_CONFIG.
//
// ocProfileOverrides (optional): the {provider, model, agent: {build|plan|explore|general|review:
// {model}}} shape from src/opencode-ladder-provider.js (llm-ladder worker, #1687). Folding it in here —
// same per-invocation file, same deep-merge-on-top-of-global-file behaviour — replaces the old
// opencode-switch-profile.sh, which overwrote the one shared ~/.config/opencode/opencode.json
// for every profile on the VM. Deep merge means agent.review's base fields (prompt/permission/
// etc., only present in the global file) survive; only .model gets overridden per profile.
function writeOpencodeMcpConfig(configDir, mcpConfig, ocProfileOverrides) {
  const servers = loadMcpServers(mcpConfig);
  const mcp = {};
  for (const [name, srv] of Object.entries(servers)) {
    if (!srv.command) continue;
    mcp[name] = {
      type: 'local',
      command: [srv.command, ...(srv.args || [])],
      ...(srv.env ? { environment: srv.env } : {}),
      timeout: MCP_TOOL_TIMEOUT_MS,
    };
  }
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, '.opencode-mcp.json');
  // opencode aborts every MCP tool call at 60s by default (MCP SDK request timeout) —
  // hermes_research died there 11/11 times (2026-09-27). experimental.mcp_timeout is the
  // tool-call timeout; per-server `timeout` covers the other MCP requests.
  const experimental = { ...(ocProfileOverrides?.experimental || {}), mcp_timeout: MCP_TOOL_TIMEOUT_MS };
  fs.writeFileSync(configPath, JSON.stringify({ mcp, ...ocProfileOverrides, experimental }, null, 2));
  return configPath;
}

function ocLadderTokenEnv() {
  const { TOKEN_ENV, ladderToken } = require('../opencode-ladder-provider');
  const token = ladderToken();
  return token ? { [TOKEN_ENV]: token } : {};
}

// One OpenCode Go key per run, drawn from the box's rotation list.
//
// The built-in `opencode-go` provider reads OPENCODE_API_KEY and passes it to the
// upstream verbatim — so the VALUE must be exactly one `oc_sk_…`. Verified on the prod
// VM 2026-09-28 with a clean HOME/OPENCODE_CONFIG_DIR (isolating the run from the stored
// account credential that made an earlier, dirtier probe report success for everything):
//   one valid key → OK · two keys comma-joined → FAIL · garbage → FAIL · garbage+valid → FAIL
// and the raw API rejects the comma pair outright (401 "Invalid credential").
// So OPENCODE_GO_API_KEYS (distinct `oc_sk_…` keys, infra/env-manifest.json) can never be
// forwarded as-is. Picking ONE key per run still delivers the rotation the list is for:
// when a key hits its weekly allowance, the next run draws the other.
// An explicitly-set OPENCODE_API_KEY always wins (ops override).
//
// NOTE for opencode: its stored credential (.agent-home/…/opencode/auth.json) takes
// precedence over this env var when present — src/runner/engine-isolation.js rewrites
// that file with the drawn key so the rotation actually reaches the engine.
function goApiKey(env = {}) {
  if (env.OPENCODE_API_KEY) return env.OPENCODE_API_KEY;
  const list = String(env.OPENCODE_GO_API_KEYS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (list.length) return list[Math.floor(Math.random() * list.length)];
  return env.OPENCODE_GO_API_KEY || '';
}

// Reads opencode.json and returns agent-name -> shortened model-id map (for footer breakdown).
// ocProfileOverrides (optional): the per-invocation {model, agent} this run actually got via
// OPENCODE_CONFIG. It wins over the global opencode.json — without it every step/error log line
// named the global profile's model even when the run was on another one,
// which hid a whole day of metered OpenRouter spend behind a Go label (2026-09-27).
function readOcAgentModels(ocProfileOverrides = null) {
  try {
    const cfgPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
    const globalCfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
    const cfg = ocProfileOverrides?.model || ocProfileOverrides?.agent
      ? { model: ocProfileOverrides.model || globalCfg.model, agent: { ...globalCfg.agent, ...ocProfileOverrides.agent } }
      : globalCfg;
    // Only the two API-marketplace prefixes are cosmetic. `opencode-go/` is deliberately
    // kept: the label must show that a run is on the subscription tier (see
    // test/oc-agent-models-label.test.cjs).
    const shorten = m => (m || '').replace(/^openrouter\//, '').replace(/^gigachat\//, '');
    const defaultModel = shorten(cfg.model);
    const result = { _default: defaultModel };
    for (const [name, agent] of Object.entries(cfg.agent || {})) {
      result[name] = shorten(agent.model || cfg.model);
    }
    return result;
  } catch { return {}; }
}

// OpenCode agents that `opencode run --agent` accepts as the run's primary agent.
const OC_PRIMARY_AGENTS = new Set(['build']);

// Build the argv for the selected engine (claude/codex/opencode).
// Returns [bin, args].
// disallowedTools (optional, #1856 wrap_up): claude-only deny list (--disallowedTools).
// opencode gets the same restriction via `tools` in its per-invocation config
// (ocProfileOverrides); codex has no per-run tool switch — prompt-only there.
function buildEngineCommand({ engine, prompt, systemPromptText, ocSystemPrompt, opencodeModel, ocProfile = null, mcpConfig, systemPromptFile, user = {}, cwd, resumeSessionId = null, ocRole = null, disallowedTools = null }) {
  const opencodeModelResolved = opencodeModel || process.env.OPENCODE_MODEL || null;
  // `cwd` is the runner-resolved code dir (see resolveEngineCwd); falling back to
  // user.cwd/user.workDir keeps callers that don't pass it (hermes, tests) working.
  const codeCwd = cwd || resolveEngineCwd(user);
  if (engine === 'codex') {
    // Validated 2026-09-23: capping raw tool-output tokens cuts the *uncached* input
    // tokens a cat/grep/diff-heavy turn needs by ~40% (measured 18.7k -> 10.7k avg
    // over repeated codex exec trials on the same task) without breaking correctness
    // (codex appends a truncation notice with real counts, it doesn't blindly cut).
    // This is the confirmed root cause of Codex's outsized input-token growth — see
    // https://instant-publish.trainedassist.store/p/codex-input-token-breakdown.
    const toolOutputTokenLimit = process.env.CODEX_TOOL_OUTPUT_TOKEN_LIMIT || '4000';
    return [process.env.CODEX_BIN || 'codex', [
      'exec',
      // Native resume (#1234 Sub-3): `codex exec resume <thread_id>` continues the real thread.
      // Validated live. NOTE: `resume` rejects `-C` (it uses the process cwd, which we already
      // set in spawn opts) — so `-C` is emitted only on the fresh-exec path. `--json` and the
      // `-c` overrides (tool-output limit + MCP) are accepted on both paths.
      ...(resumeSessionId ? ['resume', resumeSessionId] : []),
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      ...(resumeSessionId ? [] : ['-C', codeCwd]),
      '-c', `tool_output_token_limit=${toolOutputTokenLimit}`,
      ...codexMcpArgs(mcpConfig),
      systemPromptText ? `${systemPromptText}\n\n${prompt}` : prompt,
    ]];
  }
  if (engine === 'opencode') {
    return [process.env.OPENCODE_BIN || 'opencode', [
      'run',
      // Native resume (#1234 Sub-4): `opencode run --session <id>` continues the real session.
      // SAFE BY CONSTRUCTION: we only have an id if opencode previously ran successfully and
      // emitted a sessionID — so if opencode is broken, resumeSessionId is always null and this
      // branch is a no-op. On a stale/unknown id the run fails and the runner falls back to a
      // fresh context-rebuild (see resumeFallbackDone in runner/index.js).
      ...(resumeSessionId ? ['--session', resumeSessionId] : []),
      // P3b: a durable contract step names the OpenCode agent role it resolved to.
      // Only PRIMARY agents go on the argv (#1725 root 3): `opencode run --agent
      // explore|review|general` ignores a subagent («is a subagent, not a primary agent.
      // Falling back to default agent», verified on 1.18.31), and if a future OpenCode
      // honoured it, native `explore` denies `*` — every MCP tool, task_item_complete
      // included — so a researcher step could never finish. A step without its tools
      // must not be one engine upgrade away. Non-contract callers → historical argv.
      ...(ocRole && OC_PRIMARY_AGENTS.has(ocRole) ? ['--agent', ocRole] : []),
      '--format', 'json',
      '--auto',
      ...(opencodeModelResolved ? ['-m', opencodeModelResolved] : []),
      ocSystemPrompt ? `${ocSystemPrompt}\n\n${prompt}` : prompt,
    ]];
  }
  return [process.env.CLAUDE_BIN || 'claude', [
    '--dangerously-skip-permissions',
    // Native resume (#1234 Sub-2): continue the REAL Claude session — full history, tool
    // state, plan — instead of rebuilding a lossy context after a restart. Validated live:
    // `claude --resume <session_id> --print "…"` recalls earlier turns. Absent → new session.
    ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
    '--output-format', 'stream-json',
    '--verbose',
    '--mcp-config', mcpConfig,
    ...(systemPromptFile && fs.existsSync(systemPromptFile) ? ['--append-system-prompt-file', systemPromptFile] : []),
    ...(Array.isArray(disallowedTools) && disallowedTools.length ? ['--disallowedTools', disallowedTools.join(',')] : []),
    '--print', prompt,
  ]];
}

// One-line human label for a tool invocation, shown in the progress message.
function formatToolActivity(name, input = {}) {
  switch (name) {
    case 'Bash': {
      const cmd = (input.command || '').trim().replace(/\n/g, ' ').slice(0, 80);
      return `💻 ${cmd}`;
    }
    case 'Read':
      return `📖 Читаю ${(input.file_path || '').replace(/^.*\//, '').slice(0, 60)}`;
    case 'Write':
      return `✍️ Пишу ${(input.file_path || '').replace(/^.*\//, '').slice(0, 60)}`;
    case 'Edit':
      return `✏️ Редактирую ${(input.file_path || '').replace(/^.*\//, '').slice(0, 60)}`;
    case 'WebFetch':
      return `🌐 ${(input.url || '').slice(0, 60)}`;
    case 'WebSearch':
      return `🔍 ${(input.query || '').slice(0, 60)}`;
    case 'Agent':
      return `🤖 Запускаю агента…`;
    default: {
      // MCP tool names: strip "mcp__<server>__" prefix for display
      const shortName = name.replace(/^mcp__[^_]+__/, '');
      switch (shortName) {
        case 'illustrate_generate':  return `🎨 Генерирую иллюстрацию…`;
        case 'illustrate_refine':    return `🎨 Дорабатываю иллюстрацию…`;
        case 'illustrate_preview_prompt': return `🖊 Готовлю промпт…`;
        case 'image_label':          return `🏷 Добавляю подписи на изображение…`;
        case 'image_label_adjust':   return `🏷 Корректирую подписи…`;
        default:                     return `🔧 ${shortName}`;
      }
    }
  }
}

/**
 * Run the engine process to completion with streaming.
 *
 * opts (all fields required unless noted):
 *   engine, taskId, chatId, thinkingStart, msgId (may be null),
 *   BOT_TOKEN, secrets, user, cleanEnv, userTokens, sessionFilePath,
 *   sessionId (may be null for a brand-new session — stored on sessionState so
 *   runner.isSessionRunning(sessionId) can detect a live run for re-entrancy guards),
 *   restartShutdown: () => boolean,
 *   activeTimers: Map (register sessionState so /stop and /restart can reach the proc),
 *   tgEdit, tgSend, outputCallback,
 *   engineBin, engineArgs (already built), cwd (the runner-resolved code dir — the SAME
 *   value passed to buildEngineCommand, see resolveEngineCwd), env, mcpConfig (path to the
 *   per-user .mcp.json; used to derive OPENCODE_CONFIG for opencode — codex gets its MCP
 *   wiring baked into engineArgs already, via codexMcpArgs in buildEngineCommand),
 *   ocProfileOverrides (optional, opencode only — {model, agent} from profiles.getOcProfile,
 *   folded into the same per-invocation OPENCODE_CONFIG file),
 *   formatToolActivity, readOcAgentModels
 *   onHeartbeat (optional, () => void — called on the existing 30s inactivity-check tick so the
 *   pending-task journal's lastHeartbeatAt stays fresh while the process is alive; issue #942 [011])
 *   ladderApp, internalGtd, resumeSink (optional, #1917) — only used to pick AGENT_LADDER_APP,
 *   the run-type slug behind x-ladder-app; see resolveLadderApp. Callers that know their type
 *   (hermes) pass `ladderApp` directly, the runner passes its own internalGtd/resumeSink.
 *
 * Returns a plain result object — never throws for process-level failures:
 *   { fullOutput, lastAssistantMsg, claudeResult, terminalSuccess,
 *     claudeUsage, opencodeUsage, opencodeBreakdown, claudeModel,
 *     lastActivity, exitCode, processSignal, processError, timedOut,
 *     inactivityKill, outputPersistenceError, codexErrorMsg, sessionState }
 */
// Durable «Полный лог» (#1893): every opencode part the stream parser sees is
// appended to the profile's session-trace-store, so the log survives the engine
// db being rotated/recreated. Best-effort: appendEvent never throws, and the
// try/catch keeps even a broken store out of the run's way.
const PERSISTED_OC_EVENTS = new Set(['text', 'tool_use', 'step_start', 'step_finish']);
function persistOpencodePart(workDir, engineSessionId, event, taskId) {
  try {
    if (!workDir || !engineSessionId || !event || !PERSISTED_OC_EVENTS.has(event.type) || !event.part) return false;
    return traceStore.appendEvent(workDir, 'opencode', engineSessionId, event.part, { taskId });
  } catch { return false; }
}

// OpenRouter "Application" slice (#1917): one slug per run type, read by opencode as
// x-ladder-app ({env:AGENT_LADDER_APP} in TRACE_HEADERS) and by the worker for the
// `…/app/<slug>` breakdown. Precedence: an explicit `ladderApp` (hermes names itself) →
// the run's own shape — a durable plan step / an internal GTD turn is background work,
// everything else is an ordinary chat run.
const LADDER_APP = Object.freeze({
  durable: 'background-playbooks',
  hermes: 'hermes-research',
  chat: 'opencode-chat',
});

function resolveLadderApp({ ladderApp = null, internalGtd = false, resumeSink = null } = {}) {
  if (ladderApp) return ladderApp;
  if (internalGtd || (resumeSink && resumeSink.kind === 'durable')) return LADDER_APP.durable;
  return LADDER_APP.chat;
}

async function runEngineProcess(opts) {
  const {
    engine, taskId, chatId, thinkingStart, msgId, BOT_TOKEN, secrets, user, threadId,
    cleanEnv, userTokens, sessionFilePath, sessionId, restartShutdown, activeTimers, consumePendingStop = null,
    tgEdit, tgSend, outputCallback, engineBin, engineArgs, cwd, env, mcpConfig,
    ocProfileOverrides, onHeartbeat, onEngineSessionId, onProgress, timeoutMs = null,
    bridgedServers = null, warnTimeoutMs: warnOverrideMs = null, maxToolCalls = null,
    ladderApp = null, internalGtd = false, resumeSink = null,
  } = opts;
  const { hardTimeoutMs, warnTimeoutMs } = computeEngineTimeoutMs(timeoutMs, warnOverrideMs);
  const warnLeftMin = Math.max(1, Math.round((hardTimeoutMs - warnTimeoutMs) / 60000));
  // Forum topics (#255): fresh progress/warning sends stay in the originating topic.
  // Only new messages need it; edits target an existing message already in the topic.
  const runThreadId = Number.isInteger(threadId) && threadId > 0 ? threadId : null;
  const sendT = (token, chat, text, extra = {}) => tgSend(token, chat, text, extra, runThreadId);
  // Live progress for non-Telegram consumers (the web SSE stream). Same label the
  // Telegram heartbeat shows; emitted on every activity change with no chat/message
  // dependency, so web runs get real progress instead of a frozen "waiting" state.
  const reportProgress = (label) => { if (onProgress) try { onProgress(label); } catch {} };

  const keepaliveFile = keepaliveFilePath(taskId);
  const engineEnv = {
      ...cleanEnv,
      ...userTokens,
      AGENT_USER_ID: String(user.username),
      AGENT_CHAT_ID: String(chatId),
      ...(secrets.BOT_TOKEN      ? { AGENT_BOT_TOKEN:    secrets.BOT_TOKEN }      : {}),
      ...(secrets.SYSTEM_DEEPGRAM_API_KEY ? { DEEPGRAM_API_KEY: secrets.SYSTEM_DEEPGRAM_API_KEY, SYSTEM_DEEPGRAM_API_KEY: secrets.SYSTEM_DEEPGRAM_API_KEY } : {}),
      ...(secrets.OPENAI_API_KEY ? { OPENAI_API_KEY:     secrets.OPENAI_API_KEY } : {}),
      ...(secrets.FAL_KEY        ? { FAL_KEY:            secrets.FAL_KEY }        : {}),
      ...(secrets.IDEOGRAM_API_KEY ? { IDEOGRAM_API_KEY: secrets.IDEOGRAM_API_KEY } : {}),
      ...(secrets.RECRAFT_API_KEY  ? { RECRAFT_API_KEY:  secrets.RECRAFT_API_KEY }  : {}),
      ...(secrets.ADMIN_CLOUDFLARE_API_TOKEN ? { CLOUDFLARE_API_TOKEN: secrets.ADMIN_CLOUDFLARE_API_TOKEN, ADMIN_CLOUDFLARE_API_TOKEN: secrets.ADMIN_CLOUDFLARE_API_TOKEN } : {}),
      ...(user.name     ? { AGENT_USER_NAME: user.name }         : {}),
      ...(user.username ? { AGENT_USER_HANDLE: user.username }   : {}),
      ...(sessionFilePath ? { AGENT_SESSION_FILE: sessionFilePath } : {}),
      AGENT_TASK_ID: taskId,
      // Fresh per spawn: tells apart the runs of one task (resume/retry) in the ladder's
      // call log (x-ladder-run, see src/opencode-ladder-provider.js).
      AGENT_RUN_ID: require('crypto').randomUUID(),
      AGENT_TRACE_CHAT: require('../opencode-ladder-provider').traceChat(chatId),
      // Run type → x-ladder-app → OpenRouter "Application" (#1917). traceChat-style rule:
      // always a non-empty slug, so the header never lands as "" and the worker never
      // groups these calls under an empty application.
      AGENT_LADDER_APP: resolveLadderApp({ ladderApp, internalGtd, resumeSink }),
      // Session identity for checklist ownership (#1729 BV-08): a new `Goal:` section in the
      // project's checklist.md is signed `Owner-session: $AGENT_SESSION_ID`.
      ...(sessionId ? { AGENT_SESSION_ID: String(sessionId) } : {}),
      // Slow MCP tools touch this while they work so the inactivity watchdog doesn't
      // mistake a pending tool call for a hung engine (see src/mcp-keepalive.js).
      AGENT_KEEPALIVE_FILE: keepaliveFile,
      ...(runThreadId ? { AGENT_THREAD_ID: String(runThreadId) } : {}),
      MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS), // claude's MCP tool-call ceiling
      // All user-facing times are Moscow (МСК) — the pinned card and session context
      // format with timeZone 'Europe/Moscow'. Without this the engine shell inherited the
      // VM clock (UTC on GCP), so plain `date` disagreed with every time the user sees and
      // the agent mixed a МСК target with `date -u`, scheduling waits ~3h off (2026-09-27).
      TZ: process.env.TZ || 'Europe/Moscow',
      CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0', // disable 600s background-task kill
      // opencode's config file goes to user.workDir (outside the code cwd) — see
      // writeOpencodeMcpConfig for why it must never land in the git worktree.
      ...(engine === 'opencode' && (mcpConfig || ocProfileOverrides) ? { OPENCODE_CONFIG: writeOpencodeMcpConfig(user.workDir || os.tmpdir(), mcpConfig, ocProfileOverrides) } : {}),
      // Engine credential for the `ladder` provider (src/opencode-ladder-provider.js, #1687).
      ...(engine === 'opencode' ? ocLadderTokenEnv() : {}),
      // OpenCode Go subscription key for the built-in `opencode-go` provider (used when a
      // run is explicitly pointed at `opencode-go/…`; the profiles themselves all go
      // through the `ladder` provider). Exactly one key, drawn per run from the rotation
      // list — see goApiKey for why the list itself must never be forwarded. Read off
      // cleanEnv (the env this run actually carries); empty when absent, and
      // buildAgentEnv then skips the empty engineCredentialNames value.
      ...(engine === 'opencode' ? { OPENCODE_API_KEY: goApiKey(cleanEnv) } : {}),
      // OpenCode ships a built-in `websearch` tool, but registers it ONLY when the model's
      // provider is `opencode`/`opencode-go` or one of these flags is set — never for our
      // `openrouter`/`ladder` providers (verified in opencode 1.18.31: the registry gate is
      // `provider===opencode || provider===opencode-go || enableExa || enableParallel`).
      // Without this flag an opencode run has NO search at all: only `webfetch` (a URL it
      // already knows). That is why `hermes_research` produced reports with zero URLs —
      // its prompt promised «встроенный веб-поиск» that was never there (triage 2026-09-28).
      // Exa's endpoint needs no API key; `OPENCODE_ENABLE_PARALLEL` stays off — the parallel
      // provider is picked first when both are set and we have no key for it.
      ...(engine === 'opencode' ? { OPENCODE_ENABLE_EXA: '1' } : {}),
  };
  // T0 hardening (issue #1649): with AGENT_ENV_ALLOWLIST / AGENT_RUN_AS_USERS the engine
  // gets an allowlisted env (no server secrets), MCP goes through the run-token bridge,
  // and the process may run as a leased unprivileged slot user. Off → unchanged inputs.
  // Fails closed: a configured isolation that cannot be set up throws, never falls back
  // to running as the service user.
  const isolation = await prepareEngineSpawn({
    engine, taskId, user, cwd, engineEnv, engineArgs, userTokens, bridgedServers, mcpConfig,
  });
  const spawnEnv = isolation.env;
  const spawnArgs = engine === 'codex' && mcpConfig
    ? withCodexMcpEnvForwarding(engineArgs, mcpConfig, Object.keys(spawnEnv))
    : engineArgs;
  const [spawnBin, spawnArgv] = isolation.wrap(engineBin, spawnArgs);
  if (isolation.runAs) console.log(`[${taskId}] engine runs as ${isolation.runAs}`);
  reportProgress('Думаю…');
  let proc;
  try {
    proc = spawn(spawnBin, spawnArgv, {
      cwd,
      env: spawnEnv,
      // Своя группа процессов (spec §2 / SS-01, #1934): ребёнок — лидер группы
      // (pgid = его pid), все его bash-дети наследуют группу, и «Стоп» бьёт по
      // ней через engine-stop.groupSignal — внуков достаёт даже когда движок уже
      // вышел или игнорирует TERM. Под run-as изоляцией основной адрес остаётся
      // pkill -u <slot>; группа — второй контур и единственный для обычного режима.
      detached: true,
      // codex exec and opencode run both block on open stdin — close it explicitly.
      // claude doesn't read stdin in --print mode.
      // opencode waits 3s for stdin data before proceeding — use 'pipe' + immediate .end()
      // so it sees EOF instantly rather than waiting the full 3-second timeout.
      ...(engine === 'codex' || engine === 'opencode' ? { stdio: ['pipe', 'pipe', 'pipe'] } : {}),
    });
  } catch (e) { isolation.release(); throw e; }
  // Аренда слота для «Стопа» (runner/engine-stop.js): сигнал `pkill -u <slot>`
  // законен только пока слот наш. Флаг ставится в том же тике, где release()
  // добивает слот и отдаёт lock, — окна «lock отдан, флаг ещё нет» не бывает.
  const slotLease = { slot: isolation.runAs || null, released: false };
  proc.once('close', () => { slotLease.released = true; isolation.release(); });
  if (engine === 'codex' || engine === 'opencode') proc.stdin.end();

  let streamTimer = null;
  let heartbeatTimer = null;
  let typingTimer = null;   // periodic sendChatAction: typing during active streaming
  let outputStarted = false;
  let lastSent = '';
  let lineBuffer = '';
  let fullOutput = { text: '' };
  let claudeResult = null;  // text from result event
  let claudeErrorText = null; // result-event text ONLY when event.is_error — genuine provider error, never answer prose (#1227)
  let engineSessionId = null; // native CLI session id (claude session_id / codex thread_id / opencode sessionID) — for real --resume (#1234)
  let lastAssistantMsg = ''; // last complete assistant turn — clean fallback, not the whole scratchpad
  let terminalSuccess = false; // explicit engine completion, never inferred from narration
  let processSignal = null;
  let processError = null;
  let claudeUsage = null;   // usage from result event (Claude Code / Codex)
  let opencodeUsage = null; // accumulated totals from step_finish events (OpenCode)
  let opencodeBreakdown = []; // per-agent steps: [{agent, model, input, output, cacheRead, cacheWrite, cost}]
  let currentOcAgent = null; // last 'agent' event name, to label the next step_finish
  let ocAgentModels = {}; // lazily loaded from opencode.json
  let claudeModel = null;   // model name from assistant event
  let lastActivity = '';     // last tool name/cmd for heartbeat
  let exitCode = 0;
  let codexErrorMsg = null;  // last turn.failed / error message from codex/opencode
  let lastOutputAt = Date.now(); // updated on any raw stdout data for inactivity detection
  let inactivityKill = false;   // true when killed due to silence, not 40-min timeout
  let inactivityCheckTimer = null;
  // Loop-guard state (#1583): last seen assistant text part + tool/input signature and
  // their consecutive-repeat counters. Reset on any change. `loopKilled` mirrors the
  // inactivityKill/timedOut pattern so the caller can distinguish a genuine loop from a
  // timeout and reply accordingly (no auto-continuation for a loop — it would just loop).
  let loopKilled = false;
  // Tool budget (#1856 wrap_up): the run may call at most `maxToolCalls` tools; the
  // next one ends it (SIGTERM, reported as a timeout so the caller's ceiling branch
  // delivers whatever was written). null = unlimited (every other run).
  let toolCalls = 0;
  let toolBudgetKilled = false;
  const countToolCall = (label) => {
    if (!Number.isFinite(maxToolCalls) || maxToolCalls < 0) return;
    toolCalls++;
    if (toolCalls > maxToolCalls && !toolBudgetKilled && !timedOut) {
      toolBudgetKilled = true;
      timedOut = true;
      console.warn(`[${taskId}] tool budget exhausted (${toolCalls - 1}/${maxToolCalls}, next: ${label}) — SIGTERM`);
      try { proc.kill('SIGTERM'); } catch {}
    }
  };
  let lastOcTextPart = null;
  let ocTextRepeatCount = 0;
  let lastOcToolSig = null;
  let ocToolRepeatCount = 0;
  let ocNoopStreak = 0;

  // Drain in-flight progress edits before posting a terminal message.
  const progressEdits = new Set();
  let progressStopped = false;
  // Consecutive HARD failures (a thrown non-429 tgEdit error: "message to edit
  // not found", fetch timeout, any 4xx/5xx) on the SAME message. A resolved drop
  // (`{ok:false,flooded}` / `{ok:true,skipped}`) is intentional flood/coalesce
  // backpressure and does NOT count — only a throw means the edit genuinely
  // could not be delivered. After MAX_PROGRESS_HARD_FAILS the heartbeat stops
  // trying to edit the dead placeholder and falls back to a fresh sendMessage,
  // so the user sees a live message instead of a frozen "(2с)" forever. This is
  // the same fallback every terminal edit in runner/index.js already uses; the
  // heartbeat was the one path that silently swallowed it (2026-09-24 freeze).
  const MAX_PROGRESS_HARD_FAILS = 3;
  let progressHardFails = 0;
  let progressFellBack = false;
  // progressStopped guard on the fallback: once the run is ending (stopProgress
  // ran) we must not post a brand-new message — the terminal reply is coming.
  function progressEdit(...args) {
    if (progressStopped) return Promise.resolve();
    // Progress/status edits are cosmetic: best-effort (drop on 429 — a missed
    // "Думаю…" update is fine, a 5-44s block is not) and coalesced per chat so
    // concurrent sessions sharing a bot token can't flood editMessageText.
    const pending = tgEdit(...args, { bestEffort: true, coalesce: true }).then(
      (res) => { progressHardFails = 0; return res; },
      (err) => {
        progressHardFails++;
        // The token value is never logged; chatId/msgId are enough to grep.
        console.error(`[${taskId}] progress edit failed (${progressHardFails}/${MAX_PROGRESS_HARD_FAILS}) chat=${chatId} msg=${args[2]}: ${err.message}`);
        if (progressHardFails >= MAX_PROGRESS_HARD_FAILS && !progressFellBack && !progressStopped) {
          progressFellBack = true;
          // args = (token, chatId, messageId, text, extra) — repost the same text
          // as a fresh message so progress stays visible. Best-effort: the next
          // heartbeat tick keeps editing the placeholder if this also fails.
          sendT(args[0], args[1], String(args[3] || '🧠 Думаю…'), args[4] || {}).catch(() => {});
        }
      },
    );
    progressEdits.add(pending);
    pending.finally(() => progressEdits.delete(pending));
    return pending;
  }
  async function stopProgress() {
    progressStopped = true;
    clearInterval(streamTimer);
    clearInterval(heartbeatTimer);
    clearInterval(typingTimer); typingTimer = null;
    clearInterval(inactivityCheckTimer); inactivityCheckTimer = null;
    await Promise.allSettled([...progressEdits]);
  }

  // Heartbeat: show elapsed seconds while Claude hasn't produced output yet.
  // stopButtonShown only flips once the edit actually lands — progressEdit is
  // best-effort+coalesced (issue: a 429/coalesce drop on the one tick that
  // carried the buttons used to mark them "shown" anyway, so a single dropped
  // edit permanently hid ⛔/➕ for the rest of the task with no retry).
  // Once the threshold passes, EVERY progress edit must carry the ⛔/➕ markup.
  // editMessageText without reply_markup clears the keyboard, so sending markup
  // only on the first landing (and bare text afterwards) makes the buttons
  // visible for one tick and then vanish on the next — the reported bug.
  const inputMessageId = msgId; // preserve snapshot identity if progress falls back to a fresh bubble
  let stopButtonShown = false;
  // Cadence of progress edits: burst at 1s/2s/5s/10s/15s so the counter feels
  // live, then settle to one edit every 15s. A fixed 3s tick hammered Telegram's
  // per-chat edit flood limit (~1/s) when concurrent sessions (user task + GTD +
  // quick-answers) shared one bot token — retry_after escalated to 9-17s, every
  // edit dropped, and the "Думаю… (Nс)" counter froze at its first landed value
  // for minutes. Backing off after the burst window keeps it live without
  // re-429'ing. progressStart (not thinkingStart) drives the schedule so a long
  // pre-spawn queue doesn't shift the cadence; the DISPLAYED secs still uses
  // thinkingStart.
  const progressStart = Date.now();
  function nextProgressDelayMs(secs) {
    if (secs < 1) return 1000;
    if (secs < 2) return 1000;
    if (secs < 5) return 3000;
    if (secs < 10) return 5000;
    if (secs < 15) return 5000;
    return 15000;
  }
  if (msgId) {
    const heartbeatTick = async () => {
      // Engine dead → stop right away (see exitWatcher for why close may never fire).
      if (outputStarted || progressStopped || proc.exitCode !== null) return;
      const secs = Math.round((Date.now() - thinkingStart) / 1000);
      const label = lastActivity || 'Думаю…';
      if (secs >= STOP_BUTTON_AFTER_SECS) stopButtonShown = true;
      const result = await progressEdit(BOT_TOKEN, chatId, msgId, `🧠 ${label} (${secs}с)`, stopButtonShown ? runningControls(taskId, inputMessageId, sessionId) : { reply_markup: { inline_keyboard: inputInspectionRows(inputMessageId, sessionId) } });
      if (stopButtonShown && editLanded(result)) stopButtonShown = true;
      // Re-arm ONLY while the engine process is still alive AND stopProgress()
      // hasn't run. Two guards, two different zombie paths:
      //   1. progressStopped — stopProgress() ran (finally reached). Re-arming
      //      after this would resurrect a timer the finally already cleared.
      //   2. proc.exitCode !== null — the engine died but `close` may never
      //      fire (codex spawns codex-code-mode-host which inherits the stdout
      //      pipe, so on('close') stalls until the host exits too). Without
      //      this guard the timer keeps ticking for the full 40-min killTimer,
      //      editing ITS message while a successor session edits its own —
      //      the "742с + 3с in one chat" overlap bug.
      if (!progressStopped && proc.exitCode === null) {
        heartbeatTimer = setTimeout(heartbeatTick, nextProgressDelayMs(Math.round((Date.now() - progressStart) / 1000)));
      } else {
        heartbeatTimer = null;
      }
    };
    heartbeatTimer = setTimeout(heartbeatTick, nextProgressDelayMs(0));
  }

  function scheduleStream() {
    if (streamTimer || progressStopped) return;
    outputStarted = true;
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    // sendChatAction: typing every 4s — keeps "typing..." indicator alive in Telegram
    // (indicator expires after ~5s, so refresh before it disappears)
    if (msgId && !typingTimer) {
      const sendTyping = () => fetch(`${TG_API}/bot${BOT_TOKEN}/sendChatAction`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {});
      sendTyping();
      typingTimer = setInterval(sendTyping, 4_000);
    }
    let streamEditInProgress = false;
    const streamTick = async () => {
      if (progressStopped || proc.exitCode !== null) return;
      if (streamEditInProgress) return;
      streamEditInProgress = true;
      try {
        const snippet = fullOutput.text.slice(-MAX_MSG_LEN);
        const secs = Math.round((Date.now() - thinkingStart) / 1000);
        if (secs >= STOP_BUTTON_AFTER_SECS) stopButtonShown = true;
        const stopExtra = stopButtonShown ? runningControls(taskId, inputMessageId, sessionId) : { reply_markup: { inline_keyboard: inputInspectionRows(inputMessageId, sessionId) } };
        if (snippet) {
          // ⚡ suffix signals "actively writing" (distinct from ⏱ waiting or clean final message)
          const silentMins = Math.round((Date.now() - lastOutputAt) / 60000);
          const silentSuffix = silentMins >= 1 ? ` — молчит ${silentMins}мин` : '';
          const activitySuffix = lastActivity ? `\n\n⚡ ${lastActivity} (${secs}с)${silentSuffix}` : `\n\n⚡ Пишу… (${secs}с)${silentSuffix}`;
          const newText = `🧠 ${snippet}${activitySuffix}`;
          if (newText === lastSent) return;
          lastSent = newText;
          if (msgId) await progressEdit(BOT_TOKEN, chatId, msgId, newText, stopExtra);
        } else {
          // No text yet (e.g. Claude running tools) — show activity + elapsed
          const label = lastActivity || 'Думаю…';
          const newText = `🧠 ${label} (${secs}с)`;
          if (newText === lastSent) return;
          lastSent = newText;
          if (msgId) await progressEdit(BOT_TOKEN, chatId, msgId, newText, stopExtra);
        }
      } finally {
        streamEditInProgress = false;
        // Re-arm ONLY while the engine is alive AND stopProgress hasn't run —
        // same dual guard as heartbeat (zombie path 2: codex-code-mode-host
        // inheriting the stdout pipe stalls on('close'), so a dead engine with
        // exitCode set must stop this chain on its own instead of editing its
        // message for the rest of the 40-min killTimer while a successor runs).
        if (!progressStopped && proc.exitCode === null) {
          streamTimer = setTimeout(streamTick, nextProgressDelayMs(Math.round((Date.now() - progressStart) / 1000)));
        } else {
          streamTimer = null;
        }
      }
    };
    streamTimer = setTimeout(streamTick, nextProgressDelayMs(0));
  }

  let firstJsonEventSeen = false;
  let outputPersistenceError = null;
  proc.stdout.setEncoding('utf8'); // preserve Cyrillic split across byte chunks
  function consumeOutput(chunk, flush = false) {
    lineBuffer += chunk;
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop(); // keep trailing incomplete line
    if (flush && lineBuffer) { lines.push(lineBuffer); lineBuffer = ''; }

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        firstJsonEventSeen = true;
        // Capture the engine's native session id the first time it appears, so a later
        // restart can resume the REAL session instead of rebuilding a lossy context (#1234).
        // One field per engine, checked generically: claude puts `session_id` on every event
        // (init included), codex emits `thread_id` in `thread.started`, opencode emits
        // `sessionID`. Fired once; the callback persists it durably (survives SIGKILL).
        if (!engineSessionId) {
          const sid = event.session_id || event.thread_id || event.sessionID;
          if (sid) {
            engineSessionId = sid;
            try { onEngineSessionId?.(sid); } catch (e) { console.warn(`[${taskId}] onEngineSessionId:`, e.message); }
          }
        }
        if (engine === 'opencode') {
          persistOpencodePart(user?.workDir, event.sessionID || engineSessionId, event, taskId);
          if (event.type === 'text' && typeof event.part?.text === 'string') {
            fullOutput.text += event.part.text;
            lastAssistantMsg = fullOutput.text;
            // Loop guard (#1583): a stuck model repeats the SAME assistant text part
            // (e.g. "Публикую доку через publish_page.") over and over while emitting
            // tool noise. Count consecutive identical non-trivial text parts; on the
            // LIMIT-th repeat, kill the run with an explicit loop error.
            const partText = event.part.text;
            if (partText.length >= LOOP_GUARD_TEXT_MIN_LEN && partText === lastOcTextPart) {
              ocTextRepeatCount++;
              if (ocTextRepeatCount >= LOOP_GUARD_REPEAT_LIMIT && !loopKilled && !timedOut) {
                loopKilled = true;
                timedOut = true; // mirror inactivity: SIGTERM → on('close') rejects → caller sees the loop
                console.warn(`[${taskId}] LOOP GUARD: opencode repeated identical text ${ocTextRepeatCount}x — SIGTERM`);
                codexErrorMsg = `Loop guard: opencode повторил один и тот же текст ${ocTextRepeatCount} раз подряд (модель зациклилась, реальный MCP-вызов не выполняется). Публикация/действие не выполнены.`;
                try { proc.kill('SIGTERM'); } catch {}
              }
            } else {
              lastOcTextPart = partText;
              ocTextRepeatCount = 1;
            }
            scheduleStream();
          } else if (event.type === 'tool_use' && event.part) {
            // Progress visibility for opencode (issue: GLM sessions look frozen):
            // tool events arrive only AFTER completion in --format json, so also
            // track step_start as "model is thinking/working" to update lastActivity.
            const ocTool = event.part.tool || 'tool';
            const ocInput = event.part.state?.input || {};
            // Loop guard (#1583): also catch the "busy" loop where the model hammers the
            // SAME tool with the SAME input (e.g. `bash` + `echo "PUBLISHING"`) instead of
            // making real progress. Signature = tool name + stable input string.
            let ocInputSig = '';
            try { ocInputSig = JSON.stringify(ocInput); } catch { ocInputSig = String(ocInput); }
            const ocSig = `${ocTool}\u0000${ocInputSig}`;
            if (ocSig === lastOcToolSig) {
              ocToolRepeatCount++;
              if (ocToolRepeatCount >= LOOP_GUARD_REPEAT_LIMIT && !loopKilled && !timedOut) {
                loopKilled = true;
                timedOut = true; // mirror inactivity: SIGTERM → on('close') rejects → caller sees the loop
                console.warn(`[${taskId}] LOOP GUARD: opencode repeated identical tool call ${ocToolRepeatCount}x (${ocTool}) — SIGTERM`);
                codexErrorMsg = `Loop guard: opencode повторил одинаковый вызов ${ocTool} ${ocToolRepeatCount} раз подряд (модель зациклилась). Действие не выполнено.`;
                try { proc.kill('SIGTERM'); } catch {}
              }
            } else {
              lastOcToolSig = ocSig;
              ocToolRepeatCount = 1;
            }
            ocNoopStreak = isNoopBash(ocTool, ocInput) ? ocNoopStreak + 1 : 0;
            if (ocNoopStreak >= LOOP_GUARD_NOOP_LIMIT && !loopKilled && !timedOut) {
              loopKilled = true;
              timedOut = true;
              console.warn(`[${taskId}] LOOP GUARD: opencode ${ocNoopStreak} no-op bash calls in a row — SIGTERM`);
              codexErrorMsg = `Loop guard: opencode сделал ${ocNoopStreak} пустых bash-вызовов подряд вместо реального действия (модель зациклилась — вероятно, не смогла вызвать нужный инструмент). Действие не выполнено.`;
              try { proc.kill('SIGTERM'); } catch {}
            }
            countToolCall(ocTool);
            const ocLabel = formatToolActivity(ocTool === 'bash' ? 'Bash' : ocTool === 'read' ? 'Read' : ocTool === 'write' ? 'Write' : ocTool === 'edit' ? 'Edit' : ocTool === 'glob' || ocTool === 'grep' ? 'WebSearch' : ocTool, ocInput);
            lastActivity = ocLabel;
            reportProgress(ocLabel);
            lastOutputAt = Date.now();
            if (!outputStarted && msgId) {
              const secs = Math.round((Date.now() - thinkingStart) / 1000);
              if (secs >= STOP_BUTTON_AFTER_SECS) stopButtonShown = true;
              progressEdit(BOT_TOKEN, chatId, msgId, `🧠 ⚡ ${ocLabel} (${secs}с)`, stopButtonShown ? runningControls(taskId, inputMessageId, sessionId) : { reply_markup: { inline_keyboard: inputInspectionRows(inputMessageId, sessionId) } }).catch(() => {});
            }
            scheduleStream();
          } else if (event.type === 'step_start') {
            lastOutputAt = Date.now();
            if (!lastActivity) lastActivity = 'Думаю…';
            reportProgress(lastActivity);
            scheduleStream();
          } else if (event.type === 'agent') {
            // Track which agent is about to run so we can label its step_finish
            currentOcAgent = event.part?.name || null;
          } else if (event.type === 'step_finish') {
            // Loop guard already killed this run — a trailing step_finish (already in
            // the pipe) must not mark a loop-killed run as a success (#1583).
            if (loopKilled) { continue; }
            terminalSuccess = true;
            claudeResult = fullOutput.text.trim() || null;
            const usage = event.part?.tokens;
            if (usage) {
              if (!ocAgentModels || !Object.keys(ocAgentModels).length) ocAgentModels = readOcAgentModels(ocProfileOverrides);
              const agentModel = ocAgentModels[currentOcAgent] || ocAgentModels._default || null;
              const stepIn = usage.input || 0;
              const stepOut = usage.output || 0;
              const stepCR = usage.cache?.read || 0;
              const stepCW = usage.cache?.write || 0;
              const stepCost = event.part.cost || 0;
              opencodeBreakdown.push({ agent: currentOcAgent || 'run', model: agentModel, input: stepIn, output: stepOut, cacheRead: stepCR, cacheWrite: stepCW, cost: stepCost });
              if (!opencodeUsage) opencodeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
              opencodeUsage.input += stepIn; opencodeUsage.output += stepOut;
              opencodeUsage.cacheRead += stepCR; opencodeUsage.cacheWrite += stepCW;
              opencodeUsage.cost += stepCost;
              console.log(`[${taskId}] opencode step[${currentOcAgent}/${agentModel}]: in=${stepIn} out=${stepOut} cR=${stepCR} cW=${stepCW} cost=${stepCost}`);
            }
          } else if (event.type === 'error') {
            const errMsg = event.error?.data?.message || event.error?.message || JSON.stringify(event.error);
            // Model on the SAME line as the error — otherwise undiagnosable from journalctl.
            try { if (!ocAgentModels || !Object.keys(ocAgentModels).length) ocAgentModels = readOcAgentModels(ocProfileOverrides); } catch {}
            const errModel = (ocAgentModels && (ocAgentModels[currentOcAgent] || ocAgentModels._default)) || null;
            console.warn(`[${taskId}] opencode error event: model=${errModel || '?'} agent=${currentOcAgent || '?'}:`, errMsg);
            codexErrorMsg = errMsg;
            const isRateLimit = /429|rate.?limit|too many requests/i.test(errMsg);
            const userErrMsg = isRateLimit
              ? `⚠️ OpenCode: превышен лимит запросов к модели. Переключись на Claude: /switch2klod`
              : `❌ OpenCode ошибка: ${errMsg}`;
            fullOutput.text += `\n${userErrMsg}`;
            lastAssistantMsg = fullOutput.text.trim();
            scheduleStream();
          }
          continue;
        }
        if (engine === 'codex') {
          if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
            fullOutput.text += event.item.text;
            lastAssistantMsg = event.item.text;
            // A message alone is not proof that the turn completed.
            if (outputCallback) try { outputCallback(event.item.text); } catch {}
            scheduleStream();
          } else if (event.type === 'item.started' && event.item?.type === 'command_execution') {
            lastAssistantMsg = '';
            lastActivity = formatToolActivity('Bash', { command: event.item.command });
            reportProgress(lastActivity);
            if (!outputStarted && msgId) {
              const secs = Math.round((Date.now() - thinkingStart) / 1000);
              if (secs >= STOP_BUTTON_AFTER_SECS) stopButtonShown = true;
              progressEdit(BOT_TOKEN, chatId, msgId, `🧠 ⚡ ${lastActivity} (${secs}с)`, stopButtonShown ? runningControls(taskId, inputMessageId, sessionId) : { reply_markup: { inline_keyboard: inputInspectionRows(inputMessageId, sessionId) } }).catch(() => {});
            }
          } else if (event.type === 'turn.completed') {
            terminalSuccess = true;
            claudeResult = lastAssistantMsg;
            // Codex names its cache fields differently from Claude's `result` event
            // (cached_input_tokens/cache_write_input_tokens vs. cache_read_input_tokens/
            // cache_creation_input_tokens) — normalize here so every downstream consumer
            // (cost calc, footer, usage-store) can read the Claude-shaped field names
            // regardless of engine.
            claudeUsage = event.usage
              ? {
                  ...event.usage,
                  cache_read_input_tokens: event.usage.cached_input_tokens || 0,
                  cache_creation_input_tokens: event.usage.cache_write_input_tokens || 0,
                }
              : null;
            if (claudeUsage) {
              console.log(`[${taskId}] usage: in=${claudeUsage.input_tokens} out=${claudeUsage.output_tokens} cache_read=${claudeUsage.cache_read_input_tokens} cache_write=${claudeUsage.cache_creation_input_tokens}`);
            }
          } else if (event.type === 'turn.failed' || event.type === 'error') {
            console.warn(`[${taskId}] codex ${event.type}:`, JSON.stringify(event).slice(0, 500));
            codexErrorMsg = event.error?.message || event.message || codexErrorMsg;
          }
          continue;
        }
        if (event.type === 'result') {
          terminalSuccess = !event.is_error && (!event.subtype || event.subtype === 'success');
          claudeResult = typeof event.result === 'string' ? event.result : null;
          claudeUsage = event.usage || null;
          if (event.is_error) {
            // Real provider error text — the only thing auth detection may trust. Also log it:
            // the exit-1 + zero-usage bursts (auth loss) were previously undiagnosable because
            // only `usage: in=0 out=0` was printed, never the error string (#1227 / #1228).
            claudeErrorText = claudeResult || event.subtype || null;
            console.warn(`[${taskId}] result error: ${(claudeErrorText || '').slice(0, 500)}`);
          }
          if (claudeUsage) {
            console.log(`[${taskId}] usage: in=${claudeUsage.input_tokens} out=${claudeUsage.output_tokens} cache_read=${claudeUsage.cache_read_input_tokens || 0} cache_write=${claudeUsage.cache_creation_input_tokens || 0}`);
          }
        } else if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
          if (event.message?.model && !claudeModel) claudeModel = event.message.model;
          let turnText = '';
          for (const block of event.message.content) {
            if (block.type === 'text') {
              fullOutput.text += block.text;
              turnText += block.text;
              if (outputCallback) try { outputCallback(block.text); } catch {}
            } else if (block.type === 'tool_use') {
              countToolCall(block.name);
              lastActivity = formatToolActivity(block.name, block.input);
              reportProgress(lastActivity);
              if (!outputStarted && msgId) {
                const secs = Math.round((Date.now() - thinkingStart) / 1000);
                if (secs >= STOP_BUTTON_AFTER_SECS) stopButtonShown = true;
                progressEdit(BOT_TOKEN, chatId, msgId, `🧠 ⚡ ${lastActivity} (${secs}с)`, stopButtonShown ? runningControls(taskId, inputMessageId, sessionId) : { reply_markup: { inline_keyboard: inputInspectionRows(inputMessageId, sessionId) } }).catch(() => {});
              }
            }
          }
          // Only treat as a final-answer candidate if the turn has no tool calls.
          // Text + tool_use in the same event = narration ("Смотрю X:"), not a conclusion.
          const turnHasTool = event.message.content.some(b => b.type === 'tool_use');
          // Claude emits text and tool blocks separately, with stop_reason=tool_use
          // even on the text-only event. A later tool event also invalidates old text.
          if (turnHasTool || event.message.stop_reason === 'tool_use') lastAssistantMsg = '';
          else if (turnText.trim() && event.message.stop_reason === 'end_turn') lastAssistantMsg = turnText;
          scheduleStream();
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) {
          outputPersistenceError = error;
          try { proc.kill('SIGTERM'); } catch {}
          continue;
        }
        if (!firstJsonEventSeen) {
          console.warn(`[${taskId}] pre-JSON stdout:`, line);
          continue;
        }
        // Non-JSON line after stream started — treat as plain text
        fullOutput.text += line + '\n';
        scheduleStream();
      }
    }
  }
  proc.stdout.on('data', chunk => { lastOutputAt = Date.now(); consumeOutput(chunk); });
  proc.stdout.on('end', () => consumeOutput('', true));

  proc.stderr.on('data', chunk => console.error(`[${taskId}] stderr:`, chunk.toString()));

  let timedOut = false;
  // username + audience: exact-match keys for stop/running isolation across bots
  // (issue #1302 §3.2) — chatId alone can collide across audiences (private-chat
  // chatId == Telegram user id, identical regardless of which bot is messaged).
  // `slot` — run-as пользователь этого рана: под изоляцией `proc` это sudo-обёртка,
  // и убить движок можно только сигналом слоту (см. runner/engine-stop.js).
  // `threadId` нужен taskOwnedBy для топик-скоупа (#255) — без него «стоп» в
  // топике A убивал бы задачу топика B.
  // pgid процессной группы (детач-спавн выше): Стоп сигналит группу по нему —
  // см. engine-stop.js. pid валиден, пока процесс не вышел; после выхода
  // groupSignal получает ESRCH и просто ничего не делает.
  const sessionState = { killFn: null, killTimer: null, extendCount: 0, proc, pgid: proc.pid, userStopped: false, chatId, threadId: runThreadId, sessionId, username: user.username, audience: user.audience || 'default', slot: isolation.runAs || null, slotLease };
  activeTimers.set(taskId, sessionState);
  // A Stop that arrived before the process existed (queued web Stop) lands now.
  if (consumePendingStop?.()) {
    stopEngineProcess(sessionState);
  }
  try {
    await new Promise((resolve, reject) => {
      // warn fires 2 min before the hard cap (default 38 min; shorter for a P3a
      // step budget): graceful SIGTERM + warn user. Claude Code handles SIGTERM by
      // finishing current step and exiting. timedOut is set here so that if Claude
      // exits voluntarily after SIGTERM, the close handler still triggers
      // auto-continuation (not just when SIGKILL fires at the hard cap).
      const warnTimer = setTimeout(() => {
        timedOut = true;
        console.log(`[${taskId}] timeout warning — sending SIGTERM, ${warnLeftMin} min left`);
        try { proc.kill('SIGTERM'); } catch {}
        const warnMin = Math.round(warnTimeoutMs / 60000);
        const engineLabel = engine === 'codex' ? 'Кодекс' : engine === 'opencode' ? 'OpenCode' : 'Клод';
        sendT(BOT_TOKEN, chatId,
          `⚠️ ${engineLabel} работает уже ${warnMin} минут — через ${warnLeftMin} мин задача принудительно завершится.\n` +
          `Получил сигнал завершить текущий шаг и вывести итоги.`
        ).catch(() => {});
      }, warnTimeoutMs);

      // Hard kill (SIGTERM already sent at warn, SIGKILL now)
      sessionState.killFn = () => {
        timedOut = true;
        clearTimeout(warnTimer);
        try { proc.kill('SIGKILL'); } catch (e) { console.warn('[runner] SIGKILL:', e.message); }
        reject(new Error(`claude timed out after ${hardTimeoutMs / 1000}s`));
      };
      sessionState.killTimer = setTimeout(sessionState.killFn, hardTimeoutMs);

      // Inactivity check: if no stdout for 5 min, kill + auto-restart (works for all engines).
      // Checked every 30s; lastOutputAt updated on any raw stdout chunk before JSON parsing.
      // Same tick also heartbeats the pending-task journal (issue #942 [011] watchdog step 1a) —
      // piggybacking on this existing interval instead of adding a second timer.
      inactivityCheckTimer = setInterval(() => {
        if (onHeartbeat) { try { onHeartbeat(); } catch (e) { console.warn(`[${taskId}] heartbeat write failed:`, e.message); } }
        if (timedOut || sessionState.userStopped) return;
        const silentMs = Date.now() - Math.max(lastOutputAt, lastKeepaliveAt(keepaliveFile));
        if (silentMs >= INACTIVITY_TIMEOUT_MS) {
          clearInterval(inactivityCheckTimer); inactivityCheckTimer = null;
          inactivityKill = true;
          timedOut = true;
          const silentMins = Math.round(silentMs / 60000);
          console.warn(`[${taskId}] inactivity: no stdout for ${silentMins}min — SIGTERM`);
          try { proc.kill('SIGTERM'); } catch {}
          reject(new Error(`inactivity timeout: no output for ${silentMins}min`));
        }
      }, 30_000);

      // Zombie watchdog: codex spawns codex-code-mode-host which inherits the
      // stdout pipe, so proc.on('close') may NEVER fire even after the engine
      // process is dead. That leaves this promise hanging, which means finally /
      // stopProgress() never run, the progress timer keeps editing its message
      // for the rest of the 40-min killTimer, and the per-chat lane stays held
      // ("Думаю… (742с)" + "(3с)" overlap in one chat). exitCode is set by the
      // runtime the moment the engine dies, independent of the pipe — poll it
      // and finish the run as `close` would. Grace period lets a well-behaved
      // `close` fire first (it normally arrives within ms); we only force when
      // the pipe genuinely stalls.
      let exitWatcher = null;
      let engineDiedAt = null;
      let settled = false;

      proc.on('close', (code, signal) => {
        if (exitWatcher) { clearInterval(exitWatcher); exitWatcher = null; }
        processSignal = signal;
        clearTimeout(sessionState.killTimer);
        clearTimeout(warnTimer);
        clearInterval(inactivityCheckTimer); inactivityCheckTimer = null;
        if (code !== null && code !== 0) {
          console.error(`[${taskId}] claude exited with code ${code}`);
          exitCode = code;
        }
        // If SIGTERM already fired (timedOut=true), reject so the caller runs auto-continuation
        if (timedOut && !restartShutdown()) {
          reject(new Error(`claude exited after SIGTERM (code ${code})`));
        } else {
          resolve(code);
        }
      });
      proc.on('error', (err) => {
        if (exitWatcher) { clearInterval(exitWatcher); exitWatcher = null; }
        clearTimeout(sessionState.killTimer);
        clearTimeout(warnTimer);
        reject(err);
      });

      exitWatcher = setInterval(() => {
        if (settled) { clearInterval(exitWatcher); return; }
        if (proc.exitCode === null) return; // engine still alive
        const now = Date.now();
        if (engineDiedAt === null) engineDiedAt = now;
        if (now - engineDiedAt < 3000) return; // give close a grace period
        settled = true;
        clearInterval(exitWatcher);
        clearTimeout(sessionState.killTimer);
        clearTimeout(warnTimer);
        clearInterval(inactivityCheckTimer); inactivityCheckTimer = null;
        const code = proc.exitCode;
        exitCode = code; // mirror the close handler so the caller reports the real exit
        processSignal = null;
        console.warn(`[${taskId}] engine exited (code=${code}) but close stalled (host holds pipe?) — force-finishing`);
        if (timedOut && !restartShutdown()) {
          reject(new Error(`claude exited after SIGTERM (code ${code})`));
        } else {
          resolve(code);
        }
      }, 1000);
    });
  } catch (err) {
    processError = err.message;
    await stopProgress();
    console.error(`[${taskId}] claude process error:`, err.message);
  } finally {
    isolation.release(); // idempotent; also covers the stalled-close path
    activeTimers.delete(taskId);
    await stopProgress();
    heartbeatTimer = null;
    try { fs.unlinkSync(keepaliveFile); } catch {}
  }

  return {
    fullOutput, lastAssistantMsg, claudeResult, claudeErrorText, engineSessionId, terminalSuccess,
    claudeUsage, opencodeUsage, opencodeBreakdown, claudeModel,
    lastActivity, exitCode, processSignal, processError, timedOut,
    inactivityKill, loopKilled, toolBudgetKilled, outputPersistenceError, codexErrorMsg, sessionState,
  };
}

module.exports = {
  persistOpencodePart,
  runEngineProcess,
  resolveLadderApp,
  LADDER_APP,
  isNoopBash,
  buildEngineCommand,
  resolveEngineCwd,
  formatToolActivity,
  readOcAgentModels,
  computeEngineTimeoutMs,
  // exposed for tests — MCP translation helpers (codex/opencode wiring)
  codexMcpArgs,
  withCodexMcpEnvForwarding,
  writeOpencodeMcpConfig,
  // exposed for tests — OpenCode Go key rotation (one key per run, never the comma list)
  goApiKey,
  // exposed for tests — ⛔/➕ button delivery gate (issue: flag used to flip
  // before confirming the edit landed, permanently hiding buttons after one
  // 429/coalesce drop)
  editLanded,
  runningControls,
  inputInspectionRows,
  controlKey,
  // constants exposed for tests
  _const: { STREAM_INTERVAL_MS, HEARTBEAT_INTERVAL_MS, STOP_BUTTON_AFTER_SECS, MAX_MSG_LEN, CLAUDE_TIMEOUT_MS, WARN_TIMEOUT_MS, INACTIVITY_TIMEOUT_MS, MCP_TOOL_TIMEOUT_MS, LOOP_GUARD_REPEAT_LIMIT, LOOP_GUARD_TEXT_MIN_LEN, LOOP_GUARD_NOOP_LIMIT },
};
