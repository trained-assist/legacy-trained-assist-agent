'use strict';

// web_* — the default way to work with a web page (src/web-ops.js).
//
// The raw Playwright MCP tools (browser_navigate/browser_snapshot/browser_click on
// aria refs) stay available and win for unusual pages: canvas, iframes, file
// uploads, multi-tab work, network inspection. For «открой и посмотри», «найди
// кнопку», «заполни форму», «войди на сайт» these methods are cheaper and honest —
// one call instead of a snapshot round-trip, a real login-readiness answer instead
// of a guess, and no credentials in the model's context.

const ops = require('../../web-ops');

function fail(tool, e) {
  return { ok: false, tool, error: String((e && e.message) || e || 'unknown_error').slice(0, 300) };
}

const tools = {

  web_open: {
    description:
      'Открыть страницу в браузере юзера и вернуть её как есть: адрес, заголовок, HTTP-статус, ' +
      'текст страницы, число элементов и признак «нужен вход» (loginRequired). Это основной способ ' +
      'прочитать или проверить сайт — не playwright_browser_snapshot. ' +
      'Только http/https. Не открывай file:// и не подставляй произвольные URL от имени модели без проверки.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Адрес страницы, например "https://example.com/catalog".' },
        max_chars: { type: 'number', description: 'Сколько символов текста вернуть (по умолчанию 4000).' },
      },
      required: ['url'],
    },
    handler: async ({ url, max_chars } = {}) => {
      try {
        return await ops.openUrl(url, { maxChars: Number(max_chars) || undefined });
      } catch (e) { return fail('web_open', e); }
    },
  },

  web_find: {
    description:
      'Найти элементы на открытой странице по тексту/названию и вернуть их как список с handle. ' +
      'Дальше передай handle в web_click или web_fill. ' +
      'Пустой query (по умолчанию) — все видимые элементы. Нужен, чтобы не угадывать селекторы.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Подстрока текста, подписи, placeholder, name или ссылки. Пусто — все элементы.' },
        limit: { type: 'number', description: 'Сколько элементов вернуть (по умолчанию 25).' },
        include_hidden: { type: 'boolean', description: 'Включить невидимые элементы (по умолчанию false).' },
      },
    },
    handler: async ({ query, limit, include_hidden } = {}) => {
      try {
        return await ops.findOnPage({ query, limit: Number(limit) || undefined, includeHidden: Boolean(include_hidden) });
      } catch (e) { return fail('web_find', e); }
    },
  },

  web_click: {
    description:
      'Нажать элемент на открытой странице. Цель: handle из web_find ИЛИ {text|role|name|tag} — ' +
      'текст кнопки или ссылки работает напрямую. Возвращает адрес, заголовок и текст страницы после клика. ' +
      'Handle устарел (страница перерисовалась) — вызови web_find заново, не повторяй вслепую.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'object',
          description: 'handle из web_find или описание: {text:"Войти"} / {role:"button", name:"submit"} / {tag:"button"}.',
          properties: {
            handle: { type: 'string' },
            text: { type: 'string' },
            name: { type: 'string' },
            role: { type: 'string' },
            tag: { type: 'string' },
          },
        },
        text: { type: 'string', description: 'Короткая форма: текст кнопки/ссылки.' },
      },
    },
    handler: async ({ target, text } = {}) => {
      try {
        const t = target || (text ? { text } : {});
        if (!Object.keys(t).length) return { ok: false, tool: 'web_click', error: 'no_target', hint: 'Передай handle или {text}.' };
        return await ops.clickTarget(t);
      } catch (e) { return fail('web_click', e); }
    },
  },

  web_fill: {
    description:
      'Заполнить поля формы: fields: [{target, value}], где target — handle из web_find, текст подписи ' +
      'или {name:"email"} / {placeholder:"Телефон"}. ' +
      'Отправка — отдельное действие наружу: с submit:true форма сначала заполняется и возвращает ' +
      'confirm_submit_required; повтори с confirm_submit:true, только если отправка действительно нужна. ' +
      'Чекбоксы: value true/false, select: значение опции.',
    inputSchema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          description: 'Поля для заполнения.',
          items: {
            type: 'object',
            properties: {
              target: { type: 'object', description: 'handle / {text} / {name} / {placeholder}.' },
              value: { type: 'string', description: 'Значение (для чекбокса — "true"/"false").' },
            },
            required: ['target', 'value'],
          },
        },
        submit: { type: 'boolean', description: 'Нужно ли отправить форму после заполнения.' },
        confirm_submit: { type: 'boolean', description: 'Подтверждение отправки. Без него submit не выполняется.' },
      },
      required: ['fields'],
    },
    handler: async ({ fields, submit, confirm_submit } = {}) => {
      try {
        return await ops.fillFields({
          fields: Array.isArray(fields) ? fields : [],
          submit: Boolean(submit),
          confirmSubmit: Boolean(confirm_submit),
        });
      } catch (e) { return fail('web_fill', e); }
    },
  },

  web_login: {
    description:
      'Войти на сайт по сохранённым учётным данным (service_key — ключ credential-формы, ' +
      'например "hh-creds" или "getcourse"). Логин и пароль читает сам инструмент: в переписку, ' +
      'в контекст модели и в логи они не попадают, наружу возвращается только authenticated true/false. ' +
      'Нет ключа в хранилище → connect({service}) или credentials_form_create и ссылка пользователю; ' +
      'пароль в чат не проси. Сессия сохраняется и доступна браузеру пользователя.',
    inputSchema: {
      type: 'object',
      properties: {
        service_key: { type: 'string', description: 'Ключ credential-формы в хранилище, напр. "hh-creds".' },
        url: { type: 'string', description: 'Адрес страницы входа. Если не указан — используется уже открытая.' },
        submit: { type: 'boolean', description: 'Отправить форму входа (по умолчанию true). false — только заполнить поля.' },
      },
      required: ['service_key'],
    },
    handler: async ({ service_key, url, submit } = {}) => {
      try {
        return await ops.loginWith({ serviceKey: service_key, url, submit: submit !== false });
      } catch (e) { return fail('web_login', e); }
    },
  },

  web_state: {
    description:
      'Что сейчас открыто в браузере: адрес, заголовок, нужен ли вход, короткий текст. ' +
      'Используй, чтобы ответить «ты уже вошёл?» или «какая страница открыта» без нового обхода сайта.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      try { return await ops.pageState(); } catch (e) { return fail('web_state', e); }
    },
  },

  web_screenshot: {
    description:
      'Снимок текущей страницы в PNG. Возвращает путь — передай его в tg_send_file, ' +
      'чтобы показать пользователю, что получилось. Хранится в рабочей папке сессии, старые снимки удаляются.',
    inputSchema: {
      type: 'object',
      properties: {
        full_page: { type: 'boolean', description: 'Вся страница целиком (по умолчанию — только видимая часть).' },
      },
    },
    handler: async ({ full_page } = {}) => {
      try { return await ops.screenshot({ fullPage: Boolean(full_page) }); } catch (e) { return fail('web_screenshot', e); }
    },
  },
};

module.exports = {
  isReady: () => true,
  tools,
};
