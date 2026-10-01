'use strict';

// Перехват «иероглифов» в финальном ответе агента (src/answer-glyph-guard.js).
// Движок в тестах не запускается — запуск подменён, проверяем детект, откат на
// исходник и то, что «чистый» ответ вообще не трогает лестницу.

const test = require('node:test');
const assert = require('node:assert');

const {
  MIN_GLYPHS,
  countGlyphs,
  needsRewrite,
  resolveRungs,
  rewriteAnswer,
} = require('../src/answer-glyph-guard');

const USER = { username: 'tester', id: 'tester', workDir: '/tmp/glyph-guard-test' };
const DIRTY = 'Добавлю кнопку: после отправки она станет серый状态 на 15 секунд, чтобы не отправлять повторно.';
const CLEAN = 'Добавлю кнопку: после отправки она станет серой на 15 секунд, чтобы не отправлять повторно.';

test('countGlyphs: кириллица, эмодзи и пунктуация — чисто', () => {
  assert.equal(countGlyphs(CLEAN), 0);
  assert.equal(countGlyphs('Готово 🎉✅ — 15 сек, файлы в /home/vova'), 0);
  assert.equal(countGlyphs('中文'), 2);
  assert.equal(countGlyphs('fullwidth: ＡＢ'), 2);
  assert.equal(countGlyphs('한글'), 2);
});

test('needsRewrite: срабатывает от двух символов, не от одного', () => {
  assert.equal(needsRewrite(DIRTY), true);
  assert.equal(countGlyphs(DIRTY) >= MIN_GLYPHS, true);
  assert.equal(needsRewrite('один символ 状'), false);
  assert.equal(needsRewrite(''), false);
  assert.equal(needsRewrite(null), false);
});

test('чистый ответ не вызывает движок и возвращается как есть', async () => {
  const res = await rewriteAnswer({
    text: CLEAN,
    user: USER,
    engineRun: async () => { throw new Error('движок не должен запускаться'); },
  });
  assert.equal(res.action, 'clean');
  assert.equal(res.text, CLEAN);
});

test('иероглифы: ответ переписывается по лестнице, движок вызван один раз', async () => {
  const calls = [];
  const res = await rewriteAnswer({
    text: DIRTY,
    user: USER,
    profileName: 'value',
    engineRun: async ({ prompt, model }) => {
      calls.push({ model, prompt });
      return { claudeResult: CLEAN };
    },
  });
  assert.equal(res.action, 'rewritten');
  assert.equal(res.text, CLEAN);
  assert.equal(calls.length, 1);
  assert.match(calls[0].model, /\//);
  assert.ok(calls[0].prompt.includes(DIRTY));
});

test('неизвестный профиль → лестница value (дефолт), а не пустотой', () => {
  assert.deepEqual(resolveRungs('no-such-profile'), []);
  assert.ok(resolveRungs('value').length >= 1);
  assert.ok(resolveRungs('value').length <= 2);
});

test('fenced-ответ движка разворачивается (в Telegram ``` лишние)', async () => {
  const res = await rewriteAnswer({
    text: DIRTY,
    user: USER,
    profileName: 'value',
    engineRun: async () => ({ claudeResult: `\`\`\`\n${CLEAN}\n\`\`\`` }),
  });
  assert.equal(res.action, 'rewritten');
  assert.equal(res.text, CLEAN);
});

test('ответ с иероглифами → следующая ступень лестницы', async () => {
  const seen = [];
  const res = await rewriteAnswer({
    text: DIRTY,
    user: USER,
    profileName: 'value',
    engineRun: async ({ model }) => {
      seen.push(model);
      return { claudeResult: 'всё ещё 状态 мусор' };
    },
  });
  assert.equal(res.action, 'failed');
  assert.equal(res.text, DIRTY, 'исходник возвращается без изменений');
  assert.equal(res.error, 'still-glyphs');
  assert.equal(seen.length, 2, 'пробуем ровно две ступени, дальше не гонимся');
});

test('потеря содержания отбраковывается, пользователь получает исходник', async () => {
  const res = await rewriteAnswer({
    text: DIRTY,
    user: USER,
    profileName: 'value',
    engineRun: async () => ({ claudeResult: 'ок' }),
  });
  assert.equal(res.action, 'failed');
  assert.equal(res.error, 'lost-content');
  assert.equal(res.text, DIRTY);
});

test('движок упал → исходник, ошибка в логе, без исключения наверх', async () => {
  const res = await rewriteAnswer({
    text: DIRTY,
    user: USER,
    profileName: 'value',
    engineRun: async () => { throw new Error('spawn ENOENT opencode'); },
  });
  assert.equal(res.action, 'failed');
  assert.match(res.error, /ENOENT/);
  assert.equal(res.text, DIRTY);
});

test('аварийный выключатель ANSWER_GLYPH_GUARD=off не трогает ответ', async () => {
  const prev = process.env.ANSWER_GLYPH_GUARD;
  process.env.ANSWER_GLYPH_GUARD = 'off';
  try {
    const res = await rewriteAnswer({
      text: DIRTY,
      user: USER,
      profileName: 'value',
      engineRun: async () => { throw new Error('движок не должен запускаться'); },
    });
    assert.equal(res.action, 'off');
    assert.equal(res.text, DIRTY);
  } finally {
    if (prev === undefined) delete process.env.ANSWER_GLYPH_GUARD;
    else process.env.ANSWER_GLYPH_GUARD = prev;
  }
});

test('простыня длиннее лимита не переписывается вслепую', async () => {
  const huge = `${DIRTY}${'а'.repeat(9000)}`;
  const res = await rewriteAnswer({
    text: huge,
    user: USER,
    engineRun: async () => { throw new Error('движок не должен запускаться'); },
  });
  assert.equal(res.action, 'too-long');
  assert.equal(res.text, huge);
});

// ── Wiring: сам шов «раннер → перехватчик» (module-level функция раннера) ─────
function freshRunner() {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  process.env.AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'glyph-wiring-'));
  delete require.cache[require.resolve('../src/runner/index.js')];
  delete require.cache[require.resolve('../src/runner')];
  return require('../src/runner');
}

test('wiring: чистый ответ не трогаем вообще', async () => {
  const runner = freshRunner();
  const out = await runner._glyph.apply({
    result: CLEAN, user: USER, incomplete: false, internalGtd: false,
    engineRun: async () => { throw new Error('движок не должен запускаться'); },
  });
  assert.equal(out.text, CLEAN);
  assert.equal(out.guard, null);
});

test('wiring: грязный ответ переписывается, сбой двигается в исходник', async () => {
  const runner = freshRunner();
  const ok = await runner._glyph.apply({
    result: DIRTY, user: USER, profileName: 'value', incomplete: false, internalGtd: false,
    engineRun: async () => ({ claudeResult: CLEAN }),
  });
  assert.equal(ok.text, CLEAN);
  assert.equal(ok.guard.action, 'rewritten');

  const broken = await runner._glyph.apply({
    result: DIRTY, user: USER, profileName: 'value', incomplete: false, internalGtd: false,
    engineRun: async () => { throw new Error('spawn ENOENT'); },
  });
  assert.equal(broken.text, DIRTY, 'ответ пользователю не теряется');
  assert.equal(broken.guard.action, 'failed');
});

test('wiring: internalGtd и незавершённый ход не трогаем', async () => {
  const runner = freshRunner();
  const boom = async () => { throw new Error('движок не должен запускаться'); };
  const gtd = await runner._glyph.apply({ result: DIRTY, user: USER, incomplete: false, internalGtd: true, engineRun: boom });
  assert.equal(gtd.text, DIRTY);
  assert.equal(gtd.guard, null);
  const partial = await runner._glyph.apply({ result: DIRTY, user: USER, incomplete: true, internalGtd: false, engineRun: boom });
  assert.equal(partial.text, DIRTY);
  assert.equal(partial.guard, null);
});