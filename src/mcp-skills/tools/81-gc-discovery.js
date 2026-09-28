'use strict';

// GetCourse Discovery — fallback for GC operations not covered by 80-getcourse.js
//
// Two tools:
//   gc_discover   — static catalog of GetCourse API capabilities + optional live call
//   gc_api_call   — make an arbitrary L1 (API key) or L2 (session) request
//
// L1 (API key):  POST /pl/api/account/* with action=export|add|edit|delete
// L2 (session):  POST /pl/teach/gcapi/* or GET/POST arbitrary URL with session cookies
//
// Use when user asks something GC-related that existing gc_* tools don't handle:
//   "создай вебинар", "настрой автоворонку", "удали заказ", "список платежей" etc.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readCredentialFile } = require('../../credential-store');

const USER_ID = process.env.USER_ID || '';
const FALLBACK_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function tokenBase() {
  return process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
}

function readConfig(userId) {
  const file = path.join(tokenBase(), String(userId || USER_ID), 'getcourse', 'config.json');
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(readCredentialFile(file)); } catch { return {}; }
}

// Static GetCourse API capability catalog
// Source: https://getcourse.ru/blog/299528 (official L1 API docs) + L2 session endpoints
const GC_CAPABILITIES = {
  users: {
    description: 'Пользователи',
    level: 'L1',
    endpoint: '/pl/api/account/users',
    ops: [
      { action: 'export', note: 'Список пользователей с фильтрами (email, group_id, created_at, registered_at и др.)' },
      { action: 'add',    note: 'Добавить/обновить пользователя (email, first_name, last_name, phone, group_name, tags)' },
      { action: 'edit',   note: 'Изменить поля пользователя по id' },
    ],
  },
  orders: {
    description: 'Заказы',
    level: 'L1',
    endpoint: '/pl/api/account/orders',
    ops: [
      { action: 'export', note: 'Список заказов с фильтрами (user_id, offer_id, status, created_at, paid_at)' },
      { action: 'add',    note: 'Создать заказ для пользователя (email, offer_code, currency, cost)' },
      { action: 'edit',   note: 'Изменить статус заказа (paid, cancelled, pending)' },
    ],
  },
  deals: {
    description: 'Сделки (CRM)',
    level: 'L1',
    endpoint: '/pl/api/account/deals',
    ops: [
      { action: 'export', note: 'Список сделок (user_id, funnel_id, stage_id, status, manager_id)' },
      { action: 'add',    note: 'Создать сделку (user_email, funnel_code, stage_code, cost, comment)' },
      { action: 'edit',   note: 'Переместить сделку в другую стадию или поменять менеджера' },
    ],
  },
  payments: {
    description: 'Платежи',
    level: 'L1',
    endpoint: '/pl/api/account/payments',
    ops: [
      { action: 'export', note: 'Список платежей (order_id, user_id, amount, currency, created_at, system)' },
    ],
  },
  websitepages: {
    description: 'Страницы сайта',
    level: 'L1',
    endpoint: '/pl/api/account/websitepages',
    ops: [
      { action: 'export', note: 'Список лендингов/страниц с id, title, url, status' },
    ],
  },
  offers: {
    description: 'Офферы (тарифы)',
    level: 'L1',
    endpoint: '/pl/api/account/offers',
    ops: [
      { action: 'export', note: 'Список офферов (id, code, title, price, currency, training_id)' },
    ],
  },
  trainings: {
    description: 'Курсы и вебинары (L2)',
    level: 'L2',
    ops: [
      { endpoint: '/pl/teach/gcapi/createTraining', method: 'POST', note: 'Создать курс/вебинар (title, description, type: online|webinar|auto)' },
      { endpoint: '/pl/teach/gcapi/updateTraining', method: 'POST', note: 'Обновить курс' },
      { endpoint: '/pl/teach/gcapi/deleteTraining', method: 'POST', note: 'Удалить курс' },
      { endpoint: '/pl/teach/gcapi/createSection',  method: 'POST', note: 'Создать раздел курса (training_id, title)' },
      { endpoint: '/pl/teach/gcapi/createLesson',   method: 'POST', note: 'Создать урок (section_id, title, type: text|video|test)' },
    ],
  },
  webinars: {
    description: 'Вебинары (L2)',
    level: 'L2',
    ops: [
      { endpoint: '/pl/teach/gcapi/createWebinar',   method: 'POST', note: 'Создать вебинар-комнату (training_id, start_time, duration)' },
      { endpoint: '/pl/teach/gcapi/startWebinar',    method: 'POST', note: 'Запустить вебинар (webinar_id)' },
      { endpoint: '/pl/teach/gcapi/stopWebinar',     method: 'POST', note: 'Остановить вебинар (webinar_id)' },
    ],
  },
  funnels: {
    description: 'Воронки / Автоворонки',
    level: 'L1+L2',
    ops: [
      { action: 'export', endpoint: '/pl/api/account/deals', note: 'Список воронок через deals export (поле funnel_id)' },
      { endpoint: '/pl/teach/gcapi/getFunnels', method: 'GET', level: 'L2', note: 'Полный список воронок с этапами' },
    ],
  },
  notifications: {
    description: 'Уведомления / Email / SMS (L1)',
    level: 'L1',
    endpoint: '/pl/api/account/notifications',
    ops: [
      { action: 'export', note: 'Список уведомлений (user_id, type: email|sms|push)' },
      { action: 'add',    note: 'Отправить уведомление пользователю (user_id, notification_id)' },
    ],
  },
};

function matchCapabilities(query) {
  if (!query) return GC_CAPABILITIES;
  const q = query.toLowerCase();
  const result = {};
  for (const [key, section] of Object.entries(GC_CAPABILITIES)) {
    if (
      key.includes(q) ||
      section.description.toLowerCase().includes(q) ||
      section.ops?.some(op => (op.note || '').toLowerCase().includes(q))
    ) {
      result[key] = section;
    }
  }
  return Object.keys(result).length > 0 ? result : GC_CAPABILITIES;
}

async function gcL1Call(cfg, endpoint, action, params) {
  const paramsB64 = Buffer.from(JSON.stringify(params || {})).toString('base64');
  const body = new URLSearchParams({ action, key: cfg.apiKey, params: paramsB64 });
  const res = await fetch(`https://${cfg.accountDomain}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 1000) }; }
}

async function gcL2Call(cfg, endpoint, { method = 'POST', body, query } = {}) {
  const cookieHeader = (cfg.sessionCookies || []).map(c => `${c.name}=${c.value}`).join('; ');
  const url = `https://${cfg.accountDomain}${endpoint}${query ? '?' + new URLSearchParams(query) : ''}`;
  const res = await fetch(url, {
    method,
    headers: {
      'User-Agent': cfg.sessionUserAgent || FALLBACK_UA,
      'Cookie': cookieHeader,
      'x-requested-with': 'XMLHttpRequest',
      'Origin': `https://${cfg.accountDomain}`,
      'Referer': `https://${cfg.accountDomain}/`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, raw: text.slice(0, 1000) }; }
}

module.exports = {
  isReady: () => {
    const cfg = readConfig(USER_ID);
    return Boolean(cfg.accountDomain);
  },
  setupTools: [],

  tools: {

    gc_discover: {
      description: 'Discover GetCourse API capabilities. Use when user asks for GC operations not covered by other gc_* tools — e.g. creating webinars, CRM deals, sending notifications, listing payments, working with funnels. Returns relevant endpoints with action types and notes. Pass call_l1 or call_l2 to also fetch live data.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What user wants to do, e.g. "create webinar", "list payments", "deals funnel", "send notification"',
          },
          call_l1: {
            type: 'object',
            description: 'Optional: also execute an L1 API call. Fields: endpoint (e.g. "/pl/api/account/offers"), action ("export"), params (filter object)',
            properties: {
              endpoint: { type: 'string' },
              action:   { type: 'string' },
              params:   { type: 'object' },
            },
            required: ['endpoint', 'action'],
          },
          call_l2: {
            type: 'object',
            description: 'Optional: also execute an L2 session call. Fields: endpoint, method, body, query',
            properties: {
              endpoint: { type: 'string' },
              method:   { type: 'string' },
              body:     { type: 'object' },
              query:    { type: 'object' },
            },
            required: ['endpoint'],
          },
        },
        required: ['query'],
      },
      handler: async ({ query, call_l1, call_l2 }) => {
        const cfg = readConfig(USER_ID);
        if (!cfg.accountDomain) return { error: 'GetCourse не подключён. Вызови gc_connect.' };

        const capabilities = matchCapabilities(query);

        const levels = {
          L1: Boolean(cfg.apiKey),
          L2: Boolean(cfg.sessionCookies?.length),
        };

        let live_l1 = null;
        if (call_l1) {
          if (!cfg.apiKey) {
            live_l1 = { error: 'L1 API ключ не задан — вызови gc_connect и введи API ключ.' };
          } else {
            try { live_l1 = await gcL1Call(cfg, call_l1.endpoint, call_l1.action, call_l1.params); }
            catch (e) { live_l1 = { error: e.message }; }
          }
        }

        let live_l2 = null;
        if (call_l2) {
          if (!cfg.sessionCookies?.length) {
            live_l2 = { error: 'L2 сессия не задана — вызови gc_connect и введи логин+пароль.' };
          } else {
            try { live_l2 = await gcL2Call(cfg, call_l2.endpoint, call_l2); }
            catch (e) { live_l2 = { error: e.message }; }
          }
        }

        return {
          account: cfg.accountDomain,
          available_levels: levels,
          query,
          capabilities,
          hint: 'Use gc_api_call to execute any of these endpoints',
          ...(live_l1 ? { live_l1 } : {}),
          ...(live_l2 ? { live_l2 } : {}),
        };
      },
    },

    gc_api_call: {
      description: 'Make an arbitrary GetCourse API call. Use after gc_discover. L1 needs API key, L2 needs session cookies (both set via gc_connect).',
      inputSchema: {
        type: 'object',
        properties: {
          level: {
            type: 'string',
            enum: ['L1', 'L2'],
            description: 'L1 = API key (export/add/edit/delete), L2 = session cookies (Playwright-based endpoints)',
          },
          endpoint: {
            type: 'string',
            description: 'API path, e.g. "/pl/api/account/orders" or "/pl/teach/gcapi/createWebinar"',
          },
          action: {
            type: 'string',
            description: 'L1 only: export | add | edit | delete',
          },
          params: {
            type: 'object',
            description: 'L1: filter/payload object. L2: request body.',
          },
          method: {
            type: 'string',
            enum: ['GET', 'POST'],
            description: 'L2 only: HTTP method (default POST)',
          },
          query: {
            type: 'object',
            description: 'L2 only: URL query string params',
          },
        },
        required: ['level', 'endpoint'],
      },
      handler: async ({ level, endpoint, action, params, method, query }) => {
        const cfg = readConfig(USER_ID);
        if (!cfg.accountDomain) return { error: 'GetCourse не подключён. Вызови gc_connect.' };

        if (level === 'L1') {
          if (!cfg.apiKey) return { error: 'L1 API ключ не задан. Вызови gc_connect.' };
          if (!action) return { error: 'Для L1 нужен параметр action (export|add|edit|delete).' };
          return await gcL1Call(cfg, endpoint, action, params);
        } else {
          if (!cfg.sessionCookies?.length) return { error: 'L2 сессия не задана. Вызови gc_connect и введи логин+пароль.' };
          return await gcL2Call(cfg, endpoint, { method, body: params, query });
        }
      },
    },

  },
};
