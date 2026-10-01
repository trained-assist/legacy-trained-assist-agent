'use strict';

// web-ops — the browser methods ordinary work needs, in one small set.
//
// Why this exists next to the Playwright MCP: the raw server (browser_navigate →
// browser_snapshot → browser_find → browser_click on a ref) is right for unusual
// pages and wrong as the default path. It costs a snapshot per page, its refs move
// under the model, and «does the page need a login?» is answered by guessing.
// These methods take the page as it is: open and read it, find a named control, fill
// a form, log in with credentials the model never sees, prove the result.
//
// Boundaries (kept deliberately narrow, they are the price of the smaller surface):
//   - one page per process (the run's MCP server) — no tab juggling; the raw server
//     covers that;
//   - http/https only; no file://, no data:, no arbitrary JS evaluation;
//   - credentials are read from the credential store and never returned;
//   - a submit is a two-step act (fill, then confirm_submit) because it leaves the
//     system — the same rule the interaction contract puts on `approval`.
//
// The browser is closed after an idle window and its cookies are written back to the
// SAME storage-state file the Playwright MCP server uses (src/browser.js), so a login
// done here is visible to the raw tools and vice versa.

const fs = require('fs');
const path = require('path');

const VIEWPORT = { width: 1280, height: 800 };
const NAV_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;
const IDLE_CLOSE_MS = 5 * 60 * 1000;
const MAX_SHOTS = 20;
const DEFAULT_TEXT_CHARS = 4000;
const DEFAULT_FIND_LIMIT = 25;

// One ordered query, so a `handle` is an index into a list both web_find and
// web_click rebuild the same way. A handle is only meaningful together with the
// descriptor it was minted from — see sameElement().
const INTERACTIVE_SELECTOR = [
  'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary',
  '[role="button"]', '[role="link"]', '[role="tab"]', '[role="checkbox"]',
  '[role="radio"]', '[role="menuitem"]', '[role="option"]',
].join(', ');

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

const LOGIN_URL_RE = /(^|\/)(login|log-in|signin|sign-in|signon|auth|authorize|wp-login|vkhod|vhod|voiti)([/?#]|$)/i;
const LOGIN_TEXT_RE = /(войти|вход|авторизац|выйти|log ?in|sign ?in|введите парол|password)/i;
const SUBMIT_TEXT_RE = /(войти|вход|submit|log ?in|sign ?in|продолжит|отправ|далее|save|сохрани|войти)/i;
const LOGIN_FIELD_RE = /(user|login|email|e-?mail|почт|логин|телефон|phone|account|никнейм|username)/i;

// ---------------------------------------------------------------- pure helpers

function checkUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'empty_url' };
  let parsed;
  try { parsed = new URL(raw.trim()); } catch { return { ok: false, reason: 'unparseable_url' }; }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, reason: `protocol_not_allowed: ${parsed.protocol}` };
  }
  return { ok: true, url: parsed.toString() };
}

function cleanText(raw, maxChars = DEFAULT_TEXT_CHARS) {
  const text = String(raw == null ? '' : raw)
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length <= maxChars) return { text, truncated: false, totalChars: text.length };
  return {
    text: `${text.slice(0, maxChars)}\n… [обрезано, всего ${text.length} символов]`,
    truncated: true,
    totalChars: text.length,
  };
}

function detectLoginRequired({ hasPasswordField = false, url = '', text = '' } = {}) {
  if (hasPasswordField) return { loginRequired: true, reason: 'password_field' };
  if (LOGIN_URL_RE.test(String(url || ''))) return { loginRequired: true, reason: 'url' };
  const head = String(text || '').slice(0, 2000);
  if (LOGIN_TEXT_RE.test(head) && /парол|password/i.test(head)) return { loginRequired: true, reason: 'text' };
  return { loginRequired: false, reason: null };
}

function isSubmitLike(item) {
  if (!item) return false;
  if (item.type === 'submit') return true;
  if (item.tag === 'button' && !item.type) return true;
  if (item.tag === 'input' && (item.value || '').toLowerCase() === 'submit') return true;
  return SUBMIT_TEXT_RE.test(`${item.text || ''} ${item.name || ''} ${item.id || ''}`);
}

// A field a login form would use: not a password (that is picked separately), not a
// submit button, and named like a login or just the first visible text-ish input.
function pickLoginField(items) {
  const candidates = items.filter(i => i.visible && !i.disabled
    && ['input', 'textarea'].includes(i.tag)
    && i.type !== 'password' && i.type !== 'submit' && i.type !== 'button'
    && i.type !== 'checkbox' && i.type !== 'radio' && i.type !== 'hidden');
  if (!candidates.length) return null;
  const named = candidates.find(i => LOGIN_FIELD_RE.test(`${i.name} ${i.id} ${i.placeholder} ${i.label}`));
  if (named) return named;
  const emailish = candidates.find(i => i.type === 'email' || i.type === 'tel');
  return emailish || candidates[0];
}

function pickPasswordField(items) {
  return items.find(i => i.visible && !i.disabled && i.type === 'password') || null;
}

function pickSubmitTarget(items) {
  const enabled = items.filter(i => i.visible && !i.disabled);
  const submitInputs = enabled.filter(i => i.type === 'submit');
  if (submitInputs.length) return submitInputs[0];
  const named = enabled.filter(i => (i.tag === 'button' || i.tag === 'input') && SUBMIT_TEXT_RE.test(`${i.text} ${i.name} ${i.id}`));
  return named[0] || null;
}

function elementKey(item) {
  if (!item) return '';
  return [item.tag, item.type, item.name, item.text].join('|');
}

function sameElement(a, b) {
  return Boolean(a) && Boolean(b) && elementKey(a) === elementKey(b);
}

// `target` is either a handle from the last web_find, or a descriptor to match:
// { text } / { role } / { name } / { tag } / { placeholder }. Exact match on an
// explicit name/id wins over a substring over visible text, which wins over a
// substring anywhere in the descriptor — the order a person would guess in.
function scoreMatch(item, target) {
  if (!item || !item.visible || item.disabled) return 0;
  let score = 0;
  const t = (target || {});
  if (t.name && item.name === t.name) score += 100;
  if (t.placeholder && item.placeholder && item.placeholder === t.placeholder) score += 90;
  if (t.tag && item.tag === t.tag) score += 5;
  if (t.role && item.role === t.role) score += 10;
  const needle = String(t.text || t.query || t.placeholder || t.label || '').trim().toLowerCase();
  if (needle) {
    const text = String(item.text || '').toLowerCase();
    if (text === needle) score += 60;
    else if (text.includes(needle)) score += 30;
    else {
      const hay = `${item.label} ${item.placeholder} ${item.name} ${item.id}`.toLowerCase();
      if (hay.includes(needle)) score += 12;
      else return 0;
    }
  }
  return score;
}

function findMatch(items, target) {
  let best = null;
  let bestScore = 0;
  items.forEach((item, index) => {
    const score = scoreMatch(item, target);
    if (score > bestScore) { bestScore = score; best = { item, index, score }; }
  });
  return best;
}

function shotName(now, url) {
  const host = (() => {
    try { return new URL(url).hostname.replace(/[^a-zA-Z0-9.-]/g, '_').slice(0, 40); }
    catch { return 'page'; }
  })();
  return `${now.replace(/[:.]/g, '-')}-${host || 'page'}.png`;
}

function pruneShots(dir, keep = MAX_SHOTS) {
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort(); } catch { return; }
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* best effort */ }
  }
}

// --------------------------------------------------------------- session state

const workDir = () => process.env.WORK_DIR || '';
const userId = () => process.env.USER_ID || '';

// Same file src/browser.js writes for the Playwright MCP server: one session per
// profile, readable by both stacks.
const statePath = () => (workDir() ? path.join(workDir(), 'playwright-storage-state.json') : '');
const shotsDir = () => (workDir() ? path.join(workDir(), 'web-ops') : '');

function readableState() {
  const file = statePath();
  if (!file || !fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return undefined;
    return parsed;
  } catch { return undefined; }
}

let session = null;      // { browser, context, page, idle }
let lastFind = null;     // { url, items }
let chain = Promise.resolve();

function serialize(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

function touch() {
  if (!session) return;
  clearTimeout(session.idle);
  session.idle = setTimeout(() => { closeSession().catch(() => {}); }, IDLE_CLOSE_MS);
  if (session.idle.unref) session.idle.unref();
}

async function saveState(target) {
  const file = statePath();
  const s = target || session;
  if (!file || !s) return;
  try {
    const tmp = `${file}.webops.tmp`;
    await s.context.storageState({ path: tmp });
    fs.renameSync(tmp, file);
  } catch { /* cookies are a cache, not a requirement */ }
}

async function closeSession() {
  const s = session;
  session = null;
  lastFind = null;
  if (!s) return;
  clearTimeout(s.idle);
  await saveState(s).catch(() => {});
  try { await s.context.close(); } catch { /* ignore */ }
  try { await s.browser.close(); } catch { /* ignore */ }
}

async function openSession() {
  if (session) { touch(); return session; }
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const storageState = readableState();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    locale: 'ru-RU',
    ...(storageState ? { storageState } : {}),
  });
  const page = await context.newPage();
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  session = { browser, context, page, idle: null };
  touch();
  return session;
}

async function currentPage() {
  const s = await openSession();
  if (s.page.isClosed()) s.page = await s.context.newPage();
  return s.page;
}

// ------------------------------------------------------------------- page ops

async function collectItems(page) {
  return page.evaluate((selector) => {
    /* eslint-disable no-undef -- this body is serialised into the page, not run in Node */
    const out = [];
    let index = 0;
    for (const el of document.querySelectorAll(selector)) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const visible = style.visibility !== 'hidden' && style.display !== 'none'
        && (rect.width > 0 || rect.height > 0);
      const text = (el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const labels = el.labels ? Array.from(el.labels) : [];
      out.push({
        handle: String(index++),
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute('type') || '').toLowerCase(),
        role: (el.getAttribute('role') || '').toLowerCase(),
        name: el.getAttribute('name') || el.id || '',
        id: el.id || '',
        text,
        label: labels.map(l => (l.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean)[0] || '',
        placeholder: el.getAttribute('placeholder') || '',
        href: (el.getAttribute('href') || '').slice(0, 200),
        visible,
        disabled: !!el.disabled,
      });
    }
    return out;
    /* eslint-enable no-undef */
  }, INTERACTIVE_SELECTOR);
}

async function readPage(page, maxChars = DEFAULT_TEXT_CHARS) {
  // eslint-disable-next-line no-undef -- runs in the page
  const raw = await page.evaluate(() => (document.body && document.body.innerText) || '');
  const items = await collectItems(page);
  const password = pickPasswordField(items);
  const clean = cleanText(raw, maxChars);
  const login = detectLoginRequired({
    hasPasswordField: Boolean(password),
    url: page.url(),
    text: clean.text,
  });
  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    text: clean.text,
    truncated: clean.truncated,
    totalChars: clean.totalChars,
    loginRequired: login.loginRequired,
    loginEvidence: login.reason,
    controls: items.filter(i => i.visible).length,
    forms: items.filter(i => i.tag === 'form' || i.type === 'submit').length,
  };
}

async function openUrl(url, { maxChars = DEFAULT_TEXT_CHARS } = {}) {
  const checked = checkUrl(url);
  if (!checked.ok) return { ok: false, error: checked.reason, url: String(url || '') };
  return serialize(async () => {
    const page = await currentPage();
    const response = await page.goto(checked.url, { waitUntil: 'domcontentloaded' }).catch(e => ({ error: e.message }));
    if (response && response.error) {
      return { ok: false, error: `navigation_failed: ${response.error}`, url: checked.url };
    }
    const view = await readPage(page, maxChars);
    lastFind = { url: view.url, items: await collectItems(page) };
    return {
      ok: true,
      status: response && typeof response.status === 'function' ? response.status() : null,
      ...view,
    };
  });
}

async function findOnPage({ query = '', limit = DEFAULT_FIND_LIMIT, includeHidden = false }) {
  return serialize(async () => {
    const page = await currentPage();
    const items = await collectItems(page);
    lastFind = { url: page.url(), items };
    const pool = includeHidden ? items : items.filter(i => i.visible);
    const matched = query
      ? pool.filter(i => {
        const hay = `${i.text} ${i.label} ${i.placeholder} ${i.name} ${i.id} ${i.href}`.toLowerCase();
        return hay.includes(String(query).toLowerCase());
      })
      : pool;
    return {
      ok: true,
      url: page.url(),
      title: await page.title().catch(() => ''),
      query,
      count: matched.length,
      items: matched.slice(0, Math.max(1, limit)).map(i => ({
        handle: i.handle, tag: i.tag, type: i.type, role: i.role, name: i.name,
        text: i.text, label: i.label, placeholder: i.placeholder, href: i.href,
      })),
      hint: matched.length ? 'Дальше передай handle в web_click или target в web_fill.' : 'Ничего не найдено — уточни запрос или используй web_open с другим URL.',
    };
  });
}

// A handle is honoured only while the element behind it is still the same element.
async function resolveTarget(page, target) {
  const previous = lastFind;
  const items = await collectItems(page);
  lastFind = { url: page.url(), items };
  const t = target || {};
  if (t.handle !== undefined && t.handle !== null && String(t.handle) !== '') {
    const idx = Number(t.handle);
    if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) {
      return { ok: false, error: 'unknown_handle', hint: 'Список контролов изменился — вызови web_find заново.' };
    }
    const current = items[idx];
    // The minting find ran on another page, or the node behind the index is a
    // different control now: a ref that moved must not be clicked blindly.
    if (previous && (previous.url !== page.url() || !sameElement(current, previous.items[idx]))) {
      return { ok: false, error: 'stale_handle', hint: 'Страница перерисовалась, handle больше не тот же элемент — вызови web_find заново.' };
    }
    return { ok: true, item: current, index: idx, items };
  }
  const match = findMatch(items, t);
  if (!match) return { ok: false, error: 'target_not_found', hint: 'Совпадений нет — вызови web_find с запросом и используй handle.' };
  return { ok: true, item: match.item, index: match.index, items };
}

async function clickTarget(target) {
  return serialize(async () => {
    const page = await currentPage();
    const resolved = await resolveTarget(page, target);
    if (!resolved.ok) return { ok: false, error: resolved.error, hint: resolved.hint };
    const locator = page.locator(INTERACTIVE_SELECTOR).nth(resolved.index);
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.click({ timeout: ACTION_TIMEOUT_MS });
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
    const view = await readPage(page, 1500);
    return {
      ok: true,
      clicked: { handle: resolved.item.handle, tag: resolved.item.tag, text: resolved.item.text, name: resolved.item.name },
      url: view.url, title: view.title, loginRequired: view.loginRequired,
      text: view.text,
    };
  });
}

async function fillFields({ fields = [], submit = false, confirmSubmit = false }) {
  if (!Array.isArray(fields) || !fields.length) {
    return { ok: false, error: 'no_fields', hint: 'Передай fields: [{ target, value }].' };
  }
  return serialize(async () => {
    const page = await currentPage();
    const filled = [];
    for (const field of fields) {
      const target = typeof field.target === 'string' ? { text: field.target } : (field.target || {});
      const resolved = await resolveTarget(page, target);
      if (!resolved.ok) { filled.push({ target: field.target, status: 'not_found' }); continue; }
      const locator = page.locator(INTERACTIVE_SELECTOR).nth(resolved.index);
      try {
        if (resolved.item.type === 'checkbox' || resolved.item.type === 'radio') {
          await locator.setChecked(Boolean(field.value), { timeout: ACTION_TIMEOUT_MS });
        } else if (resolved.item.tag === 'select') {
          await locator.selectOption(String(field.value), { timeout: ACTION_TIMEOUT_MS });
        } else {
          await locator.fill(String(field.value == null ? '' : field.value), { timeout: ACTION_TIMEOUT_MS });
        }
        filled.push({ target: field.target, status: 'filled', tag: resolved.item.tag, name: resolved.item.name });
      } catch (e) {
        filled.push({ target: field.target, status: 'failed', error: String(e.message || e).slice(0, 160) });
      }
    }
    const incomplete = filled.filter(f => f.status !== 'filled');
    if (!submit) {
      return { ok: incomplete.length === 0, filled, submitted: false, url: page.url(), title: await page.title().catch(() => '') };
    }
    // A half-filled form must not be sent: a submit with a missing field is an
    // outward action on wrong data, and the model cannot see which field it was.
    if (incomplete.length) {
      return {
        ok: false, error: 'fields_incomplete', filled, submitted: false,
        hint: 'Есть незаполненные поля — форма не отправлена. Уточни target (web_find) и повтори.',
        url: page.url(), title: await page.title().catch(() => ''),
      };
    }
    if (!confirmSubmit) {
      // A submit leaves the system. Fill first, report, and let the caller confirm.
      return {
        ok: false, error: 'confirm_submit_required', filled, submitted: false,
        hint: 'Поля заполнены. Отправка — действие наружу: повтори с submit:true, confirm_submit:true, если это точно нужно.',
        url: page.url(), title: await page.title().catch(() => ''),
      };
    }
    const items = await collectItems(page);
    const submitTarget = pickSubmitTarget(items);
    let submitted = false;
    if (submitTarget) {
      await page.locator(INTERACTIVE_SELECTOR).nth(items.indexOf(submitTarget)).click({ timeout: ACTION_TIMEOUT_MS });
      submitted = true;
    } else {
      const last = fields[fields.length - 1];
      const resolved = await resolveTarget(page, typeof last.target === 'string' ? { text: last.target } : (last.target || {}));
      if (resolved.ok) {
        await page.locator(INTERACTIVE_SELECTOR).nth(resolved.index).press('Enter');
        submitted = true;
      }
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
    const view = await readPage(page, 1500);
    return {
      ok: true, filled, submitted, submitFound: Boolean(submitTarget),
      url: view.url, title: view.title, loginRequired: view.loginRequired, text: view.text,
    };
  });
}

// Credentials live in the store, never in the model's context: the tool reads the
// file itself and reports only readiness.
async function loginWith({ serviceKey, url, submit = true }) {
  if (!serviceKey) return { ok: false, error: 'service_key_required', hint: 'Укажи service_key — ключ credential-формы.' };
  const creds = readCredentials(serviceKey);
  if (!creds) {
    return {
      ok: false, error: 'credentials_missing', serviceKey,
      hint: 'Ключа нет в хранилище. Вызови connect({ service }) или credentials_form_create и дай пользователю ссылку — пароль в чат не проси.',
    };
  }
  const opened = url ? await openUrl(url, { maxChars: 1200 }) : null;
  if (opened && opened.ok === false) return { ...opened, serviceKey };
  return serialize(async () => {
    const page = await currentPage();
    if (url && opened) { lastFind = { url: page.url(), items: await collectItems(page) }; }
    const items = await collectItems(page);
    const passwordField = pickPasswordField(items);
    const loginField = pickLoginField(items);
    if (!passwordField || !loginField) {
      return {
        ok: false, error: 'no_login_form', serviceKey, url: page.url(),
        hint: 'На странице нет формы входа. Проверь web_find: «password»/«войти» — возможно, нужен другой URL.',
      };
    }
    const at = (item) => items.indexOf(item);
    try {
      await page.locator(INTERACTIVE_SELECTOR).nth(at(loginField)).fill(creds.login, { timeout: ACTION_TIMEOUT_MS });
      await page.locator(INTERACTIVE_SELECTOR).nth(at(passwordField)).fill(creds.password, { timeout: ACTION_TIMEOUT_MS });
    } catch (e) {
      return { ok: false, error: `fill_failed: ${String(e.message || e).slice(0, 160)}`, serviceKey, url: page.url() };
    }
    if (!submit) {
      return { ok: true, submitted: false, authenticated: false, serviceKey, url: page.url(), title: await page.title().catch(() => ''), hint: 'Поля заполнены, отправка не запрошена.' };
    }
    const submitTarget = pickSubmitTarget(items);
    if (submitTarget) {
      await page.locator(INTERACTIVE_SELECTOR).nth(at(submitTarget)).click({ timeout: ACTION_TIMEOUT_MS }).catch(() => {});
    } else {
      await page.locator(INTERACTIVE_SELECTOR).nth(at(passwordField)).press('Enter').catch(() => {});
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 12_000 }).catch(() => {});
    await page.waitForTimeout(800);
    const after = await collectItems(page);
    const stillPassword = Boolean(pickPasswordField(after));
    const view = await readPage(page, 1200);
    const authenticated = !stillPassword && !view.loginRequired;
    await saveState();
    return {
      ok: true, submitted: true, authenticated, serviceKey,
      url: view.url, title: view.title,
      evidence: authenticated ? 'password_field_gone' : 'password_field_still_present',
      hint: authenticated ? 'Готово: сессия сохранена и будет видна браузеру пользователя.' : 'Похоже, вход не прошёл. Проверь текст страницы: чаще всего неверный логин/пароль или капча.',
      text: view.text,
    };
  });
}

async function pageState() {
  return serialize(async () => {
    if (!session) return { ok: true, open: false, hint: 'Браузер не запущен — открой страницу через web_open.' };
    const page = session.page;
    if (page.isClosed()) return { ok: true, open: false, hint: 'Вкладка закрыта.' };
    const view = await readPage(page, 800);
    return { ok: true, open: true, url: view.url, title: view.title, loginRequired: view.loginRequired, loginEvidence: view.loginEvidence, text: view.text };
  });
}

async function screenshot({ fullPage = false } = {}) {
  const dir = shotsDir();
  if (!dir) return { ok: false, error: 'no_work_dir', hint: 'Нет WORK_DIR — скриншот некуда сохранять.' };
  return serialize(async () => {
    const page = await currentPage();
    if (!page.url() || page.url() === 'about:blank') {
      return { ok: false, error: 'no_page', hint: 'Сначала web_open.' };
    }
    fs.mkdirSync(dir, { recursive: true });
    const name = shotName(new Date().toISOString(), page.url());
    const file = path.join(dir, name);
    await page.screenshot({ path: file, fullPage: Boolean(fullPage) });
    pruneShots(dir);
    return { ok: true, file, url: page.url(), hint: 'Путь можно передать в tg_send_file — пользователь увидит снимок.' };
  });
}

// ------------------------------------------------------------------ credentials

function credentialsFile(serviceKey) {
  const key = String(serviceKey || '').replace(/[^a-zA-Z0-9._-]/g, '');
  if (!key) return '';
  const base = process.env.AGENT_TOKENS_ROOT
    || path.join(process.env.HOME || '', 'agent-tokens');
  return path.join(base, userId() || '_', key);
}

// Two shapes live in the store: `<key>.json` (connect / credentials_form_create) and
// `<key>/config.json` (a few older services keep a directory). Try both, nothing else.
function credentialCandidates(serviceKey) {
  const file = credentialsFile(serviceKey);
  if (!file) return [];
  return file.endsWith('.json')
    ? [file]
    : [`${file}.json`, path.join(file, 'config.json')];
}

// Accepts the two shapes on disk: a ZeroCreds/connect payload ({email,password}) and
// the {creds:{...}} wrapper some connect forms write.
function readCredentials(serviceKey) {
  for (const file of credentialCandidates(serviceKey)) {
    if (!fs.existsSync(file)) continue;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const raw = (parsed && typeof parsed.creds === 'object' && parsed.creds) ? parsed.creds : parsed;
    if (!raw || typeof raw !== 'object') continue;
    const login = raw.email || raw.login || raw.username || raw.user || raw.phone;
    const password = raw.password || raw.pass || raw.secret;
    if (login && password) return { login: String(login), password: String(password) };
  }
  return null;
}

module.exports = {
  INTERACTIVE_SELECTOR,
  checkUrl,
  cleanText,
  detectLoginRequired,
  isSubmitLike,
  pickLoginField,
  pickPasswordField,
  pickSubmitTarget,
  elementKey,
  sameElement,
  scoreMatch,
  findMatch,
  shotName,
  readCredentials,
  credentialsFile,
  credentialCandidates,
  collectItems,
  readPage,
  openUrl,
  findOnPage,
  clickTarget,
  fillFields,
  loginWith,
  pageState,
  screenshot,
  closeSession,
  statePath,
  shotsDir,
  // internals kept for tests
  _reset() { session = null; lastFind = null; chain = Promise.resolve(); },
};
