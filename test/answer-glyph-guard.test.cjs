'use strict';

// Перехват «иероглифов» в финальном ответе агента (src/answer-glyph-guard.js).
// Движок в тестах не запускается — запуск подменён, проверяем детект, откат на
// исходник и то, что «чистый» ответ вообще не трогает лестницу.

const test = require('node:test');
const assert = require('node:assert');

const {
  MIN_GLYPHS,
  MIN_REPLACEMENTS,
  countGlyphs,
  countReplacements,
  needsRewrite,
  resolveRung,
  rewriteAnswer,
} = require('../src/answer-glyph-guard');

const USER = { username: 'tester', id: 'tester', workDir: '/tmp/glyph-guard-test' };
const DIRTY = 'Добавлю кнопку: после отправки она станет серый状态 на 15 секунд, чтобы не отправлять повторно.';
const CLEAN = 'Добавлю кнопку: после отправки она станет серой на 15 секунд, чтобы не отправлять повторно.';
// Живой случай владельца 2026-10-01: «резерв��ением» вместо «резервацией».
// Это U+FFFD REPLACEMENT CHARACTER, а не иероглиф: старый GLYPH_RE его не видел
// (полноширинные формы кончаются на U+FFEF) и ответ уходил пользователю как есть.
const BROKEN = 'Сделаю резерва��ию по счёту на 15 минут, чтобы не списалось дважды.';
const BROKEN_FIXED = 'Сделаю резервацию по счёту на 15 минут, чтобы не списалось дважды.';

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

test('знак замены U+FFFD: живой случай «резерв��ением» теперь ловится', () => {
  // Раньше: countGlyphs=0, needsRewrite=false — мусор уходил пользователю.
  assert.equal(countReplacements(BROKEN), 2);
  assert.equal(needsRewrite(BROKEN), true);
  // Порог 1, а не 2: одиночный U+FFFD в обычном тексте — тоже мусор декодирования
  // (в отличие от иероглифа, который может быть цитатой).
  assert.equal(countReplacements('резерв�ацией'), 1);
  assert.equal(needsRewrite('резерв�ацией'), true);
  assert.equal(MIN_REPLACEMENTS, 1);
  // Кириллица/эмодзи по-прежнему чистые.
  assert.equal(countReplacements(CLEAN), 0);
  assert.equal(countReplacements('Готово 🎉✅ — 15 сек'), 0);
});

test('кодовые блоки и `скобки` из детекта вырезаны: иллюстрация не дёргает переписывание', () => {
  // Разбор про сам «значок вопроса в ромбике» не должен переписывать себя.
  assert.equal(needsRewrite('Символ � означает битые байты.'), true, 'в прозе — мусор');
  assert.equal(needsRewrite('Символ `�` означает битые байты.'), false, 'в `скобках` — иллюстрация');
  assert.equal(needsRewrite('Пример:\n```\nрезерв��ия\n```\nконец'), false, 'в кодовом блоке — пример');
  assert.equal(needsRewrite('японская строка `状態` в примере'), false, 'CJK в `скобках` — тоже пример');
  assert.equal(needsRewrite('японская строка 状態 в прозе'), true, 'CJK в прозе — мусор');
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
    profileName: 'service',
    engineRun: async ({ prompt, model }) => {
      calls.push({ model, prompt });
      return { claudeResult: CLEAN };
    },
  });
  assert.equal(res.action, 'rewritten');
  assert.equal(res.text, CLEAN);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'ladder/service:general');
  assert.ok(calls[0].prompt.includes(DIRTY));
});

test('адрес переписывания — роль general стандартной лестницы профиля', () => {
  assert.equal(resolveRung('service'), 'ladder/service:general');
  assert.equal(resolveRung('free'), 'ladder/free:general');
  assert.equal(resolveRung('value'), 'ladder/service:general'); // value → service (ladder rename, llm-ladder #49/#101)
  // Неизвестный профиль не даёт «лестницу не найдена»: worker сам уводит в дефолт.
  assert.equal(resolveRung('no-such-profile'), 'ladder/service:general');
  assert.equal(resolveRung(''), 'ladder/service:general');
});

test('знак замены: ответ переписывается, промпт просит восстановить слово', async () => {
  const calls = [];
  const res = await rewriteAnswer({
    text: BROKEN,
    user: USER,
    profileName: 'service',
    engineRun: async ({ prompt, model }) => {
      calls.push({ model, prompt });
      return { claudeResult: BROKEN_FIXED };
    },
  });
  assert.equal(res.action, 'rewritten');
  assert.equal(res.text, BROKEN_FIXED);
  assert.equal(res.glyphs, 0);
  assert.equal(res.replacements, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'ladder/service:general');
  assert.ok(calls[0].prompt.includes(BROKEN), 'в промпт уходит исходный текст');
  assert.ok(calls[0].prompt.includes('U+FFFD'), 'промпт объясняет модели, что это знак замены');
  assert.ok(/восстанов/i.test(calls[0].prompt), 'промпт требует восстановить слово по контексту');
});

test('модель оставила U+FFFD → исходник, без второй попытки', async () => {
  const seen = [];
  const res = await rewriteAnswer({
    text: BROKEN,
    user: USER,
    profileName: 'service',
    engineRun: async ({ model }) => {
      seen.push(model);
      return { claudeResult: 'Сделаю резерв��ию по счёту.' };
    },
  });
  assert.equal(res.action, 'failed');
  assert.equal(res.error, 'still-replacements');
  assert.equal(res.text, BROKEN, 'исходник возвращается без изменений');
  assert.equal(seen.length, 1);
});

test('модель вычистила U+FFFD, но оставила иероглиф → тоже исходник', async () => {
  const res = await rewriteAnswer({
    text: BROKEN,
    user: USER,
    profileName: 'service',
    engineRun: async () => ({ claudeResult: 'Сделаю 状態 по счёту на 15 минут.' }),
  });
  assert.equal(res.action, 'failed');
  assert.equal(res.error, 'still-glyphs');
  assert.equal(res.text, BROKEN);
});

test('чистый текст со знаком замены внутри `скобок` движок не вызывает', async () => {
  const text = 'Символ `�` — это U+FFFD, он означает битые байты.';
  const res = await rewriteAnswer({
    text,
    user: USER,
    engineRun: async () => { throw new Error('движок не должен запускаться'); },
  });
  assert.equal(res.action, 'clean');
  assert.equal(res.text, text);
});

test('fenced-ответ движка разворачивается (в Telegram ``` лишние)', async () => {
  const res = await rewriteAnswer({
    text: DIRTY,
    user: USER,
    profileName: 'service',
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
    profileName: 'service',
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
    profileName: 'service',
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
    profileName: 'service',
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
      profileName: 'service',
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
    result: DIRTY, user: USER, profileName: 'service', incomplete: false, internalGtd: false,
    engineRun: async () => ({ claudeResult: CLEAN }),
  });
  assert.equal(ok.text, CLEAN);
  assert.equal(ok.guard.action, 'rewritten');

  const broken = await runner._glyph.apply({
    result: DIRTY, user: USER, profileName: 'service', incomplete: false, internalGtd: false,
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

test('wiring: «резерв��ением» доходит до переписывания через раннер (живой случай)', async () => {
  const runner = freshRunner();
  const out = await runner._glyph.apply({
    result: BROKEN, user: USER, profileName: 'service', incomplete: false, internalGtd: false,
    engineRun: async () => ({ claudeResult: BROKEN_FIXED }),
  });
  assert.equal(out.text, BROKEN_FIXED);
  assert.equal(out.guard.action, 'rewritten');
  assert.equal(out.guard.replacements, 2);
});