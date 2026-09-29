'use strict';
// System prompt assembly for one run — moved verbatim out of runner/index.js _runTask.
// Layers, in order: base agent-system-prompt.txt + per-profile persona → the bound
// project's PROFILE.md → prompt-domain rules for skills this user actually has (+ the
// skills-shadow observation) → the answer-router mode block → (OpenCode only) the
// runtime capabilities block. Layered files are written to <workDir>/.system-prompt.txt
// (mode 0600), exactly as before.
const fs = require('fs');
const path = require('path');
const projects = require('../projects');
const persona = require('../persona');
const answerRouter = require('../answer-router');
const promptDomains = require('../prompt-domains');
const skillsShadow = require('../skills/shadow');
const { atomicText } = require('../atomic-json');

// MCP server names actually wired into this run (the same .mcp.json the engine gets —
// opencode's OPENCODE_CONFIG is built from it). Accepts a path or a parsed config.
function mcpServerNames(mcpConfig) {
  try {
    const cfg = typeof mcpConfig === 'string' ? JSON.parse(fs.readFileSync(mcpConfig, 'utf8')) : mcpConfig;
    return Object.keys((cfg && cfg.mcpServers) || {});
  } catch { return []; }
}

// Builds a runtime capabilities addendum for OpenCode system prompt.
// OpenCode uses non-Claude models that don't auto-read CLAUDE.md, so we inject what's available.
// The MCP line is derived from the run's real MCP config, never hardcoded: a stale
// «кастомные скилы для OpenCode НЕ подключены» next to a tool list that DOES contain them
// made a DeepSeek run fake the tool call with no-op bash (`true`, `echo ok`) for minutes
// instead of calling trained-skills_playbook_get (2026-09-29).
function buildOcCapabilitiesBlock(secrets, mcpConfig) {
  const lines = ['## Возможности системы (runtime)'];

  if (secrets && secrets.DEEPGRAM_API_KEY) {
    lines.push(
      '',
      '**Транскрибация аудио:** доступна (Deepgram nova-2)',
      '• Поддерживает русский и другие языки',
      '• Форматы: mp3, wav, ogg, m4a, голосовые сообщения Telegram',
      '• Быстро, точнее Whisper, с пунктуацией и разбивкой по абзацам',
      '• Пользователь присылает аудиофайл → бот транскрибирует → текст попадает к тебе',
    );
  }

  if (secrets && secrets.OPENROUTER_API_KEY) {
    lines.push(
      '',
      '**Распознавание изображений:** доступно (Gemini 2.5 Flash)',
      '• Ты сам не видишь картинки — но текст/описание с фото уже распознан заранее',
      '• Присланное фото приходит вместе с заметкой «[Файл сохранён: …]» и, если что-то распозналось,',
      '  блоком «[Распознано на изображении: …]» прямо под ней — читай его, отдельно открывать файл не нужно',
      '• Если блока с распознаванием нет — на фото не нашлось ни текста, ни узнаваемой сцены',
    );
  }

  const servers = mcpServerNames(mcpConfig);
  lines.push('');
  if (servers.length) {
    lines.push(
      `**Инструменты (MCP):** подключены серверы ${servers.join(', ')}.`,
      'Их тулы вызываются напрямую как обычный инструмент по имени `<сервер>_<тул>`',
      '(например `trained-skills_playbook_get`), а не через bash.',
    );
  } else {
    lines.push('**Инструменты (MCP):** в этом запуске MCP-серверы не подключены.');
  }
  lines.push(
    'Если нужного тула нет в твоём списке инструментов — прямо скажи об этом пользователю.',
    'Никогда не имитируй вызов тула командами bash (`true`, `echo …`) — это не выполняет действие.',
  );

  return lines.join('\n');
}

function assembleSystemPrompt({ user, boundProjectId, mcpConfig, activeSessionId, explicitMode, internalGtd, engine, secrets }) {
  const basePromptFile = path.join(__dirname, '..', 'agent-system-prompt.txt');
  // Merge the user's per-profile persona into the system prompt (returns base file if none set).
  let systemPromptFile = persona.buildSystemPromptFile(user.workDir, basePromptFile, user.audience);
  // Fold the bound project's PROFILE.md (domain rules) on top of the persona-merged prompt.
  try {
    const profileTxt = boundProjectId ? projects.profileText(user.workDir, boundProjectId) : null;
    if (profileTxt) {
      const meta = projects.getProject(user.workDir, boundProjectId);
      const baseTxt = systemPromptFile && fs.existsSync(systemPromptFile) ? fs.readFileSync(systemPromptFile, 'utf8') : '';
      const merged = baseTxt +
        `\n\n# ПРОЕКТ: ${meta ? meta.name : boundProjectId} (${meta ? meta.label : 'project'}) — доменные правила\n` +
        profileTxt + '\n';
      const out = path.join(user.workDir, '.system-prompt.txt');
      atomicText(out, merged, { mode: 0o600 });
      systemPromptFile = out;
    }
  } catch (e) { console.warn('[runner] project profile merge:', e.message); }

  // Domain skill rules (src/prompt-domains): only for skills this user actually has —
  // gated by the same isReady() as the tools in .mcp.json (system-prompt diet).
  const domainReport = {};
  try {
    const domainBlock = promptDomains.buildDomainBlock(mcpConfig, { report: domainReport });
    if (domainBlock) {
      const baseTxt = systemPromptFile && fs.existsSync(systemPromptFile) ? fs.readFileSync(systemPromptFile, 'utf8') : '';
      const out = path.join(user.workDir, '.system-prompt.txt');
      atomicText(out, baseTxt + '\n\n' + domainBlock, { mode: 0o600 });
      systemPromptFile = out;
    }
  } catch (e) { console.warn('[runner] prompt domains:', e.message); }

  // Skills shadow (#1537 PR-A): resolve the skill catalog and log its diff against what
  // was just exposed above. Observation only — runShadow never throws, changes nothing.
  try {
    skillsShadow.runShadow({ workDir: user.workDir, username: user.username, audience: user.audience,
      mcpConfigPath: mcpConfig, domainReport });
  } catch { /* never affects the run */ }

  // Answer router: вставить блок режима в системный промпт для этого хода.
  //  • clarify (транзиентно, этот ход) → блок вопросов, приоритетнее deep.
  //  • deep (sticky, из durable-сайдкара) → снять cap «2-3 предложения».
  //  • иначе → one-shot, промпт без изменений.
  try {
    const deepSticky = answerRouter.readMode(user.workDir, activeSessionId)?.mode === 'deep';
    // internalGtd ходы — уже «дожим до конца», им oneshot-гард про research не нужен.
    // Но если это internalGtd ВНУТРИ deep-сессии, кнопка «Действуй дальше» всё равно
    // программно подавлена (см. §C ниже) — предупреждаем Claude отдельной заметкой,
    // иначе он пишет про кнопку, которой не будет (баг от 2026-09-15).
    const block = explicitMode === 'clarify' ? answerRouter.buildClarifyBlock()
                : deepSticky && internalGtd   ? answerRouter.buildDeepBlock() + '\n' + answerRouter.buildGtdNoButtonNote()
                : deepSticky                  ? answerRouter.buildDeepBlock()
                : internalGtd                 ? null
                : answerRouter.buildOneshotBlock();
    if (block) {
      const baseTxt = systemPromptFile && fs.existsSync(systemPromptFile) ? fs.readFileSync(systemPromptFile, 'utf8') : '';
      const merged = baseTxt + '\n' + block + '\n';
      const out = path.join(user.workDir, '.system-prompt.txt');
      atomicText(out, merged, { mode: 0o600 });
      systemPromptFile = out;
    }
  } catch (e) { console.warn('[runner] answer-router block:', e.message); }

  const systemPromptText = systemPromptFile && fs.existsSync(systemPromptFile) ? fs.readFileSync(systemPromptFile, 'utf8') : '';

  // OpenCode uses non-Claude models (DeepSeek, GigaChat, etc.) that don't auto-read CLAUDE.md.
  // Inject a runtime capabilities block so they know what's actually available.
  const ocCapBlock = engine === 'opencode' ? buildOcCapabilitiesBlock(secrets, mcpConfig) : '';
  const ocSystemPrompt = ocCapBlock
    ? (systemPromptText ? `${systemPromptText}\n\n${ocCapBlock}` : ocCapBlock)
    : systemPromptText;

  return { systemPromptFile, systemPromptText, ocCapBlock, ocSystemPrompt };
}

module.exports = { assembleSystemPrompt, buildOcCapabilitiesBlock, mcpServerNames };
