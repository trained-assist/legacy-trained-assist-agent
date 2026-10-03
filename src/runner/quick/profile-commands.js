'use strict';
// Profile / chat commands answered without Claude: /persona, /get_webpass, /project,
// /settings, engine switch (/switch2klod, /switch2codex, …), /get_agent_info (+ «какая
// у тебя модель?»), /oc_* profile switches. Moved verbatim from runner/intent-engine.js;
// intent-engine calls profileCommandsAnswer() at the same point in its check order.
// Returns the reply — a string, or null (= hand the message to the agent) — or
// undefined when the message is none of these commands.
const fs = require('fs');
const os = require('os');
const path = require('path');
const projects = require('../../projects');
const persona = require('../../persona');
const profiles = require('../../profiles');
const { savePassword: saveWebPassword, generatePassword: genWebPassword, generateMagicToken } = require('../../web-auth');
const { fuzzyInfoIntent } = require('./fuzzy');

// /persona command (aliases /role /роль /персона /character /характер). Cyrillic word boundaries:
// JS \b doesn't fire after a Cyrillic letter, so terminate the command with (?=\s|$) instead of \b.
const PERSONA_INTENT        = /^\/(?:persona|role|роль|персона|character|характер)(?=\s|$)/i;
// Published guide: what a persona is + how to write a good one (patterns/examples).
const PERSONA_GUIDE_URL     = 'https://instant-publish.trainedassist.store/p/persona-guide';
// /project — list / switch / create projects. Lets the user steer which project new
// sessions bind to (see projects.js + the project-binding block in run()).
const PROJECT_INTENT        = /^\/(?:projects?|проекты?|проект)(?=\s|$)/i;
// /settings — effective chat config (pinned project, engine, role, saved memory). Read-only.
const SETTINGS_INTENT       = /^\/(?:settings|config|настройки|конфиг)(?:@\S+)?$|^(?:покажи\s+)?(?:мои\s+)?(?:настройки|конфиг(?:урацию)?)(?:\s+(?:чата|агента|ассистента))?\s*\??$|^(?:get\s+config|user\s+settings|show\s+settings)$/i;
// /switch2klod, /switch2codex (or natural "switch to codex" / "переключись на клод") — which
// CLI (Claude Code vs Codex) runs THIS CHAT's tasks going forward. Any profile can flip its
// own chat — unlike CLI_USAGE_INTENT above, this isn't reading the operator's shared VM
// subscription, it's a per-profile setting. Storage: profile.json engineByChat[chatId]
// (see profiles.getEngine/setEngine) — falls back to the profile-wide `engine` default
// (scripts/set-engine.mjs) when this chat has no override. A task already running keeps
// its engine; the switch takes effect on the next task started in this chat.
// \b doesn't fire after a Cyrillic letter in JS, so both alternatives end on
// (?=\s|$) instead (same fix as PERSONA_INTENT above).
const ENGINE_SWITCH_INTENT  = /^\/?switch\s*2\s*(klod|codex|opencode|клод|кодекс)(?:@\S+)?(?=\s|$)|(?:переключ\S*|switch)\s+(?:меня\s+)?(?:на|to)\s+(klod|claude|codex|opencode|клод|кодекс)(?=\s|$)/i;
const OC_PROFILE_INTENT = /^\/oc_(service|max|value|free|russian-recruiter|russian|recruiter|rr|ru|quality|mimo|lavish-luna|ll|q|x|deepseek_openrouter|deepseek_go|ds_or|ds_go|deepseek|ds)(?:@\S+)?\b|^\/oc\s+(service|max|value|free|russian-recruiter|russian|recruiter|rr|ru|quality|mimo|lavish-luna|ll|q|x|deepseek_openrouter|deepseek_go|ds_or|ds_go|deepseek|ds)\b/i;
// /oc_go, /oc_openrouter — used to flip a VM-wide go/openrouter toggle; removed 2026-09-27 (a
// sticky manual /oc_openrouter drained the OpenRouter balance). /oc_go now just selects the
// service profile (Go first); /oc_openrouter only explains that OpenRouter is the ladder's
// automatic last rung.
const OC_GO_TOGGLE_INTENT = /^\/oc_(go|openrouter)(?:@\S+)?\b/i;
const OPENROUTER_RETIRED_MSG = 'ℹ️ Ручного переключения на OpenRouter больше нет. Профиль service идёт через llm-ladder — он сам держит ключи и ротацию, выбирает ступень и уходит на OpenRouter только когда бесплатные ступени кончились, а потом возвращается сам. У агента ключей провайдеров нет.';
const AGENT_INFO_INTENT = /^\/(?:get_agent_info|agent_info|info)(?:@\S+)?(?=\s|$)/i;
// Natural-language "what model/agent are you?" — «на какой модели ты сейчас работаешь?»,
// «какая у тебя модель», «какой моделью пользуешься», «какой ты агент». Maps to the same
// agent-info block as /agent_info (model/engine/version). Non-slash matches pass through the
// cheap-LLM verify gate (verifyQuickAnswerIntent) before being sent, so a slightly loose
// regex is safe: real tasks that merely mention "модель" get rejected by the gate and
// still reach Claude.
const MODEL_INFO_INTENT = /(?:на\s+какой\s+(?:модел|нейросет|llm)|какая\s+у\s+тебя\s+(?:модел|нейросет|llm)|какую\s+модел\S*\s+(?:ты\s+)?(?:используеш|юзаеш|ставиш)|какой\s+модел\S*\s+(?:ты\s+)?(?:работаеш|пользуеш|сидиш)|на\s+какой\s+нейросет|что\s+за\s+(?:модел|нейросет)|какой\s+ты\s+агент|какая\s+ты\s+нейросет)/i;

// /get_webpass — PURE SELF-SERVICE for every user. Generates + reveals a fresh web password
// for the CALLER'S OWN profile, writing it to ~/agent-tokens/<user>/.webpasswd (the SAME
// store the site verifies against via POST /web/verify). This is the single fix for "the
// site password only exists for 2 of 11 profiles" — any user mints a working password on
// demand. The password store is scrypt-hashed (one-way), so this always ROTATES: each call
// sets a new password and the previous one dies.
// Deliberately NO cross-profile targeting and NO admin/chat-id gate: resetting your own
// credential can't escalate anything, and every user can self-serve, so cross-profile
// issuance is redundant. This also kills the group-chat-id / @botname gating that kept
// breaking. Tolerate a trailing @botname (Telegram appends it in groups) + ignore any args.
const GET_WEBPASS_INTENT    = /^\/(?:get_webpass|webpass|вебпароль)(?:@\S+)?(?=\s|$)/i;

// The static ANTHROPIC_MODEL env can name a model Claude Code doesn't actually run (a
// retired/unauthorised id makes the CLI fall back to its own default). Prefer the model the
// last completed claude task really used, from the per-profile usage log (recordUsage stores
// claudeModel); fall back to the env only when there's no history yet.
function lastClaudeModel(workDir) {
  if (!workDir) return null;
  try {
    const log = require('../../usage-store').getUsageLog(workDir);
    for (let i = log.length - 1; i >= 0; i--) {
      if ((log[i].engine || 'claude') === 'claude' && log[i].model) return log[i].model;
    }
  } catch (e) { /* usage log is best-effort */ }
  return null;
}

// /settings — human-readable effective configuration of THIS chat. Every line maps to a
// real on-disk source (pin-*.json, profile.json, persona.md, agent-notes.md, contexts/…) so
// the user sees what actually persists, not what the model claims it "remembered".
function renderChatSettings({ userId, workDir, chatId, audience = 'default', threadId = null }) {
  const clip = (t, n) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
  const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } };
  const out = ['⚙️ Настройки этого чата', ''];

  // Project
  const pinnedId = projects.getPinnedProjectId(workDir, chatId, audience, threadId);
  const lastId = projects.getActiveProjectId(workDir, chatId, audience, threadId);
  const pname = (id) => { const m = id && projects.getProject(workDir, id); return m ? m.name : id; };
  out.push('📁 Проект');
  out.push(pinnedId
    ? `• Закреплён: «${pname(pinnedId)}» — новые задачи идут в него`
    : `• Не закреплён — выбирается автоматически${lastId ? ` (последний: «${pname(lastId)}»)` : ''}`);
  out.push(`• Всего проектов: ${projects.listProjects(workDir, audience).length}`);
  out.push('');

  // Behaviour
  const eng = profiles.getEngine(workDir, chatId);
  const engLabel = eng === 'codex' ? 'Codex CLI' : eng === 'opencode' ? `OpenCode (профиль ${profiles.getOcProfile(workDir) || 'по умолчанию'})` : 'Claude Code';
  const role = persona.load(workDir);
  out.push('🤖 Поведение агента');
  out.push(`• Движок: ${engLabel}`);
  out.push(`• Роль: ${role ? `«${clip(role, 90)}»` : 'не задана'}`);
  out.push(`• Карточка контекста: ${fs.existsSync(path.join(workDir, '.context_disabled')) ? 'выключена' : 'включена'}`);
  out.push('');

  // Saved memory — the layers injected into every new session
  out.push('🧠 Что реально сохранено (подмешивается в каждую новую сессию)');
  const notes = read(path.join(workDir, 'agent-notes.md'));
  const heads = notes ? (notes.match(/^##\s+.+$/gm) || []).map(h => h.replace(/^##\s+/, '')) : [];
  out.push(notes
    ? `• Заметки агента (весь профиль): ${heads.length || notes.split('\n').length} ${heads.length ? 'тем' : 'строк'}${heads.length ? ` — последние: ${heads.slice(-3).map(h => `«${clip(h, 50)}»`).join(', ')}` : ''}`
    : '• Заметки агента (весь профиль): пусто');
  const projForNotes = pinnedId || lastId;
  const pnotes = projForNotes ? projects.notesText(workDir, projForNotes) : null;
  out.push(`• Заметки проекта${projForNotes ? ` «${pname(projForNotes)}»` : ''}: ${pnotes ? `${pnotes.split('\n').filter(Boolean).length} строк` : 'пусто'}`);
  const req = read(path.join(workDir, 'requirements-log.md'));
  const reqN = (req.match(/^\*\*\[\d+\]\*\*/gm) || []).length;
  out.push(`• Лог требований/фич: ${reqN ? `${reqN} записей` : 'пусто'}`);
  try {
    const root = path.join(workDir, 'contexts');
    const keys = [];
    for (const skill of fs.readdirSync(root)) {
      let files = [];
      try { files = fs.readdirSync(path.join(root, skill)); } catch { continue; }
      for (const f of files) if (f.endsWith('.json')) keys.push(`${skill}/${f.replace(/\.json$/, '')}`);
    }
    out.push(`• Контекст скилов: ${keys.length ? `${clip(keys.slice(0, 8).join(', '), 300)}${keys.length > 8 ? ` и ещё ${keys.length - 8}` : ''}` : 'пусто'}`);
  } catch { out.push('• Контекст скилов: пусто'); }
  out.push('');
  out.push('Управление: `/project` — проект · `/project unpin` — снять закрепление · `/persona` — роль · `/switch2klod` / `/switch2codex` — движок · `/context_on` / `/context_off` — карточка');
  return out.join('\n');
}

// /oc_* changes the OpenCode MODEL profile — but a user reaching for it is switching TO OpenCode.
// Before this, the command left the chat's engine untouched: a chat pinned to codex (e.g. one
// that just hit Codex's usage limit) stayed on codex, so "переключение" appeared to do nothing and
// the next task kept failing on the old engine (bug report 2026-09-25, chat shown with /oc_deepseek
// → "⛔️ Codex: You've hit your usage limit"). Make the intent explicit: /oc_* also moves THIS
// chat's engine to opencode. Returns an explanatory suffix for the reply, or '' if already opencode.
function switchChatEngineToOpencode(workDir, chatId) {
  const prev = profiles.getEngine(workDir, chatId);
  if (prev === 'opencode') return '';
  profiles.setEngine(workDir, 'opencode', chatId);
  const label = prev === 'codex' ? 'Codex CLI' : 'Claude Code';
  return `\n🔀 Движок этого чата переключён с ${label} на OpenCode — следующая задача пойдёт через него.`;
}

function profileCommandsAnswer(task, { userId, workDir, chatId = null, audience = 'default', threadId = null } = {}) {
  // /persona — view / set / clear the assistant's per-profile role. Injected into the
  // system prompt of every session (see spawn below). Sync file ops, safe in getQuickAnswer.
  if (PERSONA_INTENT.test(task)) {
    if (!workDir) return 'Не удалось определить рабочую директорию. Попробуй ещё раз.';
    const rest = task.replace(PERSONA_INTENT, '').trim();
    if (!rest) {
      const cur = persona.load(workDir);
      if (!cur) {
        return [
          '🎭 Роль ассистента не задана.',
          '',
          'Как задать:',
          '• Инлайн: `/persona Ты — рекрутер-аналитик. Оцениваешь кандидатов по фактам…`',
          '• Реплаем: ответь этой командой на сообщение с текстом роли — бот возьмёт его как роль (удобно для длинных абзацев).',
          '• Убрать: `/persona clear`',
          '',
          '📖 Что такое персона и как её правильно составить (паттерны + примеры): ' + PERSONA_GUIDE_URL,
        ].join('\n');
      }
      return `🎭 Текущая роль ассистента:\n\n${cur}\n\nИзменить: \`/persona <текст>\` (или реплаем на сообщение с ролью) · убрать: \`/persona clear\`\n\n📖 Как составить хорошую персону: ${PERSONA_GUIDE_URL}`;
    }
    if (/^(clear|сброс|reset|убери|удали)$/i.test(rest)) {
      const had = persona.clear(workDir);
      return had ? '🎭 Роль ассистента убрана. Дальше — базовое поведение.' : '🎭 Роль и так не была задана.';
    }
    const saved = persona.save(workDir, rest);
    return `✅ Роль ассистента сохранена (${saved.length} симв). Применяется с этой сессии в каждом ответе.\n\nПоказать: \`/persona\` · убрать: \`/persona clear\``;
  }

  // /get_webpass — PURE SELF-SERVICE. Issue a fresh web-UI password for the CALLER'S OWN
  // profile. Closes [028]/[029]: 9 of 11 profiles never had a .webpasswd, so the site (which
  // delegates to /web/verify against that store) had nothing to check → 401. Any user mints
  // a working password on demand; the site picks it up with no sync. No cross-profile
  // targeting, no admin/chat-id gate (see comment on GET_WEBPASS_INTENT) — any trailing arg
  // is ignored, the password is always for `userId` (the profile bound to this session).
  if (GET_WEBPASS_INTENT.test(task)) {
    const target = (userId || '').trim();
    if (!target) return 'Не удалось определить профиль. Попробуй ещё раз.';
    // Generate a magic one-click login link (15 min TTL) + password as fallback
    const magicToken = generateMagicToken(target);
    const publicUrl = process.env.AGENT_PUBLIC_URL || 'https://recruiter-assistant.ru';
    const magicUrl = `${publicUrl}/web/magic?t=${magicToken}`;
    // Also save a password as backup (in case token expires)
    const pass = genWebPassword();
    saveWebPassword(target, pass);
    return [
      `🌐 Войди в веб-интерфейс:`,
      '',
      `👉 [Открыть и войти автоматически](${magicUrl})`,
      '',
      `_(Ссылка одноразовая, действует 15 минут)_`,
      '',
      `Или войди вручную на ${publicUrl.replace(/^https?:\/\//, '').replace(/\/.*/, '')}: логин \`${target}\`, пароль \`${pass}\``,
    ].join('\n');
  }

  // /project — show / pin / unpin / create / rename the chat's project. The PINNED project
  // (pin-*.json, explicit user choice) decides which project NEW tasks of this chat bind to;
  // without a pin the choice is automatic (single project, or the gateway asks). A running
  // session keeps its own project; pin changes affect new ones.
  if (PROJECT_INTENT.test(task)) {
    if (!workDir) return 'Не удалось определить рабочую директорию. Попробуй ещё раз.';
    const rest = task.replace(PROJECT_INTENT, '').trim();
    const list = projects.listProjects(workDir, audience);
    const pinnedId = projects.getPinnedProjectId(workDir, chatId, audience, threadId);
    const lastId = projects.getActiveProjectId(workDir, chatId, audience, threadId);
    const nameOf = (id) => { const p = list.find(x => x.id === id) || projects.getProject(workDir, id); return p ? p.name : id; };
    const PIN_HINT = 'Сменить: `/project <номер или название>` · снять закрепление: `/project unpin`';

    // create: /project new recruiting: Название
    const createMatch = rest.match(/^(?:new|new project|новый|создать|создай|create|add)\s+(.+)$/i);
    if (createMatch) {
      const meta = projects.createProject(workDir, createMatch[1].trim(), { audience });
      projects.setActiveProjectId(workDir, meta.id, chatId, { audience, pinned: true, threadId });
      return `✅ Проект «${meta.name}» создан и закреплён за этим чатом. Новые задачи по умолчанию будут относиться к нему.\n${PIN_HINT}`;
    }

    // rename: /project rename <номер|часть названия> = Новое имя  (locks against auto-naming)
    const renameMatch = rest.match(/^(?:rename|переименуй|переименовать|назови)\s+(.+?)\s*[=:]\s*(.+)$/i);
    if (renameMatch) {
      const q = renameMatch[1].trim(); const newName = renameMatch[2].trim();
      const num = /^\d+$/.test(q) ? parseInt(q, 10) : null;
      const tgt = (num && num >= 1 && num <= list.length) ? list[num - 1]
        : list.find(p => (p.name || '').toLowerCase().includes(q.toLowerCase()) || p.id.toLowerCase().includes(q.toLowerCase()));
      if (!tgt) return `Проект «${q}» не найден. Список: \`/project\``;
      const meta = projects.renameProject(workDir, tgt.id, newName);
      return `✏️ Переименовал: «${meta.name}». Авто-переименование для него теперь отключено.`;
    }

    // unpin: back to automatic project choice
    if (/^(?:unpin|off|auto|авто|открепи(?:ть)?|сними|снять|сброс|reset|clear)(?:\s|$)/i.test(rest)) {
      const had = projects.clearPinnedProjectId(workDir, chatId, { audience, threadId });
      return had
        ? `📍 Закрепление снято: «${nameOf(had)}» больше не закреплён за этим чатом. Проект для новых задач снова определяется автоматически.\nЗакрепить: \`/project <номер или название>\``
        : '📍 За этим чатом и так ничего не закреплено — проект определяется автоматически.';
    }

    // current: what is pinned right now
    if (/^(?:current|status|now|текущий|сейчас|какой)\s*\??$/i.test(rest)) {
      if (pinnedId) return `📌 За этим чатом закреплён проект «${nameOf(pinnedId)}». Новые задачи по умолчанию относятся к нему.\n${PIN_HINT}`;
      return `📍 Проект не закреплён — выбирается автоматически${lastId ? ` (последний использованный: «${nameOf(lastId)}»)` : ''}.\nЗакрепить: \`/project <номер или название>\``;
    }

    if (!rest) {
      if (list.length === 0) {
        return [
          '📁 Проектов пока нет.',
          '',
          'Создать: `/project new recruiting: Название` (тип задаётся префиксом — recruiting, generic).',
        ].join('\n');
      }
      // Rich rendering: name + the 3-sense summary (start → middle → end) so a long,
      // meandering project reads clearly. Falls back to the type label when no summary yet.
      const lines = list.map((p, i) => {
        const mark = p.id === pinnedId ? '📌' : (!pinnedId && p.id === lastId ? '▶️' : '  ');
        const head = `${mark} ${i + 1}. ${p.name}${p.type && p.type !== 'generic' ? ` · ${p.label}` : ''}`;
        const s = p.summary;
        if (!s || !s.start) return head;
        const parts = [s.start, s.middle, s.end].filter(Boolean).map(x => `      ${x}`);
        return [head, ...parts].join('\n');
      });
      const state = pinnedId
        ? `📌 Закреплён за этим чатом: «${nameOf(pinnedId)}» — новые задачи идут в него.`
        : `📍 Не закреплён — проект выбирается автоматически${lastId ? ` (▶️ последний: «${nameOf(lastId)}»)` : ''}.`;
      return [
        state,
        '',
        '📁 Проекты:',
        '',
        lines.join('\n\n'),
        '',
        'Закрепить: `/project <номер или название>`',
        'Снять закрепление: `/project unpin`',
        'Переименовать: `/project rename <номер> = Новое имя`',
        'Создать: `/project new recruiting: Название`',
      ].join('\n');
    }

    // pin: by list number or by id/name substring (optional «pin»/«закрепи» keyword)
    const q0 = rest.replace(/^(?:pin|закрепи(?:ть)?|switch|сменить\s+на|смени\s+на)\s+/i, '').replace(/^[«"']|[»"']$/g, '').trim();
    let target = null;
    const num = /^\d+$/.test(q0) ? parseInt(q0, 10) : null;
    if (num && num >= 1 && num <= list.length) {
      target = list[num - 1];
    } else {
      const q = q0.toLowerCase();
      target = list.find(p => p.id.toLowerCase() === q || (p.name || '').toLowerCase() === q)
        || list.find(p => (p.name || '').toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
    }
    if (!target) return `Проект «${q0}» не найден. Список проектов: \`/project\``;
    projects.setActiveProjectId(workDir, target.id, chatId, { audience, pinned: true, threadId });
    return `📌 Проект «${target.name}» закреплён за этим чатом. Новые задачи по умолчанию будут относиться к нему.\n${PIN_HINT}`;
  }

  // /settings (/config, /настройки) — the chat's EFFECTIVE configuration in human terms:
  // what is pinned, which engine/role applies, and what the agent has actually saved
  // (memory layers that get injected into every session). Read-only.
  if (SETTINGS_INTENT.test(task.trim())) {
    if (!workDir) return 'Не удалось определить рабочую директорию. Попробуй ещё раз.';
    return renderChatSettings({ userId, workDir, chatId, audience, threadId });
  }

  // /switch2klod, /switch2codex — see ENGINE_SWITCH_INTENT above.
  const engineSwitchM = task.trim().match(ENGINE_SWITCH_INTENT);
  if (engineSwitchM && workDir) {
    const raw = (engineSwitchM[1] || engineSwitchM[2] || '').toLowerCase();
    const engine = /^(codex|кодекс)$/.test(raw) ? 'codex' : raw === 'opencode' ? 'opencode' : 'claude';
    // /switch2klod while Claude may not run would store a preference that every task silently
    // overrides — «переключил на Claude» followed by an answer from another engine. Same admission
    // rule as the runner, answered here where the user is actually looking.
    if (engine === 'claude') {
      const { claudeAdmission } = require('../../engine-admission');
      const why = claudeAdmission();
      if (why.blocked) {
        const reason = why.reason === 'suspended' || why.reason === 'owner_switch_off'
          ? 'авторизация Claude не установлена (пока её не установили — Claude не вызывается)'
          : 'авторизация Claude сейчас не работает';
        return `⛔ Не переключаю на Claude Code: ${reason}. Работаю на ${profiles.getEngine(workDir, chatId) === 'codex' ? 'Codex CLI' : 'OpenCode'} — задачи выполняются как обычно.`;
      }
    }
    profiles.setEngine(workDir, engine, chatId);
    const label = engine === 'codex' ? 'Codex CLI' : engine === 'opencode' ? 'OpenCode' : 'Claude Code';
    return `🔀 Для этого чата переключил движок на ${label}.\nСледующая задача в этом чате пойдёт через него (текущая, если выполняется, — доработает на старом).`;
  }

  // /get_agent_info — show current engine, model, profile, VM, version
  // Also natural-language "what model/agent are you?" questions (MODEL_INFO_INTENT).
  if (AGENT_INFO_INTENT.test(task) || fuzzyInfoIntent(MODEL_INFO_INTENT, task)) {
    const eng = workDir ? profiles.getEngine(workDir, chatId) : 'claude';
    const vmName = process.env.VM_NAME || 'unknown';
    let commit = 'unknown';
    try { const sha = require('../../release-info').getReleaseSha(); if (sha) commit = sha.slice(0, 8); } catch {}
    const ocProfile = workDir ? profiles.getOcProfile(workDir) : 'не задан';
    const ocModel = process.env.OPENCODE_MODEL || (workDir ? require('../../opencode-ladder-provider').modelFor(ocProfile) : '(из профиля)');
    const engineLabel = eng === 'opencode' ? 'OpenCode' : eng === 'codex' ? 'Codex CLI' : 'Claude Code';
    const modelLine = eng === 'opencode'
      ? `🧠 Модель: \`${ocModel}\`\n📦 Профиль OC: ${ocProfile}`
      : eng === 'codex'
        ? `🧠 Модель: настроена в ~/.codex/config.toml (вне нашего профиля)`
        : `🧠 Модель: \`${lastClaudeModel(workDir) || process.env.ANTHROPIC_MODEL || 'claude-sonnet'}\``;
    return `🤖 Агент: \`${userId || '?'}\`\n🖥 VM: ${vmName}\n⚙️ Движок: ${engineLabel}\n${modelLine}\n🔖 Версия: \`${commit}\``;
  }

  // /oc_max, /oc_value, /oc_free, /oc_russian (aka /oc_ru) — switch OpenCode model profile for
  // THIS profile only (profiles.setOcProfile → profile.json ocProfile). Used to shell out to
  // opencode-switch-profile.sh, which overwrote one shared ~/.config/opencode/opencode.json
  // for every profile on the VM — fixed 2026-09-21: see writeOpencodeMcpConfig in
  // claude-runner.js, which now folds the chosen profile's models into the per-invocation
  // OPENCODE_CONFIG file instead.
  const ocProfileM = task.trim().match(OC_PROFILE_INTENT);
  if (ocProfileM && workDir) {
    const rawAlias = (ocProfileM[1] || ocProfileM[2] || '').toLowerCase();
    // Same alias table as infra/opencode-switch-profile.sh — quality/mimo/lavish-luna were
    // retired in #1061 Фаза 1 (folded into the service/doctor ladders as rungs, not standalone
    // profiles anymore), so those names get a helpful redirect instead of a raw 404.
    const RETIRED = new Set(['quality', 'mimo', 'lavish-luna', 'll', 'q']);
    if (RETIRED.has(rawAlias)) {
      return `⚠️ Профиль '${rawAlias}' упразднён в #1061 (стал ступенью лестницы service/doctor) — выбери service|doctor|free|russian.`;
    }
    // Profiles are named after the worker ladder (llm-ladder config/ladders.json), so the ladder
    // rename (#49/#101) renamed the profiles too. These aliases keep old muscle memory working —
    // ds/deepseek/value → service, x/max → doctor. `deepseek` is only the ladder's OLD name.
    const ALIASES = {
      ru: 'russian', recruiter: 'russian', rr: 'russian', 'russian-recruiter': 'russian',
      ds: 'service', ds_go: 'service', deepseek_go: 'service', deepseek: 'service', value: 'service',
      v: 'service', x: 'doctor', max: 'doctor',
    };
    const RENAMED = new Set(['ds', 'ds_go', 'deepseek_go', 'deepseek', 'value', 'v', 'x', 'max']);
    // Pinning a profile to OpenRouter is gone (2026-09-27) — OpenRouter is only the service
    // ladder's automatic last rung.
    if (rawAlias === 'ds_or' || rawAlias === 'deepseek_openrouter') return OPENROUTER_RETIRED_MSG;
    const raw = ALIASES[rawAlias] || rawAlias;
    if (!require('../../opencode-ladder-provider').PROFILES.includes(raw)) return `⚠️ Профиль '${raw}' не найден`;
    profiles.setOcProfile(workDir, raw);
    const engineNote = switchChatEngineToOpencode(workDir, chatId);
    // Rung order lives in the llm-ladder worker (#1687) — labels name the ladder, not models.
    const PROFILE_LABELS = {
      service:  'SERVICE (дефолт) — стандартная лестница (Go → платный хвост OpenRouter)',
      doctor:   'DOCTOR — сильнейшая лестница (модели Go)',
      free:     'FREE — дешёвые/бесплатные модели',
      russian:  'RUSSIAN — лестница service + строгий русскоязычный рецензент',
      research: 'RESEARCH — исследовательская лестница (Go-first)',
    };
    const label = PROFILE_LABELS[raw] || raw;
    const renamed = RENAMED.has(rawAlias) ? `\n(имя '${rawAlias}' переименовано в '${raw}' — профили теперь называются как лестницы llm-ladder)` : '';
    return `✅ OpenCode профиль → ${label}${renamed}\n\nПрименён только для твоего профиля (другие юзеры VM не затронуты). Следующая задача в OpenCode подхватит новые модели.${engineNote}`;
  }

  // /oc_go → the service profile (Go first); /oc_openrouter → explanation only. See
  // OC_GO_TOGGLE_INTENT above.
  const ocGoToggleM = task.trim().match(OC_GO_TOGGLE_INTENT);
  if (ocGoToggleM) {
    if (ocGoToggleM[1].toLowerCase() === 'openrouter') return OPENROUTER_RETIRED_MSG;
    if (!workDir) return null;
    profiles.setOcProfile(workDir, 'service');
    const engineNote = switchChatEngineToOpencode(workDir, chatId);
    return `✅ OpenCode профиль → SERVICE (стандартная лестница) на Go (mimo-v2.6-flash → deepseek-v4.1-flash).${engineNote}`;
  }
  return undefined;
}

module.exports = {
  profileCommandsAnswer, renderChatSettings, lastClaudeModel,
  PERSONA_INTENT, PROJECT_INTENT, SETTINGS_INTENT, ENGINE_SWITCH_INTENT, OC_PROFILE_INTENT,
  OC_GO_TOGGLE_INTENT, AGENT_INFO_INTENT, MODEL_INFO_INTENT, GET_WEBPASS_INTENT,
};
