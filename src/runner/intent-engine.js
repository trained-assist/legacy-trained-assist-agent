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
const {
  listConnectedServices,
  revokeService,
  getSecretsLog,
  generateConnectLink,
  SERVICE_DISPLAY,
} = require('../user-tokens');
const { runHostAction } = require('../mcp-action');

// Outbound HH effects (send / mass reject) can take longer than a read.
const HH_CONFIRM_TIMEOUT_MS = 120_000;

// One user-typed HH quick command → host-only hh-skill action (epic #1470 P1.3).
// Resolves to the provider's text ('' = no quick answer); rejects on provider failure.
async function hhQuickAnswer({ intent, task, username, workDir, timeoutMs }) {
  const text = await runHostAction({ tool: 'hh_quick_answer', params: { intent, task }, username, workDir, timeoutMs });
  return text || '';
}
const { readVacancyState, initVacancyState, appendVacancyMessage, writeVacancyState, generateVacancyFromMessages, publishVacancyPage, publishToHH, getMissingFields } = require('../hh-vacancy');
const { loadUserSiteIntents } = require('../user-sites');
const { deleteServiceAccount: deleteGdriveSA } = require('../mcp-skills/tools/50-gdrive');
const persona = require('../persona');
const profiles = require('../profiles');
const { savePassword: saveWebPassword, generatePassword: genWebPassword, generateMagicToken } = require('../web-auth');
const { getUsageTotals } = require('../usage-store');
const { loadDomainIntents } = require('../domains/load-intents');
const candidateReport = require('../candidate-report');

// HH domain intent patterns — regexes live in src/domains/hh/intents.js (issue #942 P2.1).
const {
  HH_STATUS_INTENT, HH_MY_VACANCIES_INTENT, HH_FUNNEL_INTENT, HH_RESPONSES_INTENT,
  HH_ATS_EDITOR_INTENT, HH_REVIEW_PAGE_INTENT, HH_WHERE_PROMPT_INTENT, HH_SHOW_ATS_CONFIG_INTENT,
  HH_STYLE_INTENT, HH_EVALUATE_INTENT, HH_SEND_INTENT, HH_SEND_CONFIRM_INTENT, HH_SEND_CANCEL_INTENT,
  HH_REJECT_INTENT, HH_REJECT_CONFIRM_INTENT, HH_REJECT_CANCEL_INTENT, HH_SCAN_INTENT, HH_DISCONNECT_INTENT,
  VACANCY_HH_PUBLISH_INTENT, VACANCY_PREP_DRAFT_INTENT,
} = loadDomainIntents('hh');

// ── Quick answers — bypass Claude for known setup/secrets patterns ───────────
// Returns a string if the task matches, null otherwise.

const STALE_PR_ALARM_INTENT = /Проверь PR #\d+: CI статус, конфликты/;
const SETUP_INTENT          = /подключ|connect|настро|интегр|привяз|как.*добав|могу.*отправ|зайт|авториз|setup|подрубить/i;
const INN_CAPABILITY_INTENT  = /(?:скил|skill|умееш|можешь|есть.{0,30}возможн|есть.{0,30}функц|есть.{0,30}инструм|что.{0,20}умееш).{0,80}(?:инн|огрн|компани|директор|выручк|реквизит)/i;
// Only capability/question words, NOT action verbs (собери/собрать/найди → those are tasks, go to Claude)
const EXPO_CAPABILITY_INTENT = /(?:скил|skill|умееш|можешь|есть.{0,30}(?:скил|инструм|возможн)).{0,80}(?:участник|экспонент|выставк|expo)/i;
const GC_CAPABILITY_INTENT   = /(?:умееш|можешь|есть.{0,30}(?:скил|инструм|возможн|функц)|что.{0,20}умееш).{0,80}(?:геткурс|getcourse|курс|урок|ученик|школ)/i;
const AUDIO_CAPABILITY_INTENT = /(?:умееш|можешь|поддержива|транскрибир|распознаёш|распознаеш|расшифр).{0,60}(?:аудио|голосов|голос\b|запись|речь|звук|mp3|wav|ogg|voice|audio)|(?:транскрибац|транскрипц|расшифровк|распознавани).{0,40}(?:аудио|голосов|речи|записей|звука|файлов?)|(?:аудио|голосов).{0,40}(?:транскрибац|транскрипц|расшифровк|распознавани)|(?:умееш|можешь).{0,40}(?:из\s+)?(?:аудио|голосовых?\s+сообщений?|голосов(?:ого)?|записей?)\s+(?:в\s+текст|получить\s+текст|сделать\s+текст)|(?:можн[оа]|умееш|можешь).{0,20}(?:прислать|отправить|скинуть)\s+(?:аудио|голосов)/i;
const SECRETS_LIST_INTENT   = /^\/secrets_list$|список.{0,15}подключённых|какие.{0,15}подключ|покажи.{0,15}сервис|мои.{0,15}доступ/i;
const SECRETS_LOG_INTENT    = /^\/secrets_log$|история.{0,15}доступ|лог.{0,15}секрет|обращени.{0,15}секрет/i;
const REVOKE_INTENT         = /отзов|revoke|удал.{0,10}доступ|отключ.{0,10}сервис|убер.{0,10}доступ/i;
const REVOKE_SERVICE_RE     = /(github|гитхаб|weeek|вик|nalog|налог|нпд|самозан|figma|фигма|notion|linear|tilda|тильда|gdrive|гугл|google|dadata)/i;
const REVOKE_CONFIRM_RE     = /^да[,.]?\s*(удал|отключ|подтвер|confirm)|^confirm$|^yes$/i;
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
const NEW_JOB_INTENT            = /новая вакансия|new job post|\/new_job_post|создать вакансию|добавить вакансию|создай вакансию/i;
const STOP_TASK_INTENT          = /^\/stop$|^стоп[!.?]?$|^stop[!.?]?$|^остановись[!.?]?$|^отмена[!.?]?$/i;
const GTD_STOP_INTENT           = /^(?:\[Сообщение \d+\]\s*)?\/(?:gtd_stop|stop_gtd|checklist_turn_off)(?:@\w+)?$|стоп.{0,5}gtd\b|gtd.{0,5}стоп\b/i;
const ACTIVE_CHECKLIST_INTENT   = /^(?:\[Сообщение \d+\]\s*)?\/(?:show_active_cheklist|active_checklist)(?:@\w+)?$/i;
// Natural-language "хочу поправить чек-лист" — hand back checklist.trainedassist.store
// autologin link instead of asking for a password. Edit/view verbs + "чек-лист" in either
// order; deliberately excludes GTD_STOP_INTENT's "стоп"/"выключи" and bare /active_checklist.
const CHECKLIST_EDIT_INTENT     = /(?:поправ|исправ|отредактир|редактир|изменит|открыт|открой|посмотрет|погляд|зайт|обнов|дай\s+ссылк|пришли\s+ссылк|скинь\s+ссылк|ссылк.{0,10}на).{0,25}чек.?лист|чек.?лист.{0,25}(?:поправ|исправ|отредактир|редактир|изменит|открыт|открой|обнов|ссылк)/i;
const WAKEUP_INTENT             = /^\/wakeup$|^wakeup[!.?]?$|^разморозь[!.?]?$|^размораживай[!.?]?$|^очнись[!.?]?$|^просн[иись]+[!.?]?$|^завис[!.?]?$|^зависло[!.?]?$|разбуди.{0,10}бот|рестарт.{0,10}бот|перезапуст.{0,10}бот|бот.{0,10}завис|агент.{0,10}завис/i;
const SKIP_TASK_INTENT          = /^\/skip(?:@\w+)?$/i;
const VACANCY_DONE_INTENT       = /^всё$|^все$|^готово$|^хватит$|^достаточно$|^запускай$|^стоп, всё$|^всё, запускай$|^ок, всё$/i;
const VACANCY_CANCEL_INTENT     = /отмен.{0,20}вакансии|отмен.{0,20}созда|выйт.{0,15}режим|стоп.{0,10}вакансия|сброс.{0,15}вакансии|\/cancel_vacancy/i;
const VACANCY_PUBLISH_PAGE_INTENT = /публику[йе].{0,20}страниц|опубликуй.{0,20}(?:страниц|лендинг)|создай.{0,20}(?:страниц.{0,20}вакансии|лендинг)|сгенерир.{0,20}страниц|сделай.{0,20}страниц.{0,20}вакансии|страниц.{0,30}(?:вакансии.{0,30})?(?:сгенерир|создай|опубликуй|сделай)|страниц.{0,20}готов/i;
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
const OC_PROFILE_INTENT = /^\/oc_(max|value|free|russian-recruiter|russian|recruiter|rr|ru|quality|mimo|lavish-luna|ll|q|x|deepseek_openrouter|deepseek_go|ds_or|ds_go|deepseek|ds)(?:@\S+)?\b|^\/oc\s+(max|value|free|russian-recruiter|russian|recruiter|rr|ru|quality|mimo|lavish-luna|ll|q|x|deepseek_openrouter|deepseek_go|ds_or|ds_go|deepseek|ds)\b/i;
// /oc_go, /oc_openrouter — manual override for the shared "deepseek" profile's VM-wide
// go/openrouter toggle (issue #1096). Deliberately separate from OC_PROFILE_INTENT above: that
// sets THIS profile's own ocProfile choice (profiles.setOcProfile, per trained-assist profile),
// while the go/openrouter toggle is one piece of state for the whole VM — see
// src/opencode-go-toggle.js for why (the OpenCode Go subscription's rate limit is account-wide,
// shared by the whole team, not per trained-assist profile).
const OC_GO_TOGGLE_INTENT = /^\/oc_(go|openrouter)(?:@\S+)?\b/i;
const AGENT_INFO_INTENT = /^\/(?:get_agent_info|agent_info|info)(?:@\S+)?(?=\s|$)/i;
// Natural-language "what model/agent are you?" — «на какой модели ты сейчас работаешь?»,
// «какая у тебя модель», «какой моделью пользуешься», «какой ты агент». Maps to the same
// agent-info block as /agent_info (model/engine/version). Non-slash matches pass through the
// cheap-LLM verify gate (verifyQuickAnswerIntent) before being sent, so a slightly loose
// regex is safe: real tasks that merely mention "модель" get rejected by the gate and
// still reach Claude.
const MODEL_INFO_INTENT = /(?:на\s+какой\s+(?:модел|нейросет|llm)|какая\s+у\s+тебя\s+(?:модел|нейросет|llm)|какую\s+модел\S*\s+(?:ты\s+)?(?:используеш|юзаеш|ставиш)|какой\s+модел\S*\s+(?:ты\s+)?(?:работаеш|пользуеш|сидиш)|на\s+какой\s+нейросет|что\s+за\s+(?:модел|нейросет)|какой\s+ты\s+агент|какая\s+ты\s+нейросет)/i;
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
// OC_GO_TOGGLE_INTENT (/oc_go, /oc_openrouter) — same class, missed in that fix: it's a sync
// write of one VM-wide toggle file (src/opencode-go-toggle.js), no Claude/session/network, so a
// quick command must never queue behind a running task. (2026-09-26 bug report: "/oc_go вернул
// «Ожидаю завершения предыдущей работы»").
// OC_PROFILE_INTENT (/oc_max, /oc_deepseek, …) — same class again: getQuickAnswer handles it as
// a sync profiles.json write (it also pins this chat's engine), so it rides the same whitelist.
// Fuzzy natural-language info intents (HELP/USAGE/SECRETS_*/CONTEXT_*/MODEL_INFO) are
// unanchored: they exist for a SHORT standalone question («что ты умеешь», «сколько я
// потратил»). Inside a real task the same words are just prose («…посчитай расход токенов…»,
// «какие есть возможности…») and used to swallow the whole task with a canned ⚡ reply —
// silently, before the queue (#1479, 2026-09-26). Slash commands keep matching as before;
// prose must be a single short message to count as an info question.
const FUZZY_INFO_MAX_CHARS = 100;
function isShortStandaloneQuestion(task) {
  const raw = String(task || '').trim();
  if ((raw.match(/\[Сообщение \d+\]/g) || []).length > 1) return false;
  const text = raw.replace(/^\[Сообщение \d+\]\s*/, '').replace(/^@\w+\s*/, '').trim();
  return text.length <= FUZZY_INFO_MAX_CHARS;
}
function fuzzyInfoIntent(re, task) {
  if (!re.test(task)) return false;
  const text = String(task || '').trim().replace(/^\[Сообщение \d+\]\s*/, '').replace(/^@\w+\s*/, '');
  return /^\//.test(text) || isShortStandaloneQuestion(task);
}
function isPreQueueQuickIntent(task) {
  return PING_INTENT.test(task) || fuzzyInfoIntent(HELP_INTENT, task) || AGENT_INFO_INTENT.test(task) ||
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
// Explicit request patterns only — NOT "целевых компаний" buried in a long instruction
const EXPO_CRITERIA_INTENT  = /требовани.{0,20}(?:целев|квалиф)|критери.{0,20}(?:целев|отбор|выставк)|целев.{0,20}(?:критери|требовани)|покажи.{0,15}критери|мои.{0,10}критери|expo.{0,10}criteria|target.{0,10}criteria/i;
const EXPO_STATUS_INTENT    = /статус.{0,20}(?:пайплайн|pipeline|выставк|обработк)|pipeline.{0,10}статус|сколько.{0,15}целевых|сколько.{0,15}компаний.{0,20}(?:выставк|обработан|pipeline)|expo.{0,10}статус/i;
const EXPO_SITE_CONFIG_INTENT = /фильтр.{0,20}(?:сайт|каталог|выставк|диапазон)|сайт.{0,20}фильтр|диапазон.{0,20}(?:выручк|сайт)|настройк.{0,20}(?:сайт|каталог)|какие.{0,10}диапазон|revenue.*filter|site.*filter/i;
// Checks whether a service is connected ("github подключен?", "статус nalog") — NOT imperative "подключи"
const SERVICE_STATUS_INTENT = /(?:подключён|подключен|connected|активен|добавлен|работает|есть ли|подключён ли).{0,30}(?:github|weeek|вик|nalog|налог|нпд|figma|фигма|tilda|тильда|gdrive|getcourse|геткурс)|(?:github|weeek|вик|nalog|налог|нпд|figma|фигма|tilda|тильда|gdrive|getcourse|геткурс).{0,20}(?:подключён|подключен|connected|активен|добавлен|работает|статус|status)/i;
const SERVICE_STATUS_RE     = /(github|weeek|вик|nalog|налог|нпд|figma|фигма|tilda|тильда|gdrive|getcourse|геткурс)/i;

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

// The static ANTHROPIC_MODEL env can name a model Claude Code doesn't actually run (a
// retired/unauthorised id makes the CLI fall back to its own default). Prefer the model the
// last completed claude task really used, from the per-profile usage log (recordUsage stores
// claudeModel); fall back to the env only when there's no history yet.
function lastClaudeModel(workDir) {
  if (!workDir) return null;
  try {
    const log = require('../usage-store').getUsageLog(workDir);
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
    try { const sha = require('../release-info').getReleaseSha(); if (sha) commit = sha.slice(0, 8); } catch {}
    let ocModel = process.env.OPENCODE_MODEL || '(из профиля)';
    let ocProfile = workDir ? profiles.getOcProfile(workDir) : 'не задан';
    try {
      // "deepseek" (issue #1096) has no literal .opencode/profiles file — resolve through the
      // shared VM-wide go/openrouter toggle to find which one actually applies right now.
      const ocProfileResolved = ocProfile === 'deepseek' ? require('../opencode-go-toggle').resolveProfileName() : ocProfile;
      const ocProfilePath = path.join(__dirname, '..', '..', '.opencode', 'profiles', `${ocProfileResolved}.json`);
      if (fs.existsSync(ocProfilePath)) {
        const ocCfg = JSON.parse(fs.readFileSync(ocProfilePath, 'utf8'));
        if (ocCfg.model) ocModel = ocCfg.model;
      }
    } catch {}
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
    // retired in #1061 Фаза 1 (folded into max/value's ladders as rungs, not standalone
    // profiles anymore), so those names get a helpful redirect instead of a raw 404.
    const RETIRED = new Set(['quality', 'mimo', 'lavish-luna', 'll', 'q']);
    if (RETIRED.has(rawAlias)) {
      return `⚠️ Профиль '${rawAlias}' упразднён в #1061 (стал ступенью лестницы max/value) — выбери max|value|free|russian.`;
    }
    const ALIASES = {
      ru: 'russian', recruiter: 'russian', rr: 'russian', 'russian-recruiter': 'russian', x: 'max', ds: 'deepseek',
      // /oc_ds_or, /oc_deepseek_openrouter — pin THIS profile to the concrete OpenRouter file
      // (deepseek-openrouter.json), bypassing the shared VM-wide go/openrouter toggle below.
      // Distinct from /oc_deepseek (logical profile that follows the toggle) and from
      // /oc_openrouter (OC_GO_TOGGLE_INTENT, flips the toggle for everyone on "deepseek").
      ds_or: 'deepseek-openrouter', deepseek_openrouter: 'deepseek-openrouter',
      ds_go: 'deepseek-go', deepseek_go: 'deepseek-go',
    };
    const raw = ALIASES[rawAlias] || rawAlias;
    // "deepseek" (issue #1096) is a logical/virtual profile — it has no .opencode/profiles/
    // file of its own, it resolves to deepseek-go or deepseek-openrouter via the shared VM-wide
    // toggle (src/opencode-go-toggle.js), so it skips the file-existence check below.
    if (raw === 'deepseek') {
      profiles.setOcProfile(workDir, 'deepseek');
      const engineNote = switchChatEngineToOpencode(workDir, chatId);
      const opencodeGoToggle = require('../opencode-go-toggle');
      const modeLabel = opencodeGoToggle.getMode() === 'go' ? 'Go (opencode-go/deepseek-v4.1-flash)' : 'OpenRouter (openrouter/deepseek/deepseek-v4-flash-0731)';
      return `✅ OpenCode профиль → DEEPSEEK — общий, единая модель на всех ролях\n\nПрименён только для твоего профиля. Реальный шлюз (Go или OpenRouter) переключается общим VM-тумблером — сейчас: ${modeLabel}. Ручное переключение: /oc_go, /oc_openrouter. Авто-переключение на OpenRouter при упоре в лимит Go, авто-возврат через ~5ч.${engineNote}`;
    }
    const profileFile = path.join(__dirname, '..', '..', '.opencode', 'profiles', `${raw}.json`);
    if (!fs.existsSync(profileFile)) return `⚠️ Профиль '${raw}' не найден (.opencode/profiles/${raw}.json)`;
    profiles.setOcProfile(workDir, raw);
    const engineNote = switchChatEngineToOpencode(workDir, chatId);
    const PROFILE_LABELS = {
      max:      'MAX — лестница GPT-6/5.6 Luna → DeepSeek (дефолт)',
      value:    'VALUE — DeepSeek V4 Flash → GLM → Qwen',
      free:     'FREE — только бесплатный inference (MiMo/Nemotron)',
      russian:  'RUSSIAN — GigaChat Pro/Ultra/Max',
      'deepseek-openrouter': 'DEEPSEEK, закреплено на OpenRouter — openrouter/deepseek/deepseek-v4-flash-0731',
      'deepseek-go':         'DEEPSEEK, закреплено на Go — opencode-go/deepseek-v4.1-flash',
    };
    const label = PROFILE_LABELS[raw] || raw;
    // deepseek-openrouter/deepseek-go are a pin for THIS profile only — unlike /oc_deepseek,
    // this ignores the shared VM-wide go/openrouter toggle (src/opencode-go-toggle.js), so it
    // needs its own note to avoid the two being confused (issue that prompted this command).
    const pinNote = (raw === 'deepseek-openrouter' || raw === 'deepseek-go')
      ? ' Закреплено намертво за твоим профилем — в отличие от /oc_deepseek (следует общему VM-тумблеру /oc_go, /oc_openrouter), сюда переключиться и остаться можно только явно через /oc_ds_or или /oc_ds_go.'
      : '';
    return `✅ OpenCode профиль → ${label}\n\nПрименён только для твоего профиля (другие юзеры VM не затронуты). Следующая задача в OpenCode подхватит новые модели.${pinNote}${engineNote}`;
  }

  // /oc_go, /oc_openrouter — manual override for the shared "deepseek" profile's VM-wide
  // go/openrouter toggle. See OC_GO_TOGGLE_INTENT above for why this is separate from the
  // per-profile /oc_* switch just above.
  const ocGoToggleM = task.trim().match(OC_GO_TOGGLE_INTENT);
  if (ocGoToggleM) {
    const mode = ocGoToggleM[1].toLowerCase();
    const opencodeGoToggle = require('../opencode-go-toggle');
    opencodeGoToggle.setMode(mode, { auto: false });
    const label = mode === 'go' ? 'Go (opencode-go/deepseek-v4.1-flash)' : 'OpenRouter (openrouter/deepseek/deepseek-v4-flash-0731)';
    const stickyNote = mode === 'openrouter' ? ' Останется на OpenRouter, пока не переключишь обратно (/oc_go) — это ручное переключение, само не вернётся через 5ч (в отличие от авто-переключения при лимите).' : '';
    return `✅ Общий тумблер OpenCode Go/OpenRouter (VM-wide) → ${label}\n\nВлияет на всех, кто использует профиль «deepseek» (/oc_deepseek), а не только на твой.${stickyNote}`;
  }

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
  if (workDir) {
    const vs = readVacancyState(workDir);
    if (vs?.status === 'generating') {
      // Already running an Anthropic API call — block new messages to prevent concurrent generation
      return '⏳ Генерирую вакансию, подожди немного...';
    }
    if (vs?.status === 'collecting') {
      // Cancel — let user escape collecting mode
      if (VACANCY_CANCEL_INTENT.test(task)) {
        writeVacancyState(workDir, { ...vs, status: 'cancelled' });
        return '❌ Создание вакансии отменено. Чтобы начать заново — скажи «новая вакансия».';
      }
      if (VACANCY_DONE_INTENT.test(task.trim())) {
        // Mark as generating; runQuickAnswer async section will call Anthropic API
        writeVacancyState(workDir, { ...vs, status: 'generating' });
        return null; // fall through to async handler
      }
      // Skip other quick-answer patterns while collecting (except ping/help)
      if (!PING_INTENT.test(task) && !fuzzyInfoIntent(HELP_INTENT, task)) {
        const count = appendVacancyMessage(workDir, task);
        const countLabel = count === 1 ? 'блок' : count < 5 ? 'блока' : 'блоков';
        return `✅ Принял (${count} ${countLabel}). Ещё что-нибудь? Или скажи «всё» — начну генерировать.\nЧтобы отменить: «отмени создание вакансии».`;
      }
    }
  }

  // ── Candidate-for-client report: requirements log (issue #982) ─────────────
  // Deterministic file ops on <workDir>/candidate-reports/<candidate>-report-notes.md — no Claude.
  // Generating / regenerating the profile itself is Claude's job (candidate_report_* MCP tools,
  // which read the same file); everything around the notes file is answered instantly here.
  // Collecting-mode vacancy flow above wins: there «добавь в требования» means the vacancy.
  const reportAdd = task.trim().match(REPORT_NOTE_ADD_INTENT);
  if (reportAdd && workDir) {
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
  if (reportShow && workDir) {
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
  if (NEW_JOB_INTENT.test(task)) {
    if (!workDir) return 'Не удалось определить рабочую директорию. Попробуй ещё раз.';
    const existingVs = readVacancyState(workDir);
    if (existingVs && !['cancelled', 'hh_draft'].includes(existingVs.status)) {
      return `⚠️ Уже есть активная вакансия (статус: ${existingVs.status}). Чтобы отменить её и начать новую — скажи «отмени создание вакансии».`;
    }
    initVacancyState(workDir);
    return [
      '📋 Создаём новую вакансию!',
      '',
      'Кидай всё что есть — черновики, требования, заметки со звонков, переговоры с клиентом. Можно кусками, можно всё сразу.',
      '',
      'Когда всё скинешь — скажи «всё».',
    ].join('\n');
  }

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
    const lines = [
      `📊 Использование токенов (всего ${t.tasks} задач):`,
      `• Входящих: ${t.input_tokens.toLocaleString('ru-RU')}`,
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

  // /secrets_list — show connected services
  if (fuzzyInfoIntent(SECRETS_LIST_INTENT, task)) {
    const services = userId ? listConnectedServices(userId) : null;
    if (!services || services.length === 0) {
      return 'Нет подключённых сервисов.\n\nЧтобы подключить: «подключи GitHub», «подключи Налог.ру» и т. д.';
    }
    const lines = services.map(s => {
      const d = s.mtime.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
      return `• ${s.name} — обновлён ${d}`;
    });
    return [
      '🔑 Подключённые сервисы:',
      ...lines,
      '',
      'Отозвать: «отзови доступ к [сервис]»',
      'История обращений: /secrets_log',
    ].join('\n');
  }

  // /secrets_log — show access log
  if (fuzzyInfoIntent(SECRETS_LOG_INTENT, task)) {
    const log = userId ? getSecretsLog(userId) : null;
    if (!log || log.length === 0) return 'История обращений пуста.';
    const lines = log.map(l => {
      const [ts, svcs] = l.split('\t');
      const time = new Date(ts).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      return `${time} — ${svcs}`;
    });
    return '📋 Последние обращения к вашим данным:\n' + lines.join('\n');
  }

  // Service status check — "github подключен?", "статус nalog"
  if (SERVICE_STATUS_INTENT.test(task) && userId) {
    const svcMatch = task.match(SERVICE_STATUS_RE);
    if (svcMatch) {
      const ALIASES = { вик: 'weeek', налог: 'nalog', нпд: 'nalog', фигма: 'figma', тильда: 'tilda', геткурс: 'getcourse', гугл: 'gdrive' };
      const key = ALIASES[svcMatch[1].toLowerCase()] || svcMatch[1].toLowerCase();
      const display = SERVICE_DISPLAY[key] || key;
      const services = listConnectedServices(userId);
      const found = services?.find(s => s.file === key);
      if (found) {
        const d = found.mtime.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
        return `✅ ${display} подключён (обновлён ${d}).`;
      }
      return `❌ ${display} не подключён. Напиши «подключи ${display}» чтобы добавить.`;
    }
  }

  // Revoke — delete a service token
  if (REVOKE_INTENT.test(task)) {
    const svcMatch = task.match(REVOKE_SERVICE_RE);
    if (!svcMatch) return 'Укажи сервис для отзыва, например: «отзови доступ к GitHub»';
    if (!userId) return 'Не удалось определить пользователя.';

    const isGdrive = /gdrive|гугл|google/i.test(svcMatch[1]);

    if (isGdrive && workDir) {
      const pendingFile = path.join(workDir, '.revoke_gdrive_pending.json');
      if (REVOKE_CONFIRM_RE.test(task)) {
        // Confirmed — check pending file
        let pending = null;
        try { pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); } catch { /* no pending */ }
        const isValid = pending && pending.expiresAt > Date.now();
        if (!isValid) return '⚠️ Подтверждение устарело. Напиши «отключи Google Drive» ещё раз.';
        try { fs.unlinkSync(pendingFile); } catch { /* ignore */ }
        // Fire-and-forget SA deletion (getQuickAnswer is sync)
        deleteGdriveSA(userId).catch(e => console.error('[gdrive-revoke] SA delete failed:', e.message));
        const revokeResult = revokeService(userId, 'gdrive');
        if (revokeResult === 'not_found') return 'Сервис Google Drive не был подключён.';
        return '✅ Google Drive отключён. Удаление сервис-аккаунта из GCP запущено.';
      } else {
        // First request — ask for confirmation, write pending file
        const gdriveFile = path.join(os.homedir(), 'agent-tokens', String(userId), 'gdrive');
        if (!fs.existsSync(gdriveFile)) return 'Google Drive не был подключён.';
        try {
          fs.writeFileSync(pendingFile, JSON.stringify({ service: 'gdrive', expiresAt: Date.now() + 5 * 60 * 1000 }), { mode: 0o600 });
        } catch { /* non-critical */ }
        return '⚠️ Это удалит подключение Google Drive и сервис-аккаунт из GCP.\n\nПодтвердить? Напиши «да, удали»';
      }
    }

    const result = revokeService(userId, svcMatch[1]);
    if (result === null) return `Не распознал сервис «${svcMatch[1]}». Доступные: GitHub, Weeek, Налог.ру, Figma, Tilda, Google Drive.`;
    if (result === 'not_found') return `Сервис «${svcMatch[1]}» не был подключён.`;
    return `✅ Доступ к ${SERVICE_DISPLAY[result] || result} отозван. Данные удалены с сервера.`;
  }

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
      const sa2 = JSON.parse(fs.readFileSync(gdriveFile2, 'utf8'));
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

  // Capability question about exhibition participants — only if expo pipeline exists for this profile
  if (EXPO_CAPABILITY_INTENT.test(task) && !sessionExists) {
    if (!workDir || !fs.existsSync(path.join(workDir, 'expo-pipeline'))) return null;
    return 'Да, умею собирать участников выставок.\n\nДай мне ссылку на сайт выставки — зайду, найду страницу участников и верну список компаний в CSV.\n\nДальше могу обогатить по ИНН: директор, выручка, сайт — скидывай сразу с таким запросом, если нужно.\n\nПришли URL сайта выставки.';
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

  // Expo pipeline — target criteria (quick read from disk, no LLM)
  // Length guard: long messages are instructions, not criteria lookup requests
  if (EXPO_CRITERIA_INTENT.test(task) && task.length < 200 && workDir) {
    try {
      const pipelineDirC = path.join(workDir, 'expo-pipeline');
      if (fs.existsSync(pipelineDirC)) {
        const { formatCriteriaText, readCriteria } = require('../mcp-skills/tools/87-expo-pipeline.js');
        const criteria = readCriteria(workDir);
        return formatCriteriaText(criteria);
      }
    } catch (e) {
      console.error('[quick-answer] expo criteria error:', e.message);
    }
  }

  // Expo pipeline — site config / filter ranges
  if (EXPO_SITE_CONFIG_INTENT.test(task) && task.length < 200 && workDir) {
    try {
      const pipelineDir = path.join(workDir, 'expo-pipeline');
      if (fs.existsSync(pipelineDir)) {
        const { formatSiteConfigText, readSiteConfig } = require('../mcp-skills/tools/87-expo-pipeline.js');
        const config = readSiteConfig(workDir);
        return formatSiteConfigText(config);
      }
    } catch (e) {
      console.error('[quick-answer] expo site-config error:', e.message);
    }
  }

  // Expo pipeline — pipeline status (quick count from disk)
  if (EXPO_STATUS_INTENT.test(task) && workDir) {
    try {
      const pipelineBase = require('path').join(workDir, 'expo-pipeline');
      if (require('fs').existsSync(pipelineBase)) {
        const dirs = require('fs').readdirSync(pipelineBase, { withFileTypes: true })
          .filter(e => e.isDirectory());
        if (dirs.length === 0) return 'Нет активных pipeline. Запусти обработку выставки чтобы начать.';
        const lines = dirs.map(d => {
          const dir = require('path').join(pipelineBase, d.name);
          function count(f, key) {
            try {
              const data = JSON.parse(require('fs').readFileSync(require('path').join(dir, f), 'utf8'));
              const arr = Array.isArray(data) ? data : (data[key] || data.companies || data.results || []);
              return arr.length;
            } catch (e) { console.warn('[runner] expo count parse:', e.message); return null; }
          }
          const c = count('companies.json', 'companies');
          const e = count('enriched.json', 'companies');
          const t = count('targets.json', 'companies');
          return `📁 ${d.name}\n   Компаний: ${c ?? '—'} | Обогащено: ${e ?? '—'} | Целевых: ${t ?? '—'}`;
        });
        return '📊 Статус pipeline:\n\n' + lines.join('\n\n');
      }
    } catch (e) {
      console.error('[quick-answer] expo status error:', e.message);
    }
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
  const orKey = openrouterKey || process.env.OPENROUTER_API_KEY;
  if (!orKey) return false;
  const vs = readVacancyState(workDir);
  if (!vs?.draft) return false; // no draft — nothing to publish

  try {
    const body = JSON.stringify({
      model: 'z-ai/glm-5.3-flash',
      messages: [
        {
          role: 'system',
          content: 'You classify recruiter bot messages. Answer with a single word: YES or NO.',
        },
        {
          role: 'user',
          content: `Does this message ask to publish, generate, create, or rebuild the vacancy landing page (страница вакансии / лендинг)?\n\nMessage: "${task}"\n\nYES or NO:`,
        },
      ],
      max_tokens: 5,
      temperature: 0,
    });
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(2500),
    });
    const data = await res.json();
    const answer = data.choices?.[0]?.message?.content?.trim().toUpperCase() || '';
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
  const orKey = openrouterKey || process.env.OPENROUTER_API_KEY;
  if (!orKey || !answerPreview) return true;
  try {
    const body = JSON.stringify({
      model: 'z-ai/glm-5.3-flash',
      messages: [
        {
          role: 'system',
          content: 'You verify chatbot auto-replies before they are sent. Answer with a single word: YES or NO.',
        },
        {
          role: 'user',
          content: `A user sent this message to a chatbot:\n"${task}"\n\nThe bot is about to auto-reply with something like this:\n"${String(answerPreview).slice(0, 300)}"\n\nDoes the user's message actually request this kind of reply? If unsure, answer YES.\n\nYES or NO:`,
        },
      ],
      max_tokens: 5,
      temperature: 0,
    });
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(2500),
    });
    const data = await res.json();
    const answer = data.choices?.[0]?.message?.content?.trim().toUpperCase() || '';
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
  const notificationIntents = require('../domains/hh/intents');
  if (userId && workDir && (notificationIntents.HH_NOTIFY_OFF_INTENT.test(task) || notificationIntents.HH_NOTIFY_ON_INTENT.test(task))) {
    return 'Уведомления холодного поиска выключены: функция удалена для всех пользователей. Настройки автопоиска не изменены.';
  }

  if (notificationIntents.HH_SEARCH_OFF_INTENT.test(task) && userId && workDir) {
    try {
      require('../hh-cold-search-schedule').disableSearches(userId, workDir);
      return 'Автопоиск выключен для всех вакансий профиля. Ручной поиск доступен.';
    } catch { return 'Не удалось остановить автопоиск. Попробуй ещё раз.'; }
  }
  // Never mistake notification settings or a quoted complaint for new responses.
  if (notificationIntents.HH_NOTIFICATION_REQUEST.test(task)) return null;
  // Engineering complaints containing quoted recruiter commands are full tasks.
  if (require('../domains/hh/intents').HH_SERVICE_CHANGE_INTENT.test(task) && /hh|хх|отклик|кандидат/i.test(task)) return null;
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
        const sum = full && await generateSummary(full.messages, { apiKey: openrouterKey });
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
          const sum = await generateSummary(full.messages, { apiKey: openrouterKey });
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
            const res = await generateProjectSummary(projSess, { apiKey: orK });
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

  // Vacancy generation — triggered when collecting mode is done ("всё" set status → "generating")
  if (workDir && openrouterKey) {
    const vs = readVacancyState(workDir);
    if (vs?.status === 'generating' && vs.messages?.length > 0) {
      const r = await generateVacancyFromMessages(workDir, vs.messages, openrouterKey, userId).catch(e => {
        console.error('[vacancy] generation error:', e.message);
        writeVacancyState(workDir, { ...vs, status: 'collecting' }); // rollback so user can retry
        return '⚠️ Ошибка при генерации вакансии. Попробуй ещё раз — скажи «всё» когда будешь готов.';
      });
      if (r) return r;
    }
  }

  // Publish vacancy landing page — regex fast-path OR Haiku fallback when draft exists
  const hhTokenPath = userId ? path.join(os.homedir(), 'agent-tokens', String(userId), 'hh') : null;
  const hhConnected = hhTokenPath && fs.existsSync(hhTokenPath);
  if (workDir && userId && hhConnected) {
    const wantsPage = VACANCY_PUBLISH_PAGE_INTENT.test(task)
      || await classifyVacancyPublishIntent(task, workDir, openrouterKey);

    if (wantsPage) {
      const vs = readVacancyState(workDir);
      if (vs?.draft) {
        const r = await publishVacancyPage(workDir, vs.draft, vs.vacancy_id, userId).then(url => {
          const missing = getMissingFields(vs.draft);
          const missingNote = missing.length
            ? `\n\n📋 Уточни, чтобы дополнить страницу:\n${missing.join('\n')}`
            : '';
          return [
            '🌐 Страница вакансии опубликована!',
            '',
            url,
            missingNote,
            '',
            'Когда рекрутер даст правки — скажи что изменить, пересоздам страницу.',
            'Готово публиковать на HH? Скажи «опубликуй черновик на HH».',
          ].join('\n');
        }).catch(e => {
          console.error('[vacancy] publish page error (→ Claude):', e.message);
          const vsE = readVacancyState(workDir);
          if (vsE) writeVacancyState(workDir, { ...vsE, api_error: e.message });
          return null; // let Claude see the error in its context and handle it
        });
        if (r) return r;
      }
      if (!readVacancyState(workDir)?.draft) {
        return '⚠️ Нет готового черновика вакансии. Сначала создай вакансию — скажи «новая вакансия».';
      }
    }
  }

  // Fast-path: "подготовь черновик вакансии на HH" — when data is already known or being provided
  // Workflow: draft_ready → push to HH immediately; else → start single-shot collecting mode
  if (workDir && userId && hhConnected && VACANCY_PREP_DRAFT_INTENT.test(task)) {
    const vsp = readVacancyState(workDir);
    if (vsp?.status === 'draft_ready' && vsp.draft) {
      const rp = await publishToHH(workDir, userId).then(({ hhId, areaName, areaId }) => {
        const areaNote = areaId ? '' : `\n⚠️ Город «${areaName}» не распознан — вакансия создана с регионом «Россия». Поправь город в черновике на hh.ru.`;
        return [
          `✅ Черновик вакансии сохранён на HeadHunter!`,
          '',
          `🆔 Draft ID: ${hhId}`,
          `🔗 Черновики: https://hh.ru/employer/vacancies/drafts`,
          areaNote,
          '',
          'Черновик НЕ опубликован — он ждёт тебя на hh.ru. Проверь и нажми «Опубликовать» когда будешь готов.',
        ].filter(Boolean).join('\n');
      }).catch(e => {
        console.error('[vacancy] HH publish error (→ Claude):', e.message);
        const vsE = readVacancyState(workDir);
        if (vsE) writeVacancyState(workDir, { ...vsE, api_error: e.message });
        return null; // let Claude see the error in its context and handle it
      });
      if (rp) return rp;
    }
    if (vsp?.status === 'collecting') return '⏳ Уже собираем данные для вакансии. Кидай текст — когда всё готово, скажи «всё».';
    if (vsp?.status === 'generating') return '⏳ Уже генерирую черновик вакансии, подожди немного...';
    if (!vsp || ['cancelled', 'hh_draft'].includes(vsp.status)) {
      initVacancyState(workDir);
      return [
        '📋 Готовлю черновик вакансии для HeadHunter!',
        '',
        'Скинь всё что есть: текст с сайта, описание должности, требования, условия.',
        'Можно одним большим куском — всё прочитаю.',
        '',
        'Когда отправишь — скажи «всё», сгенерирую вакансию и выложу черновик на HH.',
      ].join('\n');
    }
  }

  // Publish vacancy as HH draft
  if (workDir && userId && hhConnected && VACANCY_HH_PUBLISH_INTENT.test(task)) {
    const vs2 = readVacancyState(workDir);
    if (!vs2?.draft) {
      return '⚠️ Нет готового черновика вакансии. Сначала создай вакансию — скажи «новая вакансия».';
    }
    const r2 = await publishToHH(workDir, userId).then(({ hhId, areaName, areaId }) => {
      const areaNote = areaId ? '' : `\n⚠️ Город «${areaName}» не распознан — вакансия создана с регионом «Россия». Поправь город в черновике на hh.ru.`;
      return [
        `✅ Черновик вакансии сохранён на HeadHunter!`,
        '',
        `🆔 Draft ID: ${hhId}`,
        `🔗 Черновики: https://hh.ru/employer/vacancies/drafts`,
        areaNote,
        '',
        'Черновик НЕ опубликован — он ждёт тебя на hh.ru. Проверь и нажми «Опубликовать» когда будешь готов.',
      ].filter(Boolean).join('\n');
    }).catch(e => {
      console.error('[vacancy] HH publish error (→ Claude):', e.message);
      const vsE = readVacancyState(workDir);
      if (vsE) writeVacancyState(workDir, { ...vsE, api_error: e.message });
      return null; // let Claude see the error in its context and handle it
    });
    if (r2) return r2;
  }

  if (userId && workDir && hhConnected) {
    // Product changes and quoted broken bot replies must reach the full agent.
    if (require('../domains/hh/intents').HH_SERVICE_CHANGE_INTENT.test(task)) return null;
    const hhIntents = [HH_STATUS_INTENT, HH_MY_VACANCIES_INTENT, HH_FUNNEL_INTENT,
      HH_RESPONSES_INTENT, HH_ATS_EDITOR_INTENT, HH_REVIEW_PAGE_INTENT,
      HH_WHERE_PROMPT_INTENT, HH_SHOW_ATS_CONFIG_INTENT, HH_STYLE_INTENT,
      HH_EVALUATE_INTENT, HH_SEND_INTENT, HH_SEND_CONFIRM_INTENT, HH_SEND_CANCEL_INTENT,
      HH_REJECT_INTENT, HH_REJECT_CONFIRM_INTENT, HH_REJECT_CANCEL_INTENT, HH_SCAN_INTENT];
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
