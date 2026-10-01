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
  resolveRung,
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
    profileName: 'deepseek',
    engineRun: async ({ prompt, model }) => {
      calls.push({ model, prompt });
      return { claudeResult: CLEAN };
    },
  });
  assert.equal(res.action, 'rewritten');
  assert.equal(res.text, CLEAN);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'ladder/deepseek:general');
  assert.ok(calls[0].prompt.includes(DIRTY));
});

test('адрес переписывания — роль general стандартной лестницы профиля', () => {
  assert.equal(resolveRung('deepseek'), 'ladder/deepseek:general');
  assert.equal(resolveRung('free'), 'ladder/free:general');
  assert.equal(resolveRung('value'), 'ladder/deepseek:general'); // value → deepseek (PR #1687)
  // Неизвестный профиль не даёт «лестницу не найдена»: worker сам уводит в дефолт.
  assert.equal(resolveRung('no-such-profile'), 'ladder/deepseek:general');
  assert.equal(resolveRung(''), 'ladder/deepseek:general');
});

test('fenced-ответ движка разворачивается (в Telegram ``` лишние)', async () => {
  const res = await rewriteAnswer({
    text: DIRTY,
    user: USER,
    profileName: 'deepseek',
    engineRun: async () => ({ claudeResult: `\`\`\`\n${CLEAN}\n\`\`\`` }),
  });
  assert.equal(res.action, 'rewritten');
  assert.equal(res.text, CLEAN);
});

test('модель не вычистила иероглифы → исходник, без второй попытки', async () => {
  const seen = [];
  const res = await rewriteAnswer({
    text: DIRTY,
    user: USER,
    profileName: 'deepseek',
    engineRun: async ({ model }) => {
      seen.push(model);
      return { claudeResult: 'всё ещё 状态 мусор' };
    },
  });
  assert.equal(res.action, 'failed');
  assert.equal(res.text, DIRTY, 'исходник возвращается без изменений');
  assert.equal(res.error, 'still-glyphs');
  // Одна попытка: повтор того же адреса лестницы повторил бы тот же вызов —
  // вся деградация по ступеням живёт на worker'е (llm-ladder).
  assert.equal(seen.length, 1);
});

test('потеря содержания отбраковывается, пользователь получает исходник', async () => {
  const res = await rewriteAnswer({
    text: DIRTY,
    user: USER,
    profileName: 'deepseek',
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
    profileName: 'deepseek',
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
      profileName: 'deepseek',
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
// Каталог данных — ОДИН на файл и убирается в after(). Раньше тут был
// mkdtempSync в os.tmpdir() на каждый вызов: боевой агент периодически обходит
// свой tmp и находил эти каталоги (живой случай 2026-10-01 — «Permission denied»
// в логе прод-сервиса от чужого теста). Не повторять: тестовые каталоги либо
// не в tmp агента, либо удаляются за собой.
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const PATH = require('node:path');

const dataDir = mkdtempSync(PATH.join(tmpdir(), 'glyph-guard-data-'));

function freshRunner() {
  process.env.AGENT_DATA_DIR = dataDir;
  delete require.cache[require.resolve('../src/runner/index.js')];
  delete require.cache[require.resolve('../src/runner')];
  return require('../src/runner');
}

test.after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* нечего убирать */ } });

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
    result: DIRTY, user: USER, profileName: 'deepseek', incomplete: false, internalGtd: false,
    engineRun: async () => ({ claudeResult: CLEAN }),
  });
  assert.equal(ok.text, CLEAN);
  assert.equal(ok.guard.action, 'rewritten');

  const broken = await runner._glyph.apply({
    result: DIRTY, user: USER, profileName: 'deepseek', incomplete: false, internalGtd: false,
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