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

  web_text: {
    description:
      'Прочитать ПРОДОЛЖЕНИЕ уже открытой страницы: вернуть кусок её текста по смещению, ' +
      'без повторной загрузки. Нужен, когда web_open сказал truncated:totalChars — дальше ' +
      'читается от nextOffset этим методом. Не открывает и не перезагружает страницу: ' +
      'смещения стабильны, потому что текст берётся из той же открытой страницы. ' +
      'Страница не открыта — сначала web_open.',
    inputSchema: {
      type: 'object',
      properties: {
        offset: { type: 'number', description: 'С какого символа читать (по умолчанию 0).' },
        max_chars: { type: 'number', description: 'Сколько символов вернуть (по умолчанию 4000).' },
      },
    },
    handler: async ({ offset, max_chars } = {}) => {
      try {
        return await ops.readTextWindow({ offset: Number(offset) || 0, maxChars: Number(max_chars) || undefined });
      } catch (e) { return fail('web_text', e); }
    },
  },

  web_ask: {
    description:
      'Спросить страницу: адрес + вопрос — внутри отвечает дешёвая модель по ТЕКСТУ страницы, наружу ' +
      'короткий ответ и дословная цитата, которая машинно сверяется как подстрока страницы. ' +
      'Если цитата не сошлась, метод НЕ отдаёт выдумку: возвращает текст, который видела модель, ' +
      'и читать надо самому (web_open/web_text). Цитата совпала — ответ можно цитировать пользователю. ' +
      'Длинная страница: модели уходит окно с наибольшим совпадением по словам вопроса, не голова страницы. ' +
      'Дёшево по контексту: наружу идёт ответ + одна цитата, а не вся страница. ' +
      'Не отправляет ничего наружу, только читает. Для «что там написано / какая цена / есть ли наличие» — сюда, ' +
      'а не читать страницу целиком.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Адрес страницы, напр. "https://example.com/product/42".' },
        question: { type: 'string', description: 'Вопрос по тексту страницы, напр. "какая цена и есть ли в наличии".' },
        max_input_chars: { type: 'number', description: 'Сколько символов текста отдать модели (по умолчанию 12000).' },
      },
      required: ['url', 'question'],
    },
    handler: async ({ url, question, max_input_chars } = {}) => {
      try {
        return await ops.askPage({
          url, question, maxInputChars: Number(max_input_chars) || undefined,
        });
      } catch (e) { return fail('web_ask', e); }
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
      'Чекбоксы: value true/false, select: значение опции. ' +
      'press:"Enter" — нажать клавишу на последнем заполненном поле (для «набери запрос и жми Enter»); ' +
      'нельзя одновременно с submit. Enter внутри формы отправляет её — делай только по просьбе пользователя.',
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
        press: { type: 'string', description: 'Клавиша после заполнения, напр. "Enter". Несовместимо с submit.' },
        confirm_submit: { type: 'boolean', description: 'Подтверждение отправки. Без него submit не выполняется.' },
      },
      required: ['fields'],
    },
    handler: async ({ fields, submit, confirm_submit, press } = {}) => {
      try {
        return await ops.fillFields({
          fields: Array.isArray(fields) ? fields : [],
          submit: Boolean(submit),
          confirmSubmit: Boolean(confirm_submit),
          press: press === undefined ? null : press,
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

  web_current_page: {
    description:
      'Что СЕЙЧАС открыто в браузере: адрес, заголовок, нужен ли вход, короткий текст. ' +
      'Используй, чтобы ответить «ты уже вошёл?» или «какая страница открыта» без нового обхода сайта. ' +
      'Это чтение текущего состояния, а НЕ выдача ссылки на вход — для ссылки на удалённый логин используй browser_session_remote_url.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      try { return await ops.pageState(); } catch (e) { return fail('web_current_page', e); }
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
