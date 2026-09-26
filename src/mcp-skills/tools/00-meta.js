'use strict';

// Meta-tool: skill discovery
// Loaded first (00- prefix) so list_skills appears at top of tools/list
//
// SKILLS is a human-readable catalog — name, description, requires.
// Tool names are intentionally omitted: Claude sees the full list via tools/list,
// and keeping them here would just drift out of sync.

const SKILLS = [
  {
    id: 'cron',
    name: 'Cron — расписание задач',
    description: 'Создаёт повторяющиеся задачи через Google Cloud Scheduler. Задача запускается по расписанию с полным доступом ко всем скилам. Готовый шаблон: cron_hh_digest для дайджеста откликов HH.',
    requires: 'Работает только на GCP VM (нужен VM service account). AGENT_SECRET должен быть в secrets.env.',
  },
  {
    id: 'context-store',
    name: 'Context Store',
    description: 'Persistent key-value store per skill — survives session restarts. Used to remember active vacancy, ATS config, in-progress work, user preferences across sessions.',
    requires: 'Ничего — всегда доступно.',
  },
  {
    id: 'nalog-npd',
    name: 'Самозанятый НПД (nalog.ru)',
    description: 'Доходы, чеки НПД через API lknpd.nalog.ru. Токен нужен с Chrome extension.',
    requires: 'Открой lknpd.nalog.ru в Chrome → нажми иконку расширения cloud-auth-bridge → "Send token". Токен живёт ~1 час.',
  },
  {
    id: 'tilda-site-ops',
    name: 'Tilda Site Ops',
    description: 'Работа с Tilda: страницы, блоки, публикация. Test-first: сначала тест, потом прод.',
    requires: 'browser_session_url → пользователь логинится в удалённый браузер → browser_session_capture_cookies("tilda.ru", "tilda-session")',
  },
  {
    id: 'browser-session',
    name: 'Remote Browser Session',
    description: 'Удалённый Chrome на VM (noVNC). Позволяет залогиниться в любой сервис с IP виртуалки и захватить сессию. Решает IP-binding и CAPTCHA.',
    requires: 'ничего — браузер всегда запущен',
  },
  {
    id: 'weeek-crm',
    name: 'Weeek CRM',
    description: 'Управление сделками, контактами и воронками в Weeek.net через REST API. Токен не протухает.',
    requires: '/settoken weeek <token> — токен: Weeek → Settings → Integrations → API → Generate',
  },
  {
    id: 'company-enrichment',
    name: 'Обогащение компаний (rusprofile)',
    description: 'Найти компанию по названию → ИНН → полные данные (CEO, контакты, выручка, адрес). Бесплатно через rusprofile.ru, или быстрее с DaData API.',
    requires: 'Ничего — бесплатный режим работает сразу. Опционально: DaData token для ускорения.',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Работа с GitHub: репозитории, issues, pull requests, файлы. Читать/создавать задачи, PR, комментарии, файлы.',
    requires: 'Вызови connect({ service: "github" }) — получишь защищённую ссылку для ввода PAT. Scope: repo, read:org.',
  },
  {
    id: 'business-analyst',
    name: 'Business/Systems Analyst — постановка задач',
    description: 'Постановка задачи ДО начала работы любого исполнительского скила (dev/ci-cd/qa/deploy) — это отдельная от кодинга роль. ' +
      'ba_clarify_requirements классифицирует задачу по размеру (trivial/small/feature) и задаёт только те вопросы, ' +
      'которые реально неясны для этого уровня. Для feature-уровня — ba_write_spec: durable EARS-спека (requirements, ' +
      'acceptance criteria, out of scope, tasks) файлом в репозитории, ДО правок кода, чтобы намерение не терялось между сессиями. ' +
      'Для больших инженерных задач — ba_development_playbook (если плейбук разработки подключён) → конкретные items → один task_create: SQLite draft-план переживает рестарт (автовыполнение пока не включено). ' +
      'Для trivial/small — без вопросов и без спеки, это чистые накладные расходы.',
    requires: 'Ничего — работает сразу, для любой задачи.',
  },
  {
    id: 'dev',
    name: 'Developer — разработка ПО',
    description: 'Исполнение (не постановка задачи — см. business-analyst; не CI/CD-трекинг — см. ci-cd): клонирует репозиторий на VM, редактирует файлы, запускает тесты, коммитит, пушит, создаёт PR. ' +
      'Workflow: ba_clarify_requirements/ba_write_spec (постановка) → dev_workspace_setup (clone + npm install) → ' +
      'редактирование через Read/Edit/Write → тесты через bash → git commit/push (включая specs/) → github_create_pr → cicd_track_pr. ' +
      'Если нет аккаунта GitHub — рекомендуй создать на github.com (бесплатно). ' +
      'Если нет репозитория — предложи dev_new_repo.',
    requires: 'GitHub токен (scope: repo). Подключи через connect({ service: "github" }).',
  },
  {
    id: 'ci-cd',
    name: 'CI/CD — трекинг PR до продакшена',
    description: 'Доводит открытый PR до готовности своими силами: cicd_track_pr пишет checklist.md, и durable GTD-контроллер ' +
      'сам следит за CI → merge → deploy, без напоминаний и переживая рестарты VM. QA и deploy как отдельные скилы ' +
      'пока не существуют — тесты гоняются через bash (npm test/pytest/…) внутри dev, а деплой у каждого проекта свой ' +
      '(wrangler/systemctl/gcloud/…), нет общей механики, которую стоило бы выносить в отдельный тул. Появится нужда — заведём.',
    requires: 'Ничего — работает сразу после github_create_pr.',
  },
  {
    id: 'inn-enrichment',
    name: 'INN Enrichment — обогащение компаний',
    description: 'Для списка компаний (300–1000) находит ИНН, ОГРН, директора, выручку, прибыль. ' +
      'Источники: BFO ФНС (бесплатно), ЕГРЮЛ (бесплатно), сайты компаний, DaData, Checko. ' +
      'Параллельно, 300 компаний за 10–15 мин. Hit rate 60–85%.',
    requires: [
      'BFO ФНС — бесплатно, без настройки',
      'ЕГРЮЛ — бесплатно, без настройки',
      'DaData — inn_set_dadata_token(token, secret)  → ускоряет fallback',
      'Checko — inn_set_checko_key(key)  → финансы для компаний не найденных в BFO',
      'Rusprofile — бесплатно; при блокировке → inn_set_rusprofile_cookie(cookie)',
    ].join('\n'),
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    description: 'Читать, создавать и редактировать файлы в Google Drive через персональный Service Account. Настройка за одну команду — gdrive_setup автоматически создаёт SA.',
    requires: 'Вызови gdrive_setup → получишь email → расшарь папки/файлы Drive с этим email. gdrive_write_sheet создаёт/перезаписывает вкладку в Google Spreadsheet.',
  },
  {
    id: 'getcourse',
    name: 'GetCourse',
    description: 'Двухуровневая интеграция с GetCourse. L1 (API key): управление учениками, группами, заказами. L2 (сессия браузера): создание курсов, разделов, уроков, видео- и текстовых блоков.',
    requires: 'Вызови gc_connect — получишь ссылку. Введи домен + API ключ (L1) и/или логин+пароль (L2).',
  },
  {
    id: 'expo-participants',
    name: 'Выставки — список участников',
    description: 'Стандартный скил для сбора участников выставки: найти страницу участников/экспонентов → спарсить компании → CSV для обогащения ИНН. ' +
      'Для JS-сайтов — используй browser/WebFetch чтобы получить HTML, затем expo_parse_participants. ' +
      'Результат сразу совместим с inn_enrich_batch.',
    requires: 'Ничего — достаточно URL сайта выставки. Для JS-сайтов нужен Browser Session или Playwright.',
  },
  {
    id: 'expo-flexi',
    name: 'Выставки — Flexi (классификация целевых)',
    description: 'Классифицирует компании выставки по критериям Flexi (российский производитель, выручка 150–5000 млн руб) ' +
      'и генерирует EX-массив для HTML-каталога. Работает поверх inn_enrich_batch.',
    requires: 'Ничего — работает поверх результатов inn_enrich_batch.',
  },
  {
    id: 'flexi-sales',
    name: 'Flexi — заметки на выставке + сделки',
    description: 'Работа на выставке: добавлять текстовые заметки по стендам, читать заметки команды, ' +
      'помечать компании как отказ/в работе. Данные синхронизируются с интерактивным каталогом сайта ' +
      '(floorplans-2026.pages.dev). Создание сделок в Weeek — через weeek_create_deal.',
    requires: 'Ничего — работает без авторизации. Вызови flexi_set_exhibition(event_key) чтобы выбрать выставку.',
  },
  {
    id: 'hh-recruiting',
    name: 'HeadHunter — рекрутинг',
    description: 'Полный цикл работы с откликами на hh.ru: список вакансий, откликов, LLM-оценка резюме (ATS-скоринг с нокаутами и весами), генерация первого сообщения, отправка, перевод в статусы, bulk-отказ для здоровья аккаунта, профиль кандидата для заказчика.',
    requires: 'hh_set_token — получи access token на hh.ru (Настройки → API) или через OAuth и передай сюда. Для LLM-функций нужен OPENROUTER_API_KEY в env.',
  },
  {
    id: 'candidate-client-report',
    name: 'Профиль кандидата для клиента',
    description: 'HTML-профиль кандидата для клиента/работодателя (шапка с бейджами, кратко о себе, матрица соответствия ✓/~/✗, опыт, вывод рекрутера от первого лица, видео скрининга; печать A4). Правки рекрутера («не упоминать удалёнку», «писать от первого лица») хранятся в <кандидат>-report-notes.md и применяются при каждой перегенерации автоматически. Команды: «сделай профиль кандидата [имя] для клиента [компания]», «перегенерируй профиль [имя]», «добавь в требования: …», «покажи требования к профилю [имя]».',
    requires: 'Ничего — всегда доступно. Публикация через publish_page (пароль рекомендуется — персональные данные).',
  },
  {
    id: 'hh-discovery',
    name: 'HeadHunter — Discovery (расширенный доступ к API)',
    description: 'Fallback для операций с HH которые не покрыты основным hh-recruiting скилом: создание вакансий, справочники (города, профроли, валюты), биллинг, произвольные API-запросы. hh_discover показывает доступные endpoints; hh_api_call выполняет любой из них.',
    requires: 'HH токен (тот же что для hh-recruiting).',
  },
  {
    id: 'getcourse-discovery',
    name: 'GetCourse — Discovery (расширенный доступ к API)',
    description: 'Fallback для GC операций не покрытых gc_* скилами: вебинары, воронки/CRM-сделки, платежи, офферы, уведомления, любые L1/L2 запросы. gc_discover показывает доступные endpoints; gc_api_call выполняет любой.',
    requires: 'GetCourse подключён через gc_connect (L1: API ключ; L2: логин+пароль для сессии).',
  },
  {
    id: 'api-from-website',
    name: 'API из сайта (DRAFT)',
    description: 'Если есть логин+пароль к сайту — можно использовать его как API. Сохраняем credentials, делаем HTTP-запросы с Basic/Bearer авторизацией, исследуем доступные endpoints. Фаза 2 (TODO): автодискавери через Playwright — логин в браузере, захват XHR, каталог endpoints.',
    requires: 'website_credentials_save(url, login, password) — credentials хранятся plain-text (mode 0o600). Только для внутренних/не-критичных сайтов.',
  },
];

module.exports = {
  tools: {
    list_skills: {
      description: 'List all available agent skills and integrations. Call this when user asks "what can you do?" or "what integrations do you have?"',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ skills: SKILLS }),
    },
  },
};
