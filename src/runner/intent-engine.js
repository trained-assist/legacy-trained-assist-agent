'use strict';

// ── Intent-dispatch engine ────────────────────────────────────────────────────
// All ~55 INTENT regex constants, getQuickAnswer(), verifyQuickAnswerIntent(),
// and runQuickAnswer() extracted from runner.js.
// runner.js re-exports these so call sites are unchanged.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const sessions = require('../session-store');
const { generateSummary } = require('../session-summary');
const projects = require('../projects');
const { revokeService, generateConnectLink } = require('../user-tokens');
const { readCredentialFile } = require('../credential-store');
const { runHostAction } = require('../mcp-action');

// Outbound HH effects (send / mass reject) can take longer than a read.
const HH_CONFIRM_TIMEOUT_MS = 120_000;

// One user-typed HH quick command → host-only hh-skill action (epic #1470 P1.3).
// Resolves to the provider's text ('' = no quick answer); rejects on provider failure.
async function hhQuickAnswer({ intent, task, username, workDir, timeoutMs }) {
  const text = await runHostAction({ tool: 'hh_quick_answer', params: { intent, task }, username, workDir, timeoutMs });
  return text || '';
}
const { hhLib, hhAvailable } = require('../domains/hh/lib');
const { siblingModules } = require('../domains/sibling-lib');
const readVacancyState = (workDir) => (hhAvailable('hh-vacancy') ? hhLib('hh-vacancy').readVacancyState(workDir) : null);
// Vacancy-creation quick flow lives in hh-skill src/hh-vacancy-quick.js (#1470); this core
// keeps only the ORDER of checks. No hh-skill checkout → the hooks simply do not apply.
const vacancyQuick = () => (hhAvailable('hh-vacancy-quick') ? hhLib('hh-vacancy-quick') : null);
const { loadUserSiteIntents } = require('../user-sites');
const persona = require('../persona');
const profiles = require('../profiles');
const { getUsageTotals } = require('../usage-store');
// Candidate-for-client report library lives in hh-skill (#1470); without the checkout
// the report quick answers simply do not apply.
const candidateReport = hhLib('hh-candidate-report');

// HH domain intent patterns — regexes live in trained-assist-hh-skill src/hh-intents.js
// (issue #942 P2.1, #1470). Without the hh-skill checkout every HH intent is a
// never-matching regex, so quick answers keep working for everything else.
const NEVER_MATCH = /(?!)/;
const hhIntentRegexes = new Proxy(hhLib('hh-intents'), { get: (t, k) => (t[k] instanceof RegExp ? t[k] : NEVER_MATCH) });
const {
  HH_STATUS_INTENT, HH_MY_VACANCIES_INTENT, HH_FUNNEL_INTENT, HH_RESPONSES_INTENT,
  HH_ATS_EDITOR_INTENT, HH_REVIEW_PAGE_INTENT, HH_WHERE_PROMPT_INTENT, HH_SHOW_ATS_CONFIG_INTENT,
  HH_STYLE_INTENT, HH_EVALUATE_INTENT, HH_SEND_INTENT, HH_SEND_CONFIRM_INTENT, HH_SEND_CANCEL_INTENT,
  HH_REJECT_INTENT, HH_REJECT_CONFIRM_INTENT, HH_REJECT_CANCEL_INTENT, HH_SCAN_INTENT, HH_DISCONNECT_INTENT,
  HH_PORTRAIT_INTENT,
} = hhIntentRegexes;

// ── Quick answers — bypass Claude for known setup/secrets patterns ───────────
// Returns a string if the task matches, null otherwise.

const STALE_PR_ALARM_INTENT = /Проверь PR #\d+: CI статус, конфликты/;
const SETUP_INTENT          = /подключ|connect|настро|интегр|привяз|как.*добав|могу.*отправ|зайт|авториз|setup|подрубить/i;
const INN_CAPABILITY_INTENT  = /(?:скил|skill|умееш|можешь|есть.{0,30}возможн|есть.{0,30}функц|есть.{0,30}инструм|что.{0,20}умееш).{0,80}(?:инн|огрн|компани|директор|выручк|реквизит)/i;
// Only capability/question words, NOT action verbs (собери/собрать/найди → those are tasks, go to Claude)
const GC_CAPABILITY_INTENT   = /(?:умееш|можешь|есть.{0,30}(?:скил|инструм|возможн|функц)|что.{0,20}умееш).{0,80}(?:геткурс|getcourse|курс|урок|ученик|школ)/i;
const AUDIO_CAPABILITY_INTENT = /(?:умееш|можешь|поддержива|транскрибир|распознаёш|распознаеш|расшифр).{0,60}(?:аудио|голосов|голос\b|запись|речь|звук|mp3|wav|ogg|voice|audio)|(?:транскрибац|транскрипц|расшифровк|распознавани).{0,40}(?:аудио|голосов|речи|записей|звука|файлов?)|(?:аудио|голосов).{0,40}(?:транскрибац|транскрипц|расшифровк|распознавани)|(?:умееш|можешь).{0,40}(?:из\s+)?(?:аудио|голосовых?\s+сообщений?|голосов(?:ого)?|записей?)\s+(?:в\s+текст|получить\s+текст|сделать\s+текст)|(?:можн[оа]|умееш|можешь).{0,20}(?:прислать|отправить|скинуть)\s+(?:аудио|голосов)/i;
// "на какой email шарить", "почта SA", "дай адрес google" — always read from disk, never hallucinate
const GDRIVE_SA_EMAIL_INTENT  = /(?:почт|email|e-mail|адрес).{0,40}(?:сервис|service|sa\b)|(?:сервис|service|sa\b).{0,40}(?:почт|email|e-mail|аккаун)|дай.{0,30}(?:почт|email|адрес).{0,30}(?:гугл|google|drive|аккаун)|на\s+(?:какой|что|какую).{0,30}(?:шар|поделить|пошар)|куда.{0,20}(?:шар|поделить|пошар)/i;
// "пошарить таблицу тебе", "поделиться файлом", "как дать доступ к гугл" — needs SA email answer
// verb forms only (пошари/пошарить/шари), not past/adj (пошаренные/пошарено — those go to LIST)
// Past tense "пошарил/поделился" + "ты видишь/можешь" = "I already shared, can you see it?" — separate intent
const GDRIVE_CONFIRM_INTENT   = /(?:пошарил[аи]?|поделил(?:ся|ась)|шарил[аи]?|дал[аи]?\s+доступ).{0,60}(?:видишь|можешь|проверь|посмотри|видел|открылся|доступно|работает)|(?:видишь|можешь|открылся|доступно|работает).{0,60}(?:пошарил[аи]?|поделил(?:ся|ась)|шарил[аи]?|папк|файл|документ)/i;
const GDRIVE_SHARE_INTENT     = /(?:пошар[иьюшт]|поделить|шар[иьюшт]|дать?\s+доступ).{0,50}(?:гугл|google|таблиц|докс|docs|sheets|файл|документ)|(?:гугл|google|таблиц|докс|docs|sheets|файл|документ).{0,50}(?:пошар[иьюшт]|поделить|шар[иьюшт]|дать?\s+доступ)/i;
// "мои файлы гугл", "что мне пошарено", "список документов"
const GDRIVE_LIST_INTENT      = /(?:мои|покажи|список|какие).{0,20}(?:файл|документ|гугл|google|пошарен)|(?:что|какие).{0,30}(?:пошарено|пошарил|открыл)|gdrive.{0,20}(?:файл|документ|список)/i;
// "пошарил", "дал доступ", "открыл доступ", "готово" after gdrive setup — user confirming they shared
const GDRIVE_SHARED_CONFIRM_INTENT = /^(?:пошарил|поделился|расшарил|дал\s+доступ|открыл\s+доступ|готово|ок|сделал|расшарен|добавил)\.?$/i;
// "можешь читать гугл шит", "умеешь работать с гугл таблицами"
// "можешь превратить pdf в гугл док", "умеешь вытащить данные из pdf" — capability question, not a task.
const PDF_CAPABILITY_INTENT = /(?:умееш|можешь|сможешь|можно|способен|получится|реально|есть.{0,30}(?:скил|инструм|возможн|функц)).{0,60}(?:pdf|пдф)|(?:pdf|пдф).{0,60}(?:умееш|можешь|сможешь|получится|реально ли)/i;
const GDRIVE_CAPABILITY_INTENT =/(?:можешь|умеешь|можно|способен|поддержива).{0,40}(?:гугл|google|sheets|docs|csv|таблиц|документ|гшит|spreadsheet)/i;
const GDRIVE_NOTIF_OFF_INTENT  = /\/gdrive_notif_off|\/google_drive_sharing_notifications_switch_off|выключи.{0,30}(?:уведомлени.{0,30}(?:гугл|google|drive|шаринг)|шаринг.{0,30}уведомлени)|отключи.{0,30}(?:уведомлени.{0,30}(?:гугл|google|drive|шаринг)|шаринг.{0,30}уведомлени)|не.{0,10}уведомля.{0,30}(?:гугл|google|drive|шаринг|файл)|без.{0,20}уведомлени.{0,30}(?:гугл|google|drive|шаринг)/i;
const GDRIVE_NOTIF_ON_INTENT   = /\/gdrive_notif_on|\/google_drive_sharing_notifications_switch_on|включи.{0,30}(?:уведомлени.{0,30}(?:гугл|google|drive|шаринг)|шаринг.{0,30}уведомлени)|верн.{0,20}уведомлени.{0,30}(?:гугл|google|drive|шаринг)/i;
// Background-task notifications (owner 29.09): «every step, start and finish, and
// if something is interrupted». Opt-in flag written here, delivered by the durable
// executor — see src/bg-notify.js + gtd-controller.bgNotice.
const BG_NOTIFY_STATUS_INTENT = /(?:^|\s)\/?bg_notify_status(?:\s|$|@)|(?:^|\s)background\s+(?:tasks?|playbooks?|steps?)\s+notifications?\s+status(?:\s|$)|(?:статус|состояние|есть\s+ли).{0,30}уведомлен.{0,50}(?:фонов|плейбук|шаг)/i;
const BG_NOTIFY_ON_INTENT = /(?:^|\s)\/?bg_notify_on(?:\s|$|@)|(?:^|\s)background\s+(?:tasks?|playbooks?|steps?)\s+notifications?\s+on(?:\s|$)|(?:включи|включить|нужны|хочу|надо|надо бы)\s[^.!?]{0,70}уведомлен[^.!?]{0,70}(?:фонов|плейбук|шаг|фоно)/i;
const BG_NOTIFY_OFF_INTENT = /(?:^|\s)\/?bg_notify_off(?:\s|$|@)|(?:^|\s)background\s+(?:tasks?|playbooks?|steps?)\s+notifications?\s+off(?:\s|$)|(?:выключи|выключить|отключи|отключить|убери|прибери)\s[^.!?]{0,70}уведомлен[^.!?]{0,70}(?:фонов|плейбук|шаг|фоно)/i;
const SESSIONS_INTENT       = /^\/sessions$|мои.{0,10}диалог|мои.{0,10}сессии|список.{0,10}диалог|покажи.{0,10}истори|мои.{0,10}задач/i;
// /bug_or_feature — Bugs & Features intake entry point (BUGS-AND-FEATURES-SPEC §3.4):
// opens a fresh session in the reserved bugs-and-features project; the gateway
// accumulator collects the rest, ▶️ runs deep in it. No GitHub, no one-message capture.
// `/bugreport` (+ `/bug_report`) are legacy aliases and resolve to the SAME intake — the
// old "arm a pending flag, let Claude file a GitHub issue in the user session" path is gone.
const BUG_OR_FEATURE_INTENT = /^\/(?:bug_or_feature|bugreport|bug_report|bug|feature|баг|фича|report|репорт)(?=\s|$)/i;
// "Подробнее N" / "/session N" / "подробнее о 3" — expand one session from the last /sessions list
const SESSION_DETAIL_INTENT = /^\/(?:sessions?|диалог)\s*(\d{1,2})\b|^подробнее(?:\s+(?:о|про|по))?\s*(?:диалог[ае]?\s*|сесси[июя]\s*|№\s*)?(\d{1,2})\b|^(\d{1,2})\s*подробнее/i;
const ILLUSTRATE_CAPABILITY_INTENT = /(?:умееш|можешь|есть.{0,30}(?:скил|инструм|возможн|функц)|что.{0,20}умееш).{0,80}(?:иллюстр|нарисова|рисовать|картинк|изображен|illustrat|draw|image.gen)/i;
const ILLUSTRATE_ENABLE_INTENT = /включ.{0,20}(?:рисован|иллюстр|картинк|рисунок)|добав.{0,20}(?:рисован|иллюстр|генерац)|активируй.{0,20}(?:рисован|иллюстр|скил.{0,10}рисован)|\/enable_illustrate/i;
// Matches concrete draw commands with subject content — these go to Claude even when skill is enabled
const ILLUSTRATE_DRAW_COMMAND = /(?:нарисуй|нарисовать|создай.{0,20}(?:иллюстр|картинк|схем)|сделай.{0,20}(?:иллюстр|картинк|схем)|покажи.{0,20}(?:схем|как устроен|анатоми))\s+\S.{5,}/i;
// Developer intent — matches "разработай X", "создай приложение", "сделай сервис" etc.
// NOT vacancy creation ("создай вакансию") or illustrate ("создай иллюстрацию") — those have dedicated intents.
const DEV_INTENT = /разраб[оа][тк]|(?:создай|сделай|напиш[иь]).{0,40}(?:приложени|сервис(?!\s*аккаунт)|бот(?!\s*токен|\s*ключ)(?!\s*weeek|\s*hh|\s*tilda|\s*nalog)|сайт(?!\s*с\s+tilda)(?!\s+tilda)|систем|скрипт(?!\s+для\s+(?:выставки|expo))|библиотек|пакет|модул|апи-сервис)|implement\s+\S|build\s+(?:app|service|bot|api)|develop\s+(?:app|feature|bot)/i;
const STOP_TASK_INTENT          = /^\/stop$|^стоп[!.?]?$|^stop[!.?]?$|^остановись[!.?]?$|^отмена[!.?]?$/i;
const GTD_STOP_INTENT           = /^(?:\[Сообщение \d+\]\s*)?\/(?:gtd_stop|stop_gtd|checklist_turn_off)(?:@\w+)?$|стоп.{0,5}gtd\b|gtd.{0,5}стоп\b/i;
const ACTIVE_CHECKLIST_INTENT   = /^(?:\[Сообщение \d+\]\s*)?\/(?:show_active_cheklist|active_checklist)(?:@\w+)?$/i;
// BV-08a (#1729): все осиротевшие чек-листы профиля. Алиас с опечаткой владельца сохраняем.
const FORGOTTEN_CHECKLISTS_INTENT = /^(?:\[Сообщение \d+\]\s*)?\/(?:all_forgotten_checklists|all_forgotten_checlists)(?:@\w+)?$/i;
// Natural-language "хочу поправить чек-лист" — hand back checklist.trainedassist.store
// autologin link instead of asking for a password. Edit/view verbs + "чек-лист" in either
// order; deliberately excludes GTD_STOP_INTENT's "стоп"/"выключи" and bare /active_checklist.
const CHECKLIST_EDIT_INTENT     = /(?:поправ|исправ|отредактир|редактир|изменит|открыт|открой|посмотрет|погляд|зайт|обнов|дай\s+ссылк|пришли\s+ссылк|скинь\s+ссылк|ссылк.{0,10}на).{0,25}чек.?лист|чек.?лист.{0,25}(?:поправ|исправ|отредактир|редактир|изменит|открыт|открой|обнов|ссылк)/i;
const WAKEUP_INTENT             = /^\/wakeup$|^wakeup[!.?]?$|^разморозь[!.?]?$|^размораживай[!.?]?$|^очнись[!.?]?$|^просн[иись]+[!.?]?$|^завис[!.?]?$|^зависло[!.?]?$|разбуди.{0,10}бот|рестарт.{0,10}бот|перезапуст.{0,10}бот|бот.{0,10}завис|агент.{0,10}завис/i;
const SKIP_TASK_INTENT          = /^\/skip(?:@\w+)?$/i;
const USAGE_INTENT          = /^\/usage$|сколько.{0,20}потратил|токен.{0,20}статистик|использован.{0,20}токен|стоимость.{0,20}сессий|расход.{0,20}токен/i;
// /usage klod, /usage codex — CLI subscription rate-limit check (Claude Code / Codex CLI
// OAuth session on THIS VM: ~/.claude/.credentials.json, ~/.codex/auth.json). Distinct from
// USAGE_INTENT above (per-profile token-SPEND stats) — this reads the operator's own shared
// CLI login, so it's gated to OWNER_USERNAME: a tenant profile has no reason to see the
// operator's personal Claude/Codex subscription usage.
const CLI_USAGE_INTENT      = /^\/?usage\s+(klod|codex|клод|кодекс)\b/i;
const OWNER_USERNAME        = 'trained-assist-product-owner';
const CLI_USAGE_SCRIPTS     = { klod: '/home/vova/bin/usage-klod.sh', codex: '/home/vova/bin/usage-codex.sh' };
const CONTEXT_OFF_INTENT    = /^\/context_off$|выключи.{0,15}контекст|скрой.{0,15}контекст|отключи.{0,15}(?:статус|контекст|карточк)/i;
const CONTEXT_ON_INTENT     = /^\/context_on$|включи.{0,15}контекст|покажи.{0,15}контекст|включи.{0,15}(?:статус|карточк)/i;
const CALLTIPS_PREPARE_INTENT = /(?:подготов|составь|сделай|создай).{0,30}(?:план|вопросы|интервью).{0,30}(?:для|с|звонк)|подготов.{0,20}(?:к|для).{0,10}звонк|план.{0,20}(?:интервью|звонка|встречи).{0,30}(?:с|для)|call.?tips.{0,20}(?:для|с|план|prepare)/i;
// Candidate-for-client report (issue #982): persistent recruiter requirements log per candidate.
// «добавь в требования [к профилю Чайка]: не упоминать удалёнку» / /report_add [имя]: текст
// → group 1 = command head, 2 = optional «к профилю <имя>» middle, 3 = the requirement text.
const REPORT_NOTE_ADD_INTENT  = /^(\/report_add(?:@\S+)?|добавь(?:те)?\s+в\s+требования)([^:\n]{0,80}?)\s*:\s*([\s\S]+)$/i;
// «покажи текущие требования к профилю [Чайка]» / /report_notes [имя]
const REPORT_NOTE_SHOW_INTENT = /^\/report_notes(?:@\S+)?(?:\s+(.+))?$|^(?:покажи|дай|открой|какие|что за)\s+(?:мне\s+)?(?:текущие\s+|мои\s+)?требования\s+(?:к|для)\s+(?:профил\S*|отч[её]т\S*)(?:\s+(.+))?$/i;
// «умеешь делать профиль кандидата для клиента?» — capability question only (NOT the task itself)
const REPORT_CAPABILITY_INTENT = /(?:умееш|можешь|можно|есть.{0,30}(?:возможн|функц|скил|инструм)|как.{0,25}(?:сделать|подготовить|получить|оформить)).{0,60}(?:профил\S*\s+кандидат|отч[её]т\S*\s+(?:по|о)\s+кандидат|кандидат\S*\s+для\s+клиент|резюме\s+для\s+клиент)/i;
const PING_INTENT           = /^\/ping$|^ты живой|^ты онлайн|^ты работаешь|^привет бот|^ping$/i;
const HELP_INTENT           = /^\/help$|^\/start$|что.{0,10}умееш|чем.{0,10}помож|какие.{0,10}возможн|список.{0,10}команд|помощь/i;
// Pure-info quick answers: no Claude, no session-transcript write, no external API call —
// just a sync read of local state (env/profile/token files). Safe to answer BEFORE the
// per-chat admission queue (see runner.js runTask()), so `/agent_info` etc. don't wait
// behind a long-running task in the same chat. Deliberately excludes PERSONA_INTENT/
// PROJECT_INTENT (they can mutate persona/project files) and SESSIONS_INTENT/
// SESSION_DETAIL_INTENT (they may call out to an LLM to generate a summary) — those stay
// on the queued path for now.
// ENGINE_SWITCH_INTENT (/switch2klod, /switch2codex, /switch2opencode) IS included: it's a
// sync profiles.json write with no Claude/network call, and its own handler already documents
// that a running task keeps its already-captured engine — the switch only affects the NEXT
// task in this chat, so applying it immediately is safe. Was missing from this whitelist
// (2026-09-24 bug report: /switch2codex sat behind "Ожидаю завершения предыдущей работы"
// instead of answering instantly like /ping does).
// OC_GO_TOGGLE_INTENT (/oc_go, /oc_openrouter) — same class, missed in that fix: a sync
// profile.json write or a canned reply, no Claude/session/network, so a quick command must
// never queue behind a running task. (2026-09-26 bug report: "/oc_go вернул
// «Ожидаю завершения предыдущей работы»").
// OC_PROFILE_INTENT (/oc_max, /oc_service, …) — same class again: getQuickAnswer handles it as
// a sync profiles.json write (it also pins this chat's engine), so it rides the same whitelist.
// Fuzzy natural-language info intents (HELP/USAGE/SECRETS_*/CONTEXT_*/MODEL_INFO) are
// unanchored: they exist for a SHORT standalone question («что ты умеешь», «сколько я
// потратил»). Inside a real task the same words are just prose («…посчитай расход токенов…»,
// «какие есть возможности…») and used to swallow the whole task with a canned ⚡ reply —
// silently, before the queue (#1479, 2026-09-26). Slash commands keep matching as before;
// prose must be a single short message to count as an info question.
const { fuzzyInfoIntent } = require('./quick/fuzzy');
const {
  profileCommandsAnswer,
  PERSONA_INTENT, PROJECT_INTENT, SETTINGS_INTENT, ENGINE_SWITCH_INTENT, OC_PROFILE_INTENT,
  OC_GO_TOGGLE_INTENT, AGENT_INFO_INTENT, MODEL_INFO_INTENT,
} = require('./quick/profile-commands');
const { secretsQuickAnswer, SECRETS_LIST_INTENT, SECRETS_LOG_INTENT } = require('./quick/secrets');
// A standalone slash command (one message, one line: «/bg_notify_on», «[Сообщение 1]\n/usage»)
// is ALWAYS tried before the queue — the class fix for the whitelist whack-a-mole above
// (/switch2codex 09-24, /oc_go 09-26, /bg_notify_on 09-29 each «Ожидаю завершения предыдущей
// работы»). Owner requirement 2026-09-29: Telegram commands and quick answers are never
// blocked by a running agent. getQuickAnswer is sync local state only (no Claude, no network),
// so every command it answers is safe here; a command it doesn't know returns null and falls
// through to the normal queued path (runner/index.js).
function isStandaloneSlashCommand(task) {
  const raw = String(task || '').trim();
  if ((raw.match(/\[Сообщение \d+\]/g) || []).length > 1) return false;
  const text = raw.replace(/^\[Сообщение \d+\]\s*/, '').replace(/^@\w+\s*/, '').trim();
  return /^\/[A-Za-z0-9_а-яё]/i.test(text) && !/\n/.test(text) && text.length <= 200;
}
function isPreQueueQuickIntent(task) {
  return isStandaloneSlashCommand(task) || PING_INTENT.test(task) || fuzzyInfoIntent(HELP_INTENT, task) || AGENT_INFO_INTENT.test(task) ||
    fuzzyInfoIntent(MODEL_INFO_INTENT, task) || fuzzyInfoIntent(SECRETS_LIST_INTENT, task) || fuzzyInfoIntent(SECRETS_LOG_INTENT, task) ||
    fuzzyInfoIntent(USAGE_INTENT, task) || fuzzyInfoIntent(CONTEXT_OFF_INTENT, task) || fuzzyInfoIntent(CONTEXT_ON_INTENT, task) ||
    ENGINE_SWITCH_INTENT.test(task) || OC_GO_TOGGLE_INTENT.test(task) ||
    OC_PROFILE_INTENT.test(task) || PROJECT_INTENT.test(task) || SETTINGS_INTENT.test(task);
}
// A slash command is an unambiguous, registry-backed user command — never fuzzy prose.
function isSlashCommand(task) {
  return /^\//.test(String(task || '').trim());
}
// forceClaude suppresses quick answers so free-form prose can't misfire on one of the
// ~40 fuzzy INTENT regexes and get silently eaten. A slash command can't misfire, so the
// flag must NOT apply to it. This matters beyond the normal path: server.js
// resumePendingTasks() re-runs a task interrupted by a restart with forceClaude=true, so an
// interrupted `/switch2klod` used to be replayed as a raw engine prompt and the LLM answered
// «не распознал команду» instead of switching the engine (2026-09-22). Commands always get
// their quick answer; only ambiguous prose obeys forceClaude.
function shouldAttemptQuickAnswer(forceClaude, task) {
  return !forceClaude || isSlashCommand(task);
}
// Checks whether a service is connected ("github подключен?", "статус nalog") — NOT imperative "подключи"

const TRUST_FOOTER = '\n\n🔒 Данные для входа не видны в переписке с ботом — они поступают прямо на сервер и хранятся в изолированном хранилище, отдельно от ИИ. Все обращения фиксируются в /secrets_log. Отзыв доступов: /secrets_list';

// service: label in /connect/:service route and agent-tokens filename
const QUICK_SETUPS = [
  {
    match: /github|гитхаб/i,
    service: 'github',
    hint: 'Где взять: github.com/settings/tokens → Generate new token (classic) → scopes: repo, read:org',
  },
  {
    match: /weeek|вик(?!тор)/i,
    service: 'weeek',
    hint: 'Где взять: Weeek → Settings → Integrations → API → Generate token',
  },
  // Google Drive: pass to Claude so it calls gdrive_setup automatically — no manual step for user
  // { match: /google.?drive|гугл.?диск|gdrive/i, service: null, hint: '...' },
  {
    match: /tilda|тильда/i,
    service: 'tilda-creds',
    hint: 'Email и пароль не попадут в чат — введёшь через защищённую форму, я войду автоматически.',
  },
  {
    match: /nalog|налог|нпд|самозан/i,
    service: 'nalog-creds',
    hint: 'Введёшь логин и пароль Госуслуг через защищённую форму — данные не попадут в чат.',
  },
  {
    match: /getcourse|геткурс|get.?course/i,
    service: 'getcourse',
    hint: 'Введи домен + API ключ (L1: ученики/заказы) и/или логин+пароль (L2: курсы/уроки).',
  },
  {
    match: /head.?hunter|\bhh\b|хантер/i,
    service: 'hh',
    hint: 'Войдёшь через hh.ru как работодатель — страница защищена, токен не проходит через чат.',
  },
  {
    match: /подключи.{0,20}сайт|добавь.{0,20}сайт|connect.{0,15}site|подключить.{0,20}сайт/i,
    service: 'site',
    hint: 'Введи адрес сайта, логин и пароль — я автоматически зайду и изучу его.',
  },
];

// Render the /sessions list. Prefers the durable summary.title over the raw topic;
// no LLM here — reads whatever summaries are already on disk (async enrichment
// happens in runQuickAnswer before this).
function renderSessionsList(list) {
  const lines = list.map((s, i) => {
    const d = new Date(s.lastAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    const title = (s.summary && s.summary.title) ? s.summary.title : s.topic.slice(0, 60);
    return `${i + 1}. ${title} (${d}, ${s.messageCount} сообщ.)`;
  });
  return '💬 Последние диалоги:\n' + lines.join('\n') + '\n\nПодробнее о любом — напишите «Подробнее N» (номер из списка).';
}

// Render the expanded card for one session from its durable summary.
function renderSessionDetail(meta, n) {
  const d = new Date(meta.lastAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const sum = meta.summary || {};
  const out = [`📄 Диалог ${n}: ${sum.title || meta.topic}`, `🕒 ${d} · ${meta.messageCount} сообщ.`, ''];
  if (sum.gist) out.push(sum.gist);
  if (sum.ended) out.push('', `🏁 Чем закончилось: ${sum.ended}`);
  if (sum.key_points && sum.key_points.length) {
    out.push('', 'Ключевые моменты:');
    for (const kp of sum.key_points) out.push(`• ${kp}`);
  }
  if (!sum.gist && !sum.ended && (!sum.key_points || !sum.key_points.length)) {
    out.push('(резюме недоступно — покажу тему)', '', meta.topic);
  }
  return out.join('\n');
}


// Guard rule for return null inside a matched intent block:
//   FALL-THROUGH (not return null): intent matched but data missing → next pattern may give useful answer
//   RETURN NULL (→ Claude): situation ambiguous, or Claude must call a tool (e.g. gdrive_setup) autonomously
// See README.md § "Guard conditions — fall-through vs return null" for the full audit table.
function getQuickAnswerUnchecked(task, userId, workDir, sessionExists = false, chatId = null, telegramUserId = null, audience = 'default', threadId = null) {
  // Stale PR alarm — fires repeatedly from csm-relay after PR is already merged
  if (STALE_PR_ALARM_INTENT.test(task)) {
    const prNum = task.match(/#(\d+)/)?.[1];
    return `✅ PR #${prNum} уже смёрджен. Этот alarm устарел — можно его удалить.`;
  }

  // Profile/chat commands: /persona, /get_webpass, /project, /settings, engine switch,
  // /get_agent_info, /oc_* (src/runner/quick/profile-commands.js).
  const profileAnswer = profileCommandsAnswer(task, { userId, workDir, chatId, audience, threadId });
  if (profileAnswer !== undefined) return profileAnswer;

  // Developer intent — if GitHub not connected, ask to connect before doing anything
  if (DEV_INTENT.test(task) && userId) {
    const ghPath = path.join(os.homedir(), 'agent-tokens', String(userId), 'github');
    if (!fs.existsSync(ghPath)) {
      return {
        __connectLink: true,
        service: 'github',
        hint: 'Для разработки нужен GitHub.\n\nЕсли аккаунта нет — создай бесплатно на github.com.\n\nТокен: github.com/settings/tokens → Generate new token (classic) → выбери scopes: repo, read:org\n\nПосле подключения расскажи задачу подробнее — уточним User Story и начнём.',
      };
    }
    // GitHub connected — let Claude handle dev tasks with dev_* tools
    return null;
  }

  // Vacancy creation flow — intercept before other intents so collecting mode takes priority
  const collecting = workDir && vacancyQuick()?.vacancyCollectingAnswer(task, {
    workDir, isPingOrHelp: PING_INTENT.test(task) || fuzzyInfoIntent(HELP_INTENT, task),
  });
  if (collecting) return collecting.answer;

  // ── Candidate-for-client report: requirements log (issue #982) ─────────────
  // Deterministic file ops on <workDir>/candidate-reports/<candidate>-report-notes.md — no Claude.
  // Generating / regenerating the profile itself is Claude's job (candidate_report_* MCP tools,
  // which read the same file); everything around the notes file is answered instantly here.
  // Collecting-mode vacancy flow above wins: there «добавь в требования» means the vacancy.
  const reportAdd = task.trim().match(REPORT_NOTE_ADD_INTENT);
  if (reportAdd && workDir && hhAvailable('hh-candidate-report')) {
    const isSlash = reportAdd[1].startsWith('/');
    const mid = reportAdd[2].trim();
    // "к профилю Чайка" → explicit report command, may create a new candidate.
    // Bare "к вакансии" / "Чайка" without "профил" → only accepted for an existing candidate.
    const explicit = isSlash || /профил/i.test(mid);
    const hint = mid.replace(/^(?:(?:к|для)\s+)?(?:профил\S*\s*)?/i, '').trim();
    const found = candidateReport.resolveCandidate(workDir, hint);
    if (found.ambiguous) {
      return `Под «${hint}» подходит несколько кандидатов: ${found.ambiguous.join(', ')}. Уточни: \`добавь в требования к профилю <имя>: …\``;
    }
    let slug = found.slug;
    if (!slug && explicit && hint) slug = candidateReport.slugify(hint);
    if (slug && reportAdd[3].trim().length <= 500) {
      const r = candidateReport.addNote(workDir, slug, reportAdd[3], { nameForNew: hint });
      const where = r.section === 'include' ? 'Что включать' : 'Что НЕ включать / формулировки';
      const who = candidateReport.readNotes(workDir, slug)?.name || slug;
      return r.duplicate
        ? `ℹ️ Такое требование к профилю «${who}» уже записано — ничего не менял.`
        : `✅ Записал в требования к профилю «${who}» (${where}). При каждой перегенерации применю автоматически — повторять не нужно.\n\nСмотреть все: «покажи требования к профилю ${who}» · пересобрать: «перегенерируй профиль ${who}»`;
    }
    // No candidate to attach to → fall through: Claude asks/decides (may not be about a report at all).
  }

  const reportShow = task.trim().match(REPORT_NOTE_SHOW_INTENT);
  if (reportShow && workDir && hhAvailable('hh-candidate-report')) {
    const hint = (reportShow[1] || reportShow[2] || '').trim();
    const found = candidateReport.resolveCandidate(workDir, hint);
    if (found.ambiguous) return `Под «${hint}» подходит несколько кандидатов: ${found.ambiguous.join(', ')}. Уточни имя.`;
    if (found.slug) {
      candidateReport.setLastCandidate(workDir, found.slug);
      return `📋 ${candidateReport.renderNotes(candidateReport.readNotes(workDir, found.slug))}\nДобавить: «добавь в требования: …» · пересобрать: «перегенерируй профиль ${found.slug.replace(/-/g, ' ')}»`;
    }
    const known = candidateReport.listCandidates(workDir);
    if (hint) return `Для «${hint}» требований к профилю пока нет. Добавить: «добавь в требования к профилю ${hint}: не упоминать …»`;
    return known.length
      ? `Требования к профилям есть у: ${known.join(', ')}. Уточни: «покажи требования к профилю <имя>».`
      : 'Пока нет ни одного профиля с требованиями. Начни с «сделай профиль кандидата <имя> для клиента <компания>» — файл требований создастся сам.';
  }

  // Capability question only ("умеешь делать профиль кандидата для клиента?"). A polite task with a
  // concrete target ("можешь сделать профиль кандидата Чайка для клиента АТОН") goes to Claude.
  if (REPORT_CAPABILITY_INTENT.test(task) &&
      !/клиента\s+\p{L}/iu.test(task) && !/(?:кандидата|профиль|профиля)\s+\p{Lu}/u.test(task)) {
    return [
      '📄 Да, делаю профиль кандидата для клиента — аккуратная HTML-страница (печать A4, 2–3 стр.):',
      'шапка с бейджами, кратко о себе, матрица соответствия вакансии ✓/~/✗, опыт, вывод рекрутера от первого лица, видео скрининга.',
      '',
      'Главное — я запоминаю твои правки в файле требований к профилю и применяю их при каждой перегенерации, повторять не нужно.',
      '',
      'Команды:',
      '• «сделай профиль кандидата [имя] для клиента [компания]»',
      '• «перегенерируй профиль [имя]» — читает требования автоматически',
      '• «добавь в требования: не упоминать …» — запомню навсегда',
      '• «покажи требования к профилю [имя]»',
    ].join('\n');
  }

  // New job post command — start collecting mode (guard against overwriting live drafts)
  const newJob = vacancyQuick()?.newJobAnswer(task, { workDir });
  if (newJob) return newJob.answer;

  // /ping — liveness check
  if (PING_INTENT.test(task)) return '🟢 Онлайн. Готов к работе.';

  // /help — capability overview (static, no Claude needed)
  if (fuzzyInfoIntent(HELP_INTENT, task)) {
    return [
      '🤖 Что я умею:',
      '',
      '📁 Работа с файлами, кодом, данными',
      '🔗 Интеграции: GitHub, Weeek, Налог.ру, Tilda, GetCourse, Google Drive',
      '🎨 Иллюстрации — генерирую картинки по описанию (DALL-E 3, FLUX, Ideogram, Recraft)',
      '🏢 INN Enrichment — поиск ИНН/ОГРН/директоров/выручки по списку компаний',
      '🎪 Выставки — собрать участников/экспонентов по URL сайта → CSV',
      '🌐 Браузер — вхожу на сайты и выполняю действия',
      '',
      '💼 HeadHunter (при подключённом HH аккаунте):',
      '  • «подготовь черновик вакансии [компания] на HH» — скидываешь текст/описание, создаю черновик на hh.ru',
      '  • «новая вакансия» — пошаговый сбор данных для вакансии',
      '  • «опубликуй черновик на HH» — отправить готовый черновик на hh.ru',
      '  • «опубликуй страницу вакансии» — лендинг с вакансией',
      '  • Просмотр откликов, воронка, список вакансий',
      '',
      '📄 Профиль кандидата для клиента:',
      '  • «сделай профиль кандидата [имя] для клиента [компания]» / «перегенерируй профиль [имя]»',
      '  • «добавь в требования: не упоминать …» — правки запоминаются и применяются каждый раз',
      '  • «покажи требования к профилю [имя]»',
      '',
      'Команды:',
      '/secrets_list — подключённые сервисы',
      '/secrets_log — история обращений к данным',
      '/sessions — мои диалоги',
      '/usage — расход токенов',
      '',
      'Чтобы подключить сервис: «подключи GitHub», «подключи Налог.ру» и т. д.',
    ].join('\n');
  }

  // /sessions — list recent sessions
  if (SESSIONS_INTENT.test(task)) {
    if (!workDir) return 'Не удалось определить рабочую директорию.';
    const list = sessions.listSessions(workDir, 10, audience);
    if (!list || list.length === 0) return 'Нет активных диалогов.';
    return renderSessionsList(list);
  }

  // /usage — token usage stats
  if (fuzzyInfoIntent(USAGE_INTENT, task)) {
    if (!workDir) return 'Не удалось определить рабочую директорию.';
    const t = getUsageTotals(workDir);
    if (!t || t.tasks === 0) return 'Данных об использовании пока нет.';
    // The model reads fresh input + cache read + cache write every step, so the
    // honest "what actually went in" total is the sum — report it first (#149).
    const totalIn = t.input_tokens + t.cache_read + t.cache_write;
    const lines = [
      `📊 Использование токенов (всего ${t.tasks} задач):`,
      `• Вход всего: ${totalIn.toLocaleString('ru-RU')} (новых ${t.input_tokens.toLocaleString('ru-RU')})`,
      `• Исходящих: ${t.output_tokens.toLocaleString('ru-RU')}`,
    ];
    if (t.cache_read > 0) lines.push(`• Из кэша: ${t.cache_read.toLocaleString('ru-RU')}`);
    if (t.cache_write > 0) lines.push(`• В кэш записано: ${t.cache_write.toLocaleString('ru-RU')}`);
    return lines.join('\n');
  }

  // /context_off / /context_on — toggle context card
  if (fuzzyInfoIntent(CONTEXT_OFF_INTENT, task) || fuzzyInfoIntent(CONTEXT_ON_INTENT, task)) {
    if (!workDir) return 'Не удалось определить рабочую директорию.';
    const flagPath = path.join(workDir, '.context_disabled');
    if (CONTEXT_OFF_INTENT.test(task)) {
      fs.writeFileSync(flagPath, '1');
      return '📌 Контекст-карточка выключена. Чтобы включить — /context_on';
    }
    try { fs.unlinkSync(flagPath); } catch (e) { console.warn('[runner] unlinkSync context flag:', e.message); }
    return '📌 Контекст-карточка включена. Буду показывать статус после каждой задачи.';
  }

  // Connected services: /secrets_list, /secrets_log, «github подключен?», revoke (src/runner/quick/secrets.js).
  const secretsAnswer = secretsQuickAnswer(task, { userId, workDir });
  if (secretsAnswer !== undefined) return secretsAnswer;

  // "мои файлы гугл", "что мне пошарено", "список документов" — LIST before SHARE (пошаренные matches both)
  // User confirms they shared after gdrive setup — pass to Claude to call gdrive_list_files
  if (GDRIVE_SHARED_CONFIRM_INTENT.test(task) && userId) {
    const gdriveFile4 = path.join(os.homedir(), 'agent-tokens', String(userId), 'gdrive');
    if (fs.existsSync(gdriveFile4)) {
      return null; // gdrive configured — let Claude call gdrive_list_files to verify access
    }
  }

  if (GDRIVE_LIST_INTENT.test(task) && userId) {
    const catalogPath2 = path.join(os.homedir(), 'agent-tokens', String(userId), 'gdrive-catalog.json');
    try {
      const catalog2 = JSON.parse(fs.readFileSync(catalogPath2, 'utf8'));
      if (!catalog2.length) return '📂 Пока нет пошаренных файлов. Поделись папкой/файлом Drive с SA email — потом напиши мне, я проверю доступ.';
      const MIME_ICON2 = {
        'application/vnd.google-apps.spreadsheet':  '📊',
        'application/vnd.google-apps.document':     '📄',
        'application/vnd.google-apps.presentation': '📊',
        'application/vnd.google-apps.folder':       '📁',
      };
      const lines2 = catalog2.slice(-20).reverse().map(f => {
        const icon = MIME_ICON2[f.mimeType] || '📎';
        const date = f.sharedAt ? new Date(f.sharedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '';
        const link = f.webViewLink ? `[${f.name}](${f.webViewLink})` : f.name;
        return `${icon} ${link}${date ? ' — ' + date : ''}`;
      });
      return ['📂 Пошаренные файлы:', '', ...lines2].join('\n');
    } catch (e) { console.warn('[runner] gdrive catalog parse:', e.message); }
    return null; // no catalog yet — let Claude call gdrive_list_files to check live
  }

  // Capability question about PDF — must precede GDRIVE_CAPABILITY_INTENT, which also
  // matches "pdf в google doc". Fall-through (not the answer) when the message carries an
  // attached file or continues a live session: then it's a real task about that file.
  if (PDF_CAPABILITY_INTENT.test(task) && task.length < 250 && !sessionExists && !task.includes('[Файл сохранён:')) {
    const driveConnected = !!userId && fs.existsSync(path.join(os.homedir(), 'agent-tokens', String(userId), 'gdrive'));
    return [
      'Да, с PDF работаю — быстро.\n',
      '📄 Достаю текст, таблицы, реквизиты и любые данные — в текст, Markdown, CSV или JSON',
      '🔄 Превращаю в нужный формат' + (driveConnected
        ? ', в том числе в Google Doc или Google Sheet — Google Drive уже подключён, результат положу прямо на диск'
        : ', в том числе в Google Doc или Google Sheet (для этого скажи «подключи гугл диск»)'),
      '',
      '⚡ Обычный PDF с текстом — за секунды. Скан или макет с текстом внутри картинок читаю дольше; если какие-то страницы разобрать плохо, скажу какие.\n',
      'Пришли файл и напиши, что из него нужно.',
    ].join('\n');
  }

  // "можешь читать гугл шит", "умеешь работать с csv/таблицами"
  if (GDRIVE_CAPABILITY_INTENT.test(task)) {
    if (!userId || sessionExists) return null;
    const gdriveFile3 = path.join(os.homedir(), 'agent-tokens', String(userId), 'gdrive');
    const connected = fs.existsSync(gdriveFile3);
    return connected
      ? [
          'Да, умею работать с Google Drive:',
          '',
          '📊 Читать Google Sheets — анализ, формулы, выборки',
          '📄 Читать Google Docs — конспект, резюме, поиск по тексту',
          '📤 Загружать CSV/данные в Google Sheets (создавать новые листы)',
          '📂 Следить за папкой — уведомление когда добавляют новый файл',
          '',
          'Google Drive уже подключён. Пошари папку/файл с SA email — потом напиши мне, я сам найду и прочитаю.',
        ].join('\n')
      : null; // not configured — let Claude call gdrive_setup automatically
  }

  // "я пошарил папку ты видишь?" — past tense + confirmation question → let Claude call gdrive_list_files
  if (GDRIVE_CONFIRM_INTENT.test(task)) return null;

  // "пошарить таблицу тебе", "как поделиться файлом", "email SA" — always read from disk, never hallucinate
  if ((GDRIVE_SHARE_INTENT.test(task) || GDRIVE_SA_EMAIL_INTENT.test(task)) && userId) {
    const gdriveFile2 = path.join(os.homedir(), 'agent-tokens', String(userId), 'gdrive');
    try {
      const sa2 = JSON.parse(readCredentialFile(gdriveFile2));
      if (sa2.client_email) {
        return [
          '📂 Чтобы дать мне доступ к файлу или папке в Google Drive:',
          '',
          '1. Открой файл/папку → кнопка «Поделиться» (Share)',
          `2. Добавь этот email с ролью «Читатель» (или «Редактор» если нужно):`,
          `\`${sa2.client_email}\``,
          '3. Нажми «Отправить»',
          '',
          'После шаринга напиши мне — я сам проверю доступ. Ссылку слать не нужно.',
        ].join('\n');
      }
    } catch (e) { console.warn('[runner] gdrive SA config parse:', e.message); }
    // SA email asked explicitly — give a helpful "not configured" message instead of routing to Claude
    if (GDRIVE_SA_EMAIL_INTENT.test(task)) {
      return 'Google Drive не настроен. Напиши «подключи Google Drive» — помогу настроить за пару минут.';
    }
    return null; // share intent without config — let Claude call gdrive_setup automatically
  }

  // Toggle GDrive sharing notifications
  if (GDRIVE_NOTIF_OFF_INTENT.test(task) && userId) {
    const mutedFile = path.join(os.homedir(), 'agent-tokens', String(userId), 'gdrive-notif-muted');
    fs.writeFileSync(mutedFile, JSON.stringify({ muted_at: new Date().toISOString() }), { mode: 0o600 });
    return '🔕 Уведомления о шаринге Google Drive отключены.\n\nФайлы продолжают добавляться в каталог — просто без уведомлений в чат. Включить обратно: `/gdrive_notif_on`';
  }
  if (GDRIVE_NOTIF_ON_INTENT.test(task) && userId) {
    const mutedFile = path.join(os.homedir(), 'agent-tokens', String(userId), 'gdrive-notif-muted');
    if (fs.existsSync(mutedFile)) fs.unlinkSync(mutedFile);
    return '🔔 Уведомления о шаринге Google Drive включены.\n\nБуду писать когда кто-то откроет доступ к файлу или папке.';
  }

  // Background-task notifications (owner 29.09): «шаг начат / шаг готов / прервано»,
  // so an owner can watch the playbooks run instead of wondering whether the
  // executor died. Opt-in flag; delivery lives in the durable executor.
  if (userId && (BG_NOTIFY_STATUS_INTENT.test(task) || BG_NOTIFY_OFF_INTENT.test(task) || BG_NOTIFY_ON_INTENT.test(task))) {
    const { readBgNotify, writeBgNotify } = require('../bg-notify');
    if (BG_NOTIFY_STATUS_INTENT.test(task)) {
      const flag = readBgNotify(userId);
      if (!flag?.enabled) return '🔕 Уведомления о фоновых шагах: выключены.\n\nВключить: `/bg_notify_on`';
      return `🔔 Уведомления о фоновых шагах: включены${flag.updated_at ? ` (с ${new Date(flag.updated_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })})` : ''}.\n\nПишу в чат про каждый шаг фоновых задач: ▶️ начат · ✅ готов · ⚠️ не удался · 🏁 задача завершена · 🔁 прервано рестартом. Выключить: \`/bg_notify_off\``;
    }
    if (BG_NOTIFY_OFF_INTENT.test(task)) {
      writeBgNotify(userId, { enabled: false });
      return '🔕 Уведомления о фоновых шагах отключены.\n\nВключить обратно: `/bg_notify_on`';
    }
    writeBgNotify(userId, { enabled: true, chatId: chatId ?? null, audience: audience || 'default', threadId: threadId ?? null });
    return '🔔 Уведомления о фоновых шагах включены.\n\nБуду писать в этот чат: ▶️ шаг начат · ✅ шаг готов · ⚠️ шаг не удался · 🏁 задача завершена · 🔁 прервано рестартом. Выключить: `/bg_notify_off`';
  }

  // Capability question about illustration generation
  if (ILLUSTRATE_ENABLE_INTENT.test(task) || ILLUSTRATE_CAPABILITY_INTENT.test(task)) {
    if (!workDir) return null;

    const illustrateFlagPath = path.join(workDir, 'contexts', 'illustrate', '.enabled');
    const illustrateEnabled = fs.existsSync(illustrateFlagPath);

    if (ILLUSTRATE_ENABLE_INTENT.test(task)) {
      if (!illustrateEnabled) {
        fs.mkdirSync(path.dirname(illustrateFlagPath), { recursive: true });
        fs.writeFileSync(illustrateFlagPath, JSON.stringify({ enabled_at: new Date().toISOString() }));
      }
      // If message also has a concrete draw command — enable the skill silently and let Claude handle the drawing
      if (ILLUSTRATE_DRAW_COMMAND.test(task)) return null;
      if (illustrateEnabled) return 'Скил иллюстраций уже включён. Опиши что нарисовать — и начнём!';
      return 'Готово! Скил генерации иллюстраций включён.\n\nТеперь могу рисовать медицинские схемы, анатомические диаграммы и инфографику.\nИспользую DALL-E 3 (основной) и Ideogram (альтернатива, лучше с подписями).\n\nОпиши что нарисовать — и начнём!';
    }

    // ILLUSTRATE_CAPABILITY_INTENT — pure capability question (no draw command); skip in active session
    if (sessionExists || ILLUSTRATE_DRAW_COMMAND.test(task)) return null;
    if (illustrateEnabled) {
      return 'Да, скил иллюстраций включён.\n\nПросто опиши что нарисовать — голосом или текстом. Например:\n• «нарисуй как работают потовые железы в коже»\n• «схема слоёв эпидермиса в разрезе»\n• «инфографика про уход за кожей»\n\nСтили: медицинская схема, flat design, детальная анатомия, инфографика.\nПосле картинки могу наложить подписи по-русски отдельным инструментом.';
    }
    return 'Есть скил генерации иллюстраций (DALL-E 3 + Ideogram), но он ещё не включён.\n\nНапиши «включи рисование» — и я активирую его для тебя.';
  }

  // Domain sibling quick answers (#1717): each sibling that ships src/quick-answers.js
  // (sales-skill: expo capability / criteria / site config / pipeline status) answers
  // first; null = not its message. A broken sibling only loses its own answers.
  for (const { id, mod } of siblingModules('src/quick-answers.js')) {
    try {
      const answer = mod.getQuickAnswer(task, { workDir, sessionExists });
      if (answer) return answer;
    } catch (e) {
      console.error(`[quick-answer] ${id} sibling error:`, e.message);
    }
  }

  // Capability question about INN enrichment — answer immediately without calling Claude
  if (INN_CAPABILITY_INTENT.test(task) && !sessionExists) {
    return 'Да, есть скил INN Enrichment.\n\nНаходит для списка компаний (300–1000 шт): ИНН, ОГРН, директора, выручку и прибыль.\n\nИсточники: БФО ФНС (бесплатно), ЕГРЮЛ, DaData, Checko — всё уже настроено, ключи у платформы.\n\nЧасть запросов платные (DaData, Checko), но не переживайте — мы предоставляем пакет ощутимого размера, чтобы получить результат. Если понадобится больше — докупим вместе.\n\nПришли JSON-файл, CSV или ссылку на Google Sheet со списком компаний — и запущу.';
  }

  // Capability question about GetCourse — only if connected for this profile
  if (GC_CAPABILITY_INTENT.test(task) && !sessionExists) {
    if (!userId || !fs.existsSync(path.join(os.homedir(), 'agent-tokens', String(userId), 'getcourse', 'config.json'))) return null;
    return [
      'Вот что умею в GetCourse:\n',
      '📋 Курсы (L2 — через сессию):',
      '• Список всех курсов — `gc_course_list`',
      '• Создать курс — `gc_course_create`',
      '• Создать раздел в курсе — `gc_section_create`',
      '• Создать урок — `gc_lesson_create`',
      '• Добавить видео-блок в урок — `gc_lesson_add_video`',
      '• Добавить текст-блок в урок — `gc_lesson_add_text`',
      '• Поменять порядок блоков — `gc_lesson_sort`\n',
      '👤 Ученики (L1 — API ключ):',
      '• Добавить/обновить ученика, дать доступ к курсу — `gc_user_add`\n',
      '👤 Ученики, заказы, уведомления, группы (L2 — через сессию, ~15–20с):',
      '• Найти ученика по email → user_id — `gc_user_find`',
      '• Список заказов ученика — `gc_order_list`',
      '• Письма/уведомления ученика — `gc_user_notifications`',
      '• Список групп доступа — `gc_group_list`',
      '• Какие курсы доступны группе — `gc_group_courses`',
      '• К каким тренингам есть доступ у юзера — `gc_user_trainings`\n',
      'Если нужного скила нет — могу использовать GetCourse API или Playwright напрямую.',
      'Если не подключён — скажи «подключи геткурс».',
    ].join('\n');
  }

  // Capability question about audio/voice transcription
  if (AUDIO_CAPABILITY_INTENT.test(task)) {
    return [
      'Да, умею транскрибировать аудио и голосовые сообщения.\n',
      '🎙️ Как это работает:',
      '• Пришли голосовое сообщение или аудиофайл (mp3, wav, ogg, m4a)',
      '• Получишь текст — быстро и с высокой точностью\n',
      '⚡ Движок: Deepgram nova-2',
      '• Поддерживает русский и другие языки',
      '• Быстрее и точнее Whisper',
      '• Расставляет знаки препинания и разбивает по абзацам\n',
      'Просто отправь аудио — и я пришлю транскрипцию.',
    ].join('\n');
  }

  // Check user-connected sites (custom intents generated during crawl)
  if (userId) {
    try {
      const siteIntents = loadUserSiteIntents(userId);
      for (const intent of siteIntents) {
        try {
          if (new RegExp(intent.pattern, 'i').test(task)) {
            console.log('[quick-answer] matched site intent=%j site=%s', intent.pattern, intent.slug);
            return intent.response;
          }
        } catch (e) {
          console.warn('[quick-answer] invalid site intent regex:', intent.pattern, e.message);
        }
      }
    } catch (e) {
      console.warn('[quick-answer] loadUserSiteIntents failed:', e.message);
    }
  }

  // Call Tips — "подготовь план для звонка с [имя]"
  // Don't return a quick answer — let Claude use calltips_prepare MCP tool.
  // But log to help with debugging if needed.
  if (CALLTIPS_PREPARE_INTENT.test(task)) {
    console.log('[quick-answer] CALLTIPS_PREPARE_INTENT matched — routing to Claude (calltips_prepare tool)');
    return null; // Claude handles via MCP tool
  }

  // Call Tips download links
  const CALLTIPS_DOWNLOAD_INTENT = /скачать.{0,20}call.?tips|установить.{0,20}call.?tips|call.?tips.{0,20}скачать|загрузить.{0,20}call.?tips|где.{0,20}call.?tips|ссылка.{0,20}call.?tips/i;
  if (CALLTIPS_DOWNLOAD_INTENT.test(task)) {
    return `📥 *Call Tips — скачать*

🍎 *Mac (Apple Silicon)*: https://github.com/trained-assist/call-tips/releases/latest/download/Call.Tips-0.1.0-arm64.dmg

🪟 *Windows (x64)*: https://github.com/trained-assist/call-tips/releases/latest/download/Call.Tips.Setup.0.1.0.exe

*Как начать:*
1. Установи приложение
2. Введи ключ Deepgram (транскрипция) и Agent Secret
3. Напиши мне: "подготовь план для звонка с [имя кандидата]"
4. Нажми 📥 Из агента → Начать звонок`;
  }

  if (!SETUP_INTENT.test(task)) {
    console.log('[quick-answer] no setup intent, task=%j', task.slice(0, 120));
    return null;
  }

  const NAVIGATING_URL_RE = /https?:\/\/[^\s]+\.[^\s]+\/[^\s]+/i;
  const SITE_CONNECT_RE = /подключи.{0,20}сайт|добавь.{0,20}сайт|connect.{0,15}site|подключить.{0,20}сайт/i;
  if (NAVIGATING_URL_RE.test(task) && !SITE_CONNECT_RE.test(task)) {
    console.log('[quick-answer] task contains a URL with path — user is navigating, not connecting; skipping QUICK_SETUPS');
    return null;
  }

  for (const { match, service, hint } of QUICK_SETUPS) {
    if (!match.test(task)) continue;
    console.log('[quick-answer] matched service=%s uid=%s', service || 'null', userId);
    if (service && userId) {
      // Guard: if already connected, don't re-send the connect link
      if (service === 'hh') {
        const hhPath = path.join(os.homedir(), 'agent-tokens', String(userId), 'hh');
        if (fs.existsSync(hhPath)) {
          return 'HeadHunter уже подключён ✅ Могу искать кандидатов, писать сообщения, создавать вакансии.\n\nЕсли хочешь переподключиться под другим аккаунтом — сначала /hh_disconnect.';
        }
      }
      return { __connectLink: true, service, hint };
    }
    return hint;
  }

  console.log('[quick-answer] setup intent matched but no service pattern, task=%j', task.slice(0, 120));
  return null;
}

// Classify whether user wants to publish/generate the vacancy landing page.
// Only called when regex misses AND a vacancy draft exists. Fast cheap-model call.
async function classifyVacancyPublishIntent(task, workDir, openrouterKey) {
  const orKey = openrouterKey || null;
  if (!require('../service-llm').available(orKey)) return false;
  const vs = readVacancyState(workDir);
  if (!vs?.draft) return false; // no draft — nothing to publish

  try {
    // Service-LLM ladder (src/service-llm.js: Go rungs → OpenRouter last).
    const out = await require('../service-llm').serviceText({
      system: 'You classify recruiter bot messages. Answer with a single word: YES or NO.',
      user: `Does this message ask to publish, generate, create, or rebuild the vacancy landing page (страница вакансии / лендинг)?\n\nMessage: "${task}"\n\nYES or NO:`,
      maxTokens: 5, timeoutMs: 4000, totalTimeoutMs: 6000, apiKey: orKey, source: 'vacancy-publish-intent',
    });
    const answer = String(out || '').trim().toUpperCase();
    return answer.startsWith('YES');
  } catch (e) {
    console.warn('[classifyVacancyPublishIntent] error:', e.message);
    return false;
  }
}

// getQuickAnswer's ~40 INTENT regexes are broad fuzzy-language patterns (e.g. "мои
// вакансии", "покажи ссылку", "включи X") — they misfire on unrelated messages that
// happen to share wording, silently eating a real task instead of reaching Claude.
// Before committing to a matched quick-answer, ask a cheap LLM whether the message
// actually requests it. Skipped for slash commands (unambiguous, no fuzzy match
// possible). Fails OPEN on missing key / timeout / error — a broken OpenRouter call
// must not make quick answers less reliable than before this gate existed.
async function verifyQuickAnswerIntent(task, answerPreview, openrouterKey) {
  const orKey = openrouterKey || null;
  if (!require('../service-llm').available(orKey) || !answerPreview) return true;
  try {
    // Service-LLM ladder (src/service-llm.js); fail-open on no answer.
    const out = await require('../service-llm').serviceText({
      system: 'You verify chatbot auto-replies before they are sent. Answer with a single word: YES or NO.',
      user: `A user sent this message to a chatbot:\n"${task}"\n\nThe bot is about to auto-reply with something like this:\n"${String(answerPreview).slice(0, 300)}"\n\nDoes the user's message actually request this kind of reply? If unsure, answer YES.\n\nYES or NO:`,
      maxTokens: 5, timeoutMs: 4000, totalTimeoutMs: 6000, apiKey: orKey, source: 'quick-answer-verify',
    });
    const answer = String(out || '').trim().toUpperCase();
    return !answer.startsWith('NO');
  } catch (e) {
    console.warn('[verifyQuickAnswerIntent] error (fail-open):', e.message);
    return true;
  }
}

// Async wrapper: sync quick-answer first, then HH API handlers (no Claude).
// sessionId: the id the caller (gateway, via /run) has already committed to for this
// chat turn — e.g. after a forceNew dispatch. BUG_OR_FEATURE_INTENT honors it (PR3) so
// the session it creates is the SAME one the gateway's lastSessionId now points at,
// instead of an orphan the next buffered message can never find its way back to.
async function runQuickAnswerUnchecked(task, userId, workDir, openrouterKey = null, sessionExists = false, chatId = null, telegramUserId = null, sessionId = null, audience = 'default', threadId = null) {
  const notificationIntents = hhIntentRegexes;
  if (userId && workDir && (notificationIntents.HH_NOTIFY_OFF_INTENT.test(task) || notificationIntents.HH_NOTIFY_ON_INTENT.test(task))) {
    return 'Уведомления холодного поиска выключены: функция удалена для всех пользователей. Настройки автопоиска не изменены.';
  }

  if (notificationIntents.HH_SEARCH_OFF_INTENT.test(task) && userId && workDir) {
    // Through the provider: stops the profile's cron jobs and legacy state (#1489 S7.1).
    try {
      const out = JSON.parse(await require('../mcp-action').runMcpTool({
        tool: 'hh_proactive_schedule', params: { action: 'disable' }, username: userId, workDir, timeoutMs: 20000 }) || '{}');
      if (out.error || !out.ok) return 'Не удалось остановить автопоиск. Попробуй ещё раз.';
      return 'Автопоиск выключен для всех вакансий профиля. Ручной поиск доступен.';
    } catch { return 'Не удалось остановить автопоиск. Попробуй ещё раз.'; }
  }
  // Never mistake notification settings or a quoted complaint for new responses.
  if (notificationIntents.HH_NOTIFICATION_REQUEST.test(task)) return null;
  // Engineering complaints containing quoted recruiter commands are full tasks.
  if (hhIntentRegexes.HH_SERVICE_CHANGE_INTENT.test(task) && /hh|хх|отклик|кандидат/i.test(task)) return null;
  // Handle complete credential-disconnect requests before broad connect/status patterns.
  if (userId && HH_DISCONNECT_INTENT.test(task)) {
    const revoked = revokeService(userId, 'hh');
    if (revoked === 'hh') return '✅ HeadHunter отключён — токен удалён. Чтобы подключить снова: /hh_connect';
    if (revoked === 'not_found') return '⚠️ HeadHunter не подключён. Скажи /hh_connect чтобы добавить.';
    return '⚠️ Не удалось отключить HeadHunter. Удаление токена не подтверждено.';
  }

  // Session summaries (durable artifact) — handled here (async) so we can generate
  // missing/stale summaries via LLM before rendering. "Подробнее N" expands one.
  if (workDir) {
    const detailM = task.trim().match(SESSION_DETAIL_INTENT);
    if (detailM) {
      const n = parseInt(detailM[1] || detailM[2] || detailM[3], 10);
      const list = sessions.listSessions(workDir, 10, audience);
      if (!list || list.length === 0) return 'Нет активных диалогов.';
      if (!n || n < 1 || n > list.length) return `Нет диалога №${n}. Напишите /sessions — покажу список.`;
      const meta = list[n - 1];
      if (sessions.needsSummary(meta)) {
        const full = sessions.getSession(workDir, meta.id);
        const sum = full && await generateSummary(full.messages, { apiKey: openrouterKey, ctx: { session: meta.id, user: userId } });
        if (sum) { sessions.setSummary(workDir, meta.id, sum, meta.messageCount); meta.summary = sum; }
      }
      return renderSessionDetail(meta, n);
    }
    if (SESSIONS_INTENT.test(task)) {
      let list = sessions.listSessions(workDir, 10, audience);
      if (!list || list.length === 0) return 'Нет активных диалогов.';
      // Generate summaries for sessions that lack a fresh one — in parallel, persist to disk.
      const stale = list.filter(s => sessions.needsSummary(s));
      if (stale.length && (openrouterKey || process.env.OPENROUTER_API_KEY)) {
        await Promise.all(stale.map(async (s) => {
          const full = sessions.getSession(workDir, s.id);
          if (!full) return;
          const sum = await generateSummary(full.messages, { apiKey: openrouterKey, ctx: { session: s.id, user: userId } });
          if (sum) sessions.setSummary(workDir, s.id, sum, s.messageCount);
        }));
        list = sessions.listSessions(workDir, 10, audience); // reload with fresh summaries
      }
      // Also refresh the ACTIVE project's name + 3-sense summary if it's stale (session
      // count grew). Cheap: one gemini-2.5-flash call, only when needed. This is how a
      // project "matures" — born with a provisional name, renamed from its real work.
      try {
        const orK = openrouterKey || process.env.OPENROUTER_API_KEY;
        const activePid = projects.getActiveProjectId(workDir, chatId, audience);
        if (orK && activePid) {
          const meta = projects.getProject(workDir, activePid);
          const projSess = sessions.listSessions(workDir, 1000, audience).filter(s => s.projectId === activePid);
          if (meta && projects.needsSummary(meta, projSess.length)) {
            const { generateProjectSummary } = require('../project-summary');
            const res = await generateProjectSummary(projSess, { apiKey: orK, ctx: { user: userId } });
            if (res) projects.setProjectSummary(workDir, activePid, res, projSess.length);
          }
        }
      } catch (e) { console.warn('[runner] project summary refresh:', e.message); }
      return renderSessionsList(list);
    }
  }

  // /bug_or_feature — Bugs & Features intake (BUGS-AND-FEATURES-SPEC §3.4). NO GitHub, NO
  // one-message capture: ensure the reserved `bugs-and-features` project, make it active,
  // and open a FRESH session bound to it. The user then piles on as many messages / voice /
  // screenshots as they want — the gateway accumulator holds them and ▶️ launches one deep
  // run in THIS session (gateway side: PR3 forces a fresh sessionId for the command so this
  // session's id matches what the gateway's lastSessionId now points at — otherwise the
  // buffered follow-ups launch into whatever unrelated session the chat had before).
  // Structuring into reports/<item>/ + index.jsonl is driven declaratively by the
  // project's PROFILE.md, not by branches in this code.
  if (BUG_OR_FEATURE_INTENT.test(task)) {
    if (!workDir) return null;
    try {
      const proj = projects.bugsProject(workDir, { audience });
      projects.setActiveProjectId(workDir, proj.id, chatId, { audience, threadId });
      const firstMessage = task.trim() || '/bug_or_feature';
      // Only adopt the caller's sessionId when it's actually fresh (sessionExists=false) —
      // never overwrite a real, already-existing session file.
      const reuseId = (!sessionExists && sessionId) ? sessionId : undefined;
      const sid = sessions.createSession(workDir, { task: firstMessage, chatId, projectId: proj.id, id: reuseId, audience, threadId });
      const greeting = [
        '🐞✨ Проект «Bugs and Features».',
        'Кидай что случилось или что хочешь — можно несколько сообщений, голосом, скриншотами.',
        'Как закончишь — жми ▶️ Запустить проработку.',
        'Всё интересное сложу в папку отчёта, оттуда заберёт сборщик.',
      ].join('\n');
      sessions.appendReply(workDir, sid, greeting);
      return greeting;
    } catch (e) {
      console.error('[bug_or_feature] intake error:', e.message);
      return `⚠️ Не удалось завести сессию Bugs and Features: ${e.message}`;
    }
  }

  // /usage klod, /usage codex — see CLI_USAGE_INTENT above.
  const cliUsageM = task.trim().match(CLI_USAGE_INTENT);
  if (cliUsageM) {
    if (userId !== OWNER_USERNAME) {
      return 'Команда доступна только владельцу.';
    }
    const key = /^(codex|кодекс)$/i.test(cliUsageM[1]) ? 'codex' : 'klod';
    const script = CLI_USAGE_SCRIPTS[key];
    try {
      const { stdout } = await new Promise((resolve, reject) => {
        execFile(script, [], { timeout: 15000 }, (err, stdout, stderr) => {
          if (err) reject(new Error(stderr?.trim() || err.message));
          else resolve({ stdout });
        });
      });
      return stdout.trim();
    } catch (e) {
      console.error('[cli-usage] %s script failed: %s', key, e.message);
      return `⚠️ Не удалось получить данные (${key}): ${e.message}`;
    }
  }

  // Skip regex-based intent matching for long free-form messages — the ~40
  // INTENT patterns were calibrated for short, focused phrasing and misfire on
  // multi-line tasks where a quick answer is almost never what the user wants.
  // Slash commands (unambiguous) are always checked regardless of length.
  const LONG_MSG_QUICK_SKIP = 200;
  const isSlashCommand = /^\//.test(task.trim());
  const sync = (isSlashCommand || task.trim().length <= LONG_MSG_QUICK_SKIP)
    ? getQuickAnswer(task, userId, workDir, sessionExists, chatId, telegramUserId, audience, threadId)
    : null;
  if (sync !== null) {
    const preview = (sync && typeof sync === 'object') ? sync.hint : sync;
    const confirmed = isSlashCommand || await verifyQuickAnswerIntent(task, preview, openrouterKey);
    if (confirmed) {
      if (sync && typeof sync === 'object' && sync.__connectLink) {
        try {
          const link = await generateConnectLink(userId, sync.service);
          return `Данные для входа — по ссылке:\n${link}\n\n${sync.hint}${TRUST_FOOTER}`;
        } catch (e) {
          console.error('[quick-answer] generateConnectLink failed:', e.message);
          return sync.hint;
        }
      }
      return sync;
    }
    console.log('[quick-answer] intent-check rejected match len=%d, falling through to Claude, task=%j', preview?.length || 0, task.slice(0, 120));
  }

  // Vacancy generation / landing page / HH draft — hh-skill hh-vacancy-quick (#1470).
  const hhTokenPath = userId ? path.join(os.homedir(), 'agent-tokens', String(userId), 'hh') : null;
  const hhConnected = hhTokenPath && fs.existsSync(hhTokenPath);
  const vacancyReply = await vacancyQuick()?.vacancyAsyncAnswer(task, {
    userId, workDir, openrouterKey, hhConnected,
    classifyPublish: (t) => classifyVacancyPublishIntent(t, workDir, openrouterKey),
  });
  if (vacancyReply) return vacancyReply;

  if (userId && workDir && hhConnected) {
    // Product changes and quoted broken bot replies must reach the full agent.
    if (hhIntentRegexes.HH_SERVICE_CHANGE_INTENT.test(task)) return null;
    const hhIntents = [HH_STATUS_INTENT, HH_MY_VACANCIES_INTENT, HH_FUNNEL_INTENT,
      HH_RESPONSES_INTENT, HH_ATS_EDITOR_INTENT, HH_REVIEW_PAGE_INTENT,
      HH_WHERE_PROMPT_INTENT, HH_SHOW_ATS_CONFIG_INTENT, HH_STYLE_INTENT,
      HH_EVALUATE_INTENT, HH_SEND_INTENT, HH_SEND_CONFIRM_INTENT, HH_SEND_CANCEL_INTENT,
      HH_REJECT_INTENT, HH_REJECT_CONFIRM_INTENT, HH_REJECT_CANCEL_INTENT, HH_SCAN_INTENT,
      HH_PORTRAIT_INTENT];
    if (hhIntents.some(intent => intent.test(task)) && !task.trim().startsWith('/') &&
        !await verifyQuickAnswerIntent(task, 'Быстрый ответ HeadHunter: вакансии, статистика, ссылки на ревью кандидатов или настройки рекрутинга', openrouterKey)) return null;
    // HH logic lives in trained-assist-hh-skill (epic #1470 P1.3): each intent is
    // one host-only provider action. '' / provider failure = no quick answer →
    // fall through to the full session (hh_* MCP tools), never a crash.
    const quick = (intent, opts = {}) => hhQuickAnswer({ intent, task, username: userId, workDir, ...opts });
    const orNull = (p) => p.then(r => r || null, () => null);
    let r;
    if (HH_STATUS_INTENT.test(task) && (r = await orNull(quick('status')))) return r;
    if (HH_MY_VACANCIES_INTENT.test(task) && (r = await orNull(quick('my_vacancies')))) return r;
    if (HH_FUNNEL_INTENT.test(task) && (r = await orNull(quick('funnel')))) return r;
    if (HH_RESPONSES_INTENT.test(task) && (r = await orNull(quick('new_responses')))) return r;
    if (HH_ATS_EDITOR_INTENT.test(task) && (r = await orNull(quick('ats_editor')))) return r;
    // Candidate review page — only with an active vacancy (provider returns '' otherwise).
    if (HH_REVIEW_PAGE_INTENT.test(task) && (r = await orNull(quick('review_page')))) return r;
    if (HH_WHERE_PROMPT_INTENT.test(task) && (r = await orNull(quick('where_prompt')))) return r;
    if (HH_SHOW_ATS_CONFIG_INTENT.test(task) && (r = await orNull(quick('show_ats_config')))) return r;
    if (HH_STYLE_INTENT.test(task) && (r = await orNull(quick('style_page')))) return r;
    // Портрет вакансии (hh-skill #86): gauge-таблица — локальный quick, без HH API.
    if (HH_PORTRAIT_INTENT.test(task) && (r = await orNull(quick('portrait_gauge')))) return r;
    // Action intents — order matters: confirm/cancel BEFORE the bare intent.
    // Confirm = outbound HH effect: longer deadline, and a timeout must not invite
    // a blind retry (the send may have gone through).
    const confirmFail = (msg) => (e) => (e && e.code === 'timeout' ? '⚠️ HH не ответил вовремя — проверь на hh.ru, прежде чем повторять.' : msg);
    if (HH_SEND_CONFIRM_INTENT.test(task)) return quick('send_confirm', { timeoutMs: HH_CONFIRM_TIMEOUT_MS }).catch(confirmFail('⚠️ Не удалось отправить — попробуй ещё раз.'));
    if (HH_SEND_CANCEL_INTENT.test(task)) return quick('send_cancel').catch(() => '⚠️ Не удалось отменить — попробуй ещё раз.');
    if (HH_SEND_INTENT.test(task)) return quick('send_preview').catch(() => '⚠️ Не удалось подготовить сообщение.');
    if (HH_REJECT_CONFIRM_INTENT.test(task)) return quick('reject_confirm', { timeoutMs: HH_CONFIRM_TIMEOUT_MS }).catch(confirmFail('⚠️ Не удалось отклонить — попробуй ещё раз.'));
    if (HH_REJECT_CANCEL_INTENT.test(task)) return quick('reject_cancel').catch(() => '⚠️ Не удалось отменить — попробуй ещё раз.');
    if (HH_REJECT_INTENT.test(task)) return quick('reject_dry_run').catch(() => '⚠️ Не удалось подготовить dry-run.');
    // HH_EVALUATE_INTENT / HH_SCAN_INTENT: no quick answer — the full session runs
    // hh_batch_evaluate / hh_proactive_search with the slash command intact.
  }



  return null;
}

// Public entry points: an empty quick answer is never delivered (src/quick-reply.js).
const { nonEmptyQuickReply } = require('../quick-reply');
function getQuickAnswer(task, ...rest) {
  return nonEmptyQuickReply(getQuickAnswerUnchecked(task, ...rest), task);
}
async function runQuickAnswer(task, ...rest) {
  return nonEmptyQuickReply(await runQuickAnswerUnchecked(task, ...rest), task);
}

module.exports = {
  getQuickAnswer,
  verifyQuickAnswerIntent,
  runQuickAnswer,
  // Constants used by runner.js run() function
  STOP_TASK_INTENT,
  GTD_STOP_INTENT,
  ACTIVE_CHECKLIST_INTENT,
  FORGOTTEN_CHECKLISTS_INTENT,
  CHECKLIST_EDIT_INTENT,
  WAKEUP_INTENT,
  SKIP_TASK_INTENT,
  PING_INTENT,
  HELP_INTENT,
  SESSIONS_INTENT,
  SESSION_DETAIL_INTENT,
  USAGE_INTENT,
  SECRETS_LIST_INTENT,
  SECRETS_LOG_INTENT,
  CONTEXT_OFF_INTENT,
  CONTEXT_ON_INTENT,
  PERSONA_INTENT,
  SETTINGS_INTENT,
  PROJECT_INTENT,
  AGENT_INFO_INTENT,
  MODEL_INFO_INTENT,
  BUG_OR_FEATURE_INTENT,
  isPreQueueQuickIntent,
  isStandaloneSlashCommand,
  fuzzyInfoIntent,
  isSlashCommand,
  shouldAttemptQuickAnswer,
  // Constants for runner.js _intents export
  HH_MY_VACANCIES_INTENT,
  HH_FUNNEL_INTENT,
  HH_RESPONSES_INTENT,
  HH_ATS_EDITOR_INTENT,
  HH_REVIEW_PAGE_INTENT,
  ENGINE_SWITCH_INTENT,
};
