// Closure intent (#1856): «Стоп» vs «собери итог» vs обычная задача.
//
// Инцидент 29.09: после «Стоп» владелец написал «ты нашел уже всё» / «хватит, ты уже
// всё нашёл». Это ушло обычным deep-раном, и модель искала ещё 11+ минут. А смысл
// реплики был другой: «поиск закончен, собери ответ из уже найденного за пару минут».
// Поэтому у закрывающей реплики ТРИ исхода:
//   • stop    — «стоп / хватит, не надо / отмена» → работы нет, одна строка ответа,
//               GTD/продолжения этого диалога сняты;
//   • wrap_up — «ты уже всё нашёл / достаточно, давай итог / хватит искать / собери
//               что есть» → ран в режиме финализации (без новых поисков, жёсткий потолок);
//   • task    — всё остальное, в т.ч. «хватит искать X, найди Y».
//
// Здесь только дешёвая детерминированная проверка ЯВНЫХ случаев. Неоднозначные
// разбирает LLM-судья intake (src/intake-gate.js). null = «явного случая нет» —
// вызывающий ведёт себя как раньше (никогда не превращаем неуверенность в stop).

// Последнее сообщение пачки: шлюз склеивает буфер в «[Сообщение 1] …\n[Сообщение 2] …».
// Классифицируем последнюю реплику — она и выражает текущее намерение.
function latestMessage(text) {
  const raw = String(text || '');
  const parts = raw.split(/\[Сообщение \d+\]/).map(s => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : raw.trim();
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[’`]/g, "'")
    .replace(/[^a-zа-я0-9'\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Явные «поиск закончен, собери итог». Матчи ВЫРЕЗАЮТСЯ из текста, а остаток
// проверяется на новую просьбу: «хватит искать вакансии, найди резюме» → task.
const WRAP_UP_PATTERNS = [
  // «ты нашел уже всё», «ты уже всё нашёл», «уже всё нашёл», «всё уже собрал»
  /(?:^|\s)(?:ты\s+)?(?:уже\s+)?(?:все|всего|достаточно)\s+(?:уже\s+)?(?:нашел|нашла|нашли|собрал|собрала|нарыл|нарыла|раскопал)(?=\s|$)/g,
  /(?:^|\s)(?:ты\s+)?(?:уже\s+)?(?:нашел|нашла|нашли|собрал|собрала|нарыл|нарыла|раскопал)\s+(?:уже\s+)?(?:все|всего|достаточно)(?:\s+что\s+(?:нужно|надо|можно))?(?=\s|$)/g,
  // «хватит искать / хватит поиска / хорош искать / заканчивай поиск»
  /(?:^|\s)(?:хватит|хорош|довольно|достаточно|прекращай|прекрати|заканчивай|закончи|останови|кончай)\s+(?:уже\s+)?(?:искать|поиск|поиски|поиска|копать|рыть|исследовать|ресерч|рисерч)(?=\s|$)/g,
  // «давай итог», «подведи итоги», «дай результат», «пиши вывод», «выдай что есть»
  /(?:^|\s)(?:давай|дай|выдай|подведи|подводи|пиши|напиши|сформулируй|оформи|покажи|присылай|пришли|скинь)\s+(?:уже\s+)?(?:мне\s+)?(?:итог|итоги|итоговый\s+ответ|результат|результаты|вывод|выводы|ответ|что\s+есть|что\s+(?:уже\s+)?нашел|что\s+(?:уже\s+)?собрал|то\s+что\s+(?:уже\s+)?(?:есть|нашел|собрал))(?=\s|$)/g,
  // «собери что есть», «собери итог», «суммируй найденное», «подытожь»
  /(?:^|\s)(?:собери|собирай|суммируй|резюмируй|обобщи)\s+(?:уже\s+)?(?:все\s+)?(?:что\s+(?:уже\s+)?(?:есть|нашел|собрал|найдено)|итог|итоги|найденное|результат|результаты)(?=\s|$)/g,
  /(?:^|\s)(?:подытожь|подытоживай|закругляйся|сворачивайся|итожь)(?=\s|$)/g,
  // EN
  /(?:^|\s)you(?:'ve|\s+have)?\s+(?:already\s+)?found\s+(?:it\s+all|everything|enough)(?=\s|$)/g,
  /(?:^|\s)(?:stop|quit|enough)\s+(?:searching|looking|digging|research(?:ing)?)(?=\s|$)/g,
  /(?:^|\s)(?:wrap\s+(?:it\s+)?up|summari[sz]e\s+what\s+you\s+(?:have|found|got)|give\s+me\s+(?:the\s+)?(?:summary|results?|bottom\s+line)|just\s+summari[sz]e)(?=\s|$)/g,
];

// Слова-связки и «разрешение закончить», которые остаются после вырезания wrap-up
// и сами по себе новой просьбы не несут.
const FILLER = new Set([
  'хватит', 'достаточно', 'довольно', 'все', 'уже', 'ты', 'и', 'а', 'ну', 'так', 'вот', 'же',
  'давай', 'ладно', 'ок', 'окей', 'хорошо', 'спасибо', 'пожалуйста', 'плиз', 'короче',
  'по', 'тому', 'этому', 'из', 'того', 'что', 'есть', 'нашел', 'собрал', 'найдено', 'уже',
  'коротко', 'кратко', 'быстро', 'сейчас', 'теперь', 'мне', 'тут', 'здесь', 'хорош',
  'stop', 'ok', 'okay', 'thanks', 'please', 'enough', 'now', 'just', 'so', 'and', 'already',
]);

// Слова «стопа». Реплика — stop, только если состоит ЦЕЛИКОМ из них и в ней есть
// хотя бы один явный триггер. «нет» один не стоп — это ответ на вопрос.
const STOP_TRIGGERS = /(?:^|\s)(?:стоп|stop|отмена|отмени|отменяй|отменить|cancel|остановись|остановиться|прекрати|прекращай|хватит|не\s+надо|не\s+нужно|забей|nevermind|never\s+mind|don't|dont|abort)(?=\s|$)/;
const STOP_WORDS = new Set([
  'стоп', 'stop', 'отмена', 'отмени', 'отменяй', 'отменить', 'cancel', 'остановись', 'остановиться',
  'прекрати', 'прекращай', 'хватит', 'не', 'надо', 'нужно', 'больше', 'ничего', 'делать', 'все',
  'пожалуйста', 'ладно', 'ок', 'окей', 'спасибо', 'нет', 'забей', 'забудь', 'это', 'пока', 'тогда',
  'уже', 'ну', 'так', 'дальше', 'продолжай', 'продолжать', 'задачу', 'задача', 'ищи', 'искать',
  'nevermind', 'never', 'mind', "don't", 'dont', 'please', 'ok', 'okay', 'no', 'need', 'abort',
  'it', 'that', 'thanks', 'continue', 'more', 'anymore',
]);

// Новая просьба в остатке → это задача, а не закрытие.
const NEW_TASK = /(?:^|\s)(?:найди|найти|поищи|ищи|искать|проверь|посмотри|глянь|сделай|напиши|составь|пришли|скинь|покажи|открой|запусти|добавь|удали|отправь|создай|опубликуй|переведи|сравни|посчитай|узнай|выясни|вытащи|скачай|прочитай|прочти|проанализируй|разбери|изучи|подготовь|оцени|find|search|look|check|make|write|send|show|open|create|build|add)(?=\s|$)/;

const MAX_CLOSURE_CHARS = 160;
const MAX_WRAP_LEFTOVER_WORDS = 3;

// → 'stop' | 'wrap_up' | 'task' | null
//   'task' — явная новая просьба рядом с закрывающим словом («хватит искать X, найди Y»).
//   null   — явных признаков нет: решает судья / текущее поведение.
function classifyClosure(text) {
  const latest = latestMessage(text);
  if (!latest || latest.length > MAX_CLOSURE_CHARS || latest.includes('\n')) return null;
  const norm = normalize(latest);
  if (!norm) return null;

  let rest = ` ${norm} `;
  let wrapHit = false;
  for (const re of WRAP_UP_PATTERNS) {
    re.lastIndex = 0;
    const next = rest.replace(re, ' ');
    if (next !== rest) { wrapHit = true; rest = next; }
  }
  rest = rest.replace(/\s+/g, ' ').trim();
  if (wrapHit) {
    if (NEW_TASK.test(rest)) return 'task';
    const leftovers = rest ? rest.split(' ').filter(w => !FILLER.has(w)) : [];
    // Короткий «хвост» — объект того, что уже искали («хватит искать вакансии»,
    // «ты уже всё нашёл про Иванова»), а не новая просьба.
    return leftovers.length <= MAX_WRAP_LEFTOVER_WORDS ? 'wrap_up' : null;
  }

  if (STOP_TRIGGERS.test(norm)) {
    const words = norm.split(' ');
    if (words.every(w => STOP_WORDS.has(w))) return 'stop';
    if (NEW_TASK.test(norm)) return 'task';
  }
  return null;
}

// Всегда один из трёх исходов: явный случай или 'task' по умолчанию.
function closureVerdict(text) {
  return classifyClosure(text) || 'task';
}

// ── Мост «судья intake → runner» ──────────────────────────────────────────────
// Вердикт wrap_up от LLM-судьи (неоднозначная фраза, которую regex не поймал)
// должен дойти до рана, а шлюз передаёт в /run только текст. Запоминаем вердикт
// в памяти по (профиль, чат, топик, нормализованная последняя реплика) на 15 мин;
// runner забирает его одноразово. Нет записи (рестарт, другой текст) → обычная
// задача, т.е. текущее поведение.
const HINT_TTL_MS = 15 * 60_000;
const hints = new Map();

function hintKey({ username, chatId, threadId, text }) {
  const norm = normalize(latestMessage(text));
  if (!username || chatId == null || !norm) return null;
  const thread = Number.isInteger(threadId) && threadId > 0 ? threadId : '';
  return `${username}|${chatId}|${thread}|${norm}`;
}

function rememberClosure({ username, chatId, threadId, text, closure, now = Date.now() }) {
  const key = hintKey({ username, chatId, threadId, text });
  if (!key || (closure !== 'wrap_up' && closure !== 'stop')) return false;
  for (const [k, v] of hints) if (now - v.at > HINT_TTL_MS) hints.delete(k);
  hints.set(key, { closure, at: now });
  return true;
}

function recallClosure({ username, chatId, threadId, text, now = Date.now() }) {
  const key = hintKey({ username, chatId, threadId, text });
  if (!key) return null;
  const rec = hints.get(key);
  if (!rec) return null;
  hints.delete(key);
  return now - rec.at <= HINT_TTL_MS ? rec.closure : null;
}

module.exports = {
  classifyClosure, closureVerdict, latestMessage, normalize,
  rememberClosure, recallClosure, _hints: hints,
};
