'use strict';

// web-ops (src/web-ops.js) — the browser methods ordinary work runs on.
//
// No browser is launched here: every check is on the pure layer (URL guard, text
// clean-up, login detection, field picking, target matching, credential reading) and
// on the module contract in tools/24-web-ops.js. A live Chromium smoke is opt-in via
// WEBOPS_LIVE=1 and is never part of CI.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ops = require('../src/web-ops');

const item = (over = {}) => ({
  handle: '0', tag: 'input', type: 'text', role: '', name: '', id: '',
  text: '', label: '', placeholder: '', href: '', visible: true, disabled: false, ...over,
});

test('checkUrl: только http/https, остальное — отказ с причиной', () => {
  assert.equal(ops.checkUrl('https://example.com/a?b=1').ok, true);
  assert.equal(ops.checkUrl('http://example.com').ok, true);
  assert.equal(ops.checkUrl('file:///etc/passwd').reason, 'protocol_not_allowed: file:');
  assert.equal(ops.checkUrl('data:text/html,<b>x').reason, 'protocol_not_allowed: data:');
  assert.equal(ops.checkUrl('chrome://settings').reason, 'protocol_not_allowed: chrome:');
  assert.equal(ops.checkUrl('не ссылка').reason, 'unparseable_url');
  assert.equal(ops.checkUrl('').reason, 'empty_url');
  assert.equal(ops.checkUrl(undefined).reason, 'empty_url');
});

test('cleanText: схлопывает мусор, режет по лимиту и честно говорит про обрезку', () => {
  const messy = '  Заголовок   страницы \n\n\n\n   Текст   с   пробелами  \n\n';
  const out = ops.cleanText(messy, 500);
  assert.equal(out.text, 'Заголовок страницы\n\nТекст с пробелами');
  assert.equal(out.truncated, false);

  const long = ops.cleanText('я'.repeat(500), 100);
  assert.equal(long.truncated, true);
  assert.equal(long.totalChars, 500);
  assert.ok(long.text.startsWith('я'.repeat(100)));
  assert.ok(long.text.includes('всего 500 символов'));
});

test('detectLoginRequired: поле пароля, адрес входа или текст — но не обычная страница', () => {
  assert.deepEqual(ops.detectLoginRequired({ hasPasswordField: true }), { loginRequired: true, reason: 'password_field' });
  assert.equal(ops.detectLoginRequired({ url: 'https://site.ru/login' }).loginRequired, true);
  assert.equal(ops.detectLoginRequired({ url: 'https://site.ru/auth/callback' }).loginRequired, true);
  assert.equal(ops.detectLoginRequired({ text: 'Введите логин и пароль для входа' }).loginRequired, true);
  assert.equal(ops.detectLoginRequired({ text: 'Каталог товаров — 240 позиций' }).loginRequired, false);
  assert.equal(ops.detectLoginRequired({ text: 'Войти в личный кабинет' }).loginRequired, false, 'одного слова «войти» мало — нужен пароль');
});

test('pickLoginField: именованное поле важнее первого, служебные поля пропускаются', () => {
  const items = [
    item({ tag: 'input', type: 'checkbox', name: 'agree', handle: '0' }),
    item({ tag: 'input', type: 'text', name: 'search', placeholder: 'Поиск', handle: '1' }),
    item({ tag: 'input', type: 'text', name: 'email', placeholder: 'Почта', handle: '2' }),
    item({ tag: 'input', type: 'password', name: 'pass', handle: '3' }),
  ];
  assert.equal(ops.pickLoginField(items).name, 'email');
  assert.equal(ops.pickLoginField([item({ type: 'text' }), item({ type: 'text', visible: false, handle: '1' })]).handle, '0');
  assert.equal(ops.pickLoginField([item({ tag: 'button', type: 'submit', text: 'Войти' })]), null);
});

test('pickPasswordField: только видимое неотключённое поле пароля', () => {
  assert.equal(ops.pickPasswordField([item({ tag: 'div' }), item({ type: 'password', name: 'p1' })]).name, 'p1');
  assert.equal(ops.pickPasswordField([item({ type: 'password', visible: false })]), null);
  assert.equal(ops.pickPasswordField([item({ type: 'password', disabled: true })]), null);
  assert.equal(ops.pickPasswordField([item({ type: 'text' })]), null);
});

test('pickSubmitTarget: сначала type=submit, потом кнопка по смыслу, иначе null', () => {
  assert.equal(ops.pickSubmitTarget([
    item({ tag: 'button', type: '', text: 'Войти', handle: '0' }),
    item({ tag: 'input', type: 'submit', name: 'go', handle: '1' }),
  ]).name, 'go');
  assert.equal(ops.pickSubmitTarget([item({ tag: 'button', text: 'Войти' })]).text, 'Войти');
  assert.equal(ops.pickSubmitTarget([item({ tag: 'button', text: 'Отмена' })]), null);
  assert.equal(ops.pickSubmitTarget([item({ tag: 'button', type: 'submit', visible: false })]), null);
});

test('sameElement: подпись handle проверяет, что за ним тот же элемент', () => {
  const a = item({ handle: '4', tag: 'button', name: 'go', text: 'Войти' });
  assert.equal(ops.sameElement(a, { ...a }), true);
  assert.equal(ops.sameElement(a, { ...a, text: 'Выйти' }), false);
  assert.equal(ops.sameElement(a, { ...a, tag: 'a' }), false);
  assert.equal(ops.sameElement(a, null), false);
});

test('scoreMatch/findMatch: точное совпадение текста > подстрока, скрытое не матчится', () => {
  const items = [
    item({ handle: '0', tag: 'a', text: 'Войти в кабинет' }),
    item({ handle: '1', tag: 'button', text: 'Войти' }),
    item({ handle: '2', tag: 'button', text: 'Войти', visible: false }),
  ];
  assert.equal(ops.findMatch(items, { text: 'Войти' }).index, 1);
  assert.equal(ops.findMatch(items, { text: 'войти' }).index, 1, 'регистр не должен ломать поиск');
  assert.equal(ops.findMatch(items, { text: 'Войти в' }).index, 0);
  assert.equal(ops.findMatch(items, { text: 'Отправить' }), null);
  assert.equal(ops.scoreMatch(items[2], { text: 'Войти' }), 0, 'скрытый элемент не должен находиться');
  assert.ok(ops.scoreMatch(items[0], { name: '' }) === 0, 'пустой target ничего не выбирает');
  const byName = [item({ handle: '0', name: 'send', text: 'Отправить' }), item({ handle: '1', name: 'x', text: 'Отправить письмо' })];
  assert.equal(ops.findMatch(byName, { name: 'send' }).index, 0);
  // Цель по placeholder/подписи — тоже рабочий способ указать поле.
  const byPlaceholder = [
    item({ handle: '0', placeholder: 'Поиск по заявкам' }),
    item({ handle: '1', placeholder: 'Комментарий' }),
  ];
  assert.equal(ops.findMatch(byPlaceholder, { placeholder: 'Комментарий' }).index, 1);
  assert.equal(ops.findMatch(byPlaceholder, { label: 'Поиск по заявкам' }).index, 0);
  assert.equal(ops.findMatch(byPlaceholder, { placeholder: 'Нет такого' }), null);
});

test('shotName: имя файла без путей и спецсимволов домена', () => {
  const name = ops.shotName('2026-10-02T01:02:03.456Z', 'https://shop.example.com/cart?x=1');
  assert.equal(name, '2026-10-02T01-02-03-456Z-shop.example.com.png');
  assert.ok(!name.includes('/'));
  assert.equal(ops.shotName('2026-10-02T01:02:03.456Z', 'не url').endsWith('-page.png'), true);
});

test('readCredentials: читает обе формы файла, наружу — только логин/пароль для инструмента', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webops-creds-'));
  const prevRoot = process.env.AGENT_TOKENS_ROOT;
  const prevUser = process.env.USER_ID;
  process.env.AGENT_TOKENS_ROOT = dir;
  process.env.USER_ID = 'u1';
  try {
    assert.equal(ops.readCredentials('missing-site'), null);

    fs.mkdirSync(path.join(dir, 'u1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'u1', 'site-a.json'), JSON.stringify({ email: 'a@b.c', password: 'pw' }));
    assert.deepEqual(ops.readCredentials('site-a'), { login: 'a@b.c', password: 'pw' });

    fs.writeFileSync(path.join(dir, 'u1', 'site-b.json'), JSON.stringify({ creds: { login: 'u', password: 'p2' } }));
    assert.deepEqual(ops.readCredentials('site-b'), { login: 'u', password: 'p2' });

    fs.writeFileSync(path.join(dir, 'u1', 'site-c.json'), JSON.stringify({ email: 'a@b.c' }));
    assert.equal(ops.readCredentials('site-c'), null, 'логин без пароля — это не готовые креды');

    fs.writeFileSync(path.join(dir, 'u1', 'broken.json'), '{{{');
    assert.equal(ops.readCredentials('broken'), null);

    fs.mkdirSync(path.join(dir, 'u1', 'site-d'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'u1', 'site-d', 'config.json'), JSON.stringify({ login: 'd', password: 'pd' }));
    assert.deepEqual(ops.readCredentials('site-d'), { login: 'd', password: 'pd' }, 'каталог <key>/config.json тоже читается');

    // Ключ из аргументов не может выйти за пределы каталога пользователя.
    const escaped = ops.credentialsFile('../../etc/passwd');
    assert.ok(escaped.startsWith(path.join(dir, 'u1')), escaped);
  } finally {
    if (prevRoot === undefined) delete process.env.AGENT_TOKENS_ROOT; else process.env.AGENT_TOKENS_ROOT = prevRoot;
    if (prevUser === undefined) delete process.env.USER_ID; else process.env.USER_ID = prevUser;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('инструменты web_* зарегистрированы и описаны (контракт tools/24-web-ops.js)', () => {
  const mod = require('../src/mcp-skills/tools/24-web-ops');
  const names = Object.keys(mod.tools).sort();
  assert.deepEqual(names, ['web_click', 'web_fill', 'web_find', 'web_login', 'web_open', 'web_screenshot', 'web_state']);
  for (const [name, tool] of Object.entries(mod.tools)) {
    assert.ok(tool.description && tool.description.length > 40, `${name}: описание должно объяснять, когда применять`);
    assert.equal(typeof tool.handler, 'function', name);
    assert.equal(tool.inputSchema.type, 'object', name);
  }
  const registry = require('../src/mcp-skills/registry');
  const def = registry.listAllTools().find(d => d.name === 'web_open');
  assert.ok(def, 'web_open не попал в статический каталог');
  assert.equal(def.module, '24-web-ops.js');
});

test('живой Chromium — только по WEBOPS_LIVE=1 (в CI не запускается)', async (t) => {
  if (process.env.WEBOPS_LIVE !== '1') return t.skip('WEBOPS_LIVE не задан');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webops-live-'));
  const prev = { work: process.env.WORK_DIR, user: process.env.USER_ID };
  process.env.WORK_DIR = dir;
  process.env.USER_ID = 'live';
  try {
    const opened = await ops.openUrl('data:text/html,<h1>нет</h1>');
    assert.equal(opened.ok, false, 'data: должен быть отвергнут до запуска браузера');
    const found = await ops.findOnPage({ query: 'нет' });
    assert.equal(found.ok, true);
    await ops.closeSession();
  } finally {
    if (prev.work === undefined) delete process.env.WORK_DIR; else process.env.WORK_DIR = prev.work;
    if (prev.user === undefined) delete process.env.USER_ID; else process.env.USER_ID = prev.user;
    await ops.closeSession();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
