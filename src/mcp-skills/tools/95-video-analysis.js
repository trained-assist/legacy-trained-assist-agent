'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Video Analysis — разбор/анализ длинных и многих видео (интервью, созвоны).
//
// Зачем в КОДЕ скила (а не в per-user скриптах transcribe.sh/analyze.sh): пайплайн
// должен быть один для всех сессий/юзеров и попадаться в MCP, чтобы любая будущая
// сессия применила «пачку видео → разбор» без переизобретения bash-обвязки.
//
// Пайплайн на каждое видео:
//   1) resolve — прямой href (в т.ч. публичные ссылки Яндекс.Диска)
//   2) ffmpeg -vn — ОТКЛЕИВАЕМ аудиодорожку (моно 16кГц opus). Видео = 95%+ веса
//      файла и 0% пользы для расшифровки; из сотен МБ получаем пару МБ →
//      аплоад в Deepgram падает с десятков секунд до пары. Это и есть ускорение
//      «многих/длинных видео».
//   3) Deepgram (nova-2) → транскрипт
//   4) чейн в interview_analyze (тот же движок, что и для готовых транскриптов) →
//      портрет / вопросы рекрутёру / чек-лист / взвешенный скоринг + вердикт
//
// Идемпотентно и резюмируемо: транскрипт и разбор пишутся ПОФАЙЛОВО в сессию юзера;
// повторный вызов скипает готовое (force переделывает). Так пачку из 15 видео можно
// доганивать по частям — рестарт/таймаут не теряет уже сделанное.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawn } = require('child_process');

const USER_ID = process.env.USER_ID || '';

function tokenBase() {
  return process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
}

// Постоянное хранилище ключа Deepgram (переживает сессии), по одному на юзера.
function keyDir() {
  const dir = path.join(tokenBase(), USER_ID, 'deepgram');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const KEY_FILE = () => path.join(keyDir(), 'key.txt');

function loadDeepgramKey() {
  if (process.env.DEEPGRAM_KEY) return process.env.DEEPGRAM_KEY.trim();
  try { return fs.readFileSync(KEY_FILE(), 'utf-8').trim(); } catch { return ''; }
}

// Видимая пользователю рабочая директория (~/users/<USER_ID>). Пишем сюда, а не в
// служебную agent-data — иначе транскрипты «пропадают» в невидимой юзеру папке
// (ровно тот баг, что ловили: инструмент отчитывался «получил транскрипты», но их
// не было там, где юзер их ждал). Корень — только через data-paths (USERS_DIR),
// тут раньше был неверный env AGENT_USERS_DIR (#1735 step 1).
function userWorkspace() {
  if (USER_ID) {
    const ws = require('../../data-paths').userWorkDir(USER_ID);
    try { if (fs.existsSync(ws)) return ws; } catch { /* ignore */ }
  }
  return '';
}

// Активный проект: runner ставит cwd = папке проекта (там project.json). Пишем
// транскрипты/разборы в проект, а не в корень профиля — иначе корень снова засоряется.
function activeProjectDir() {
  try {
    const cwd = process.cwd();
    if (fs.existsSync(path.join(cwd, 'project.json'))) return cwd;
  } catch { /* ignore */ }
  return '';
}

// Рабочая директория пайплайна — пофайловая, резюмируемая. Приоритет: явный out_dir
// → активный проект (projects/<id>/interviews) → видимый воркспейс профиля (легаси)
// → agent-data только как последний фолбэк (нет воркспейса).
function workDir(outDir) {
  let dir;
  if (outDir && String(outDir).trim()) {
    const o = String(outDir).trim();
    dir = path.isAbsolute(o) ? o : path.join(activeProjectDir() || userWorkspace() || process.cwd(), o);
  } else {
    const base = activeProjectDir() || userWorkspace();
    dir = base
      ? path.join(base, 'interviews')
      : path.join(require('../../data-paths').userWorkDir(USER_ID), 'video-analysis');
  }
  fs.mkdirSync(path.join(dir, 'transcripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
  return dir;
}

function slugName(name) {
  return String(name || 'video')
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'video';
}

// ── Durable batch ledger ─────────────────────────────────────────────────────
// ЗАЧЕМ: инцидент был не в потере работы (она пишется пофайлово и резюмируема),
// а в ОТЧЁТНОСТИ — агент в другой сессии заявил «папки пустые, 0 готовых, пайплайн
// оборвался», рассуждая из устаревшего контекста, а не с диска. Пустая audio/
// (аудио чистится после расшифровки — это норма) читалась как «ничего не сделано».
// Леджер даёт ЛЮБОЙ сессии durable-факт: сколько видео в пачке ожидалось, что из
// них готово, когда было последнее событие и завершена ли пачка. Отчёт → с диска.

function nowIso() {
  try { return new Date().toISOString(); } catch { return ''; }
}

const LEDGER_FILE = (dir) => path.join(dir, 'video-pipeline-ledger.json');

function readLedger(dir) {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_FILE(dir), 'utf-8'));
  } catch {
    return { version: 1, batches: [], items: {}, last_event: null, finished_at: null };
  }
}

function writeLedger(dir, led) {
  try { fs.writeFileSync(LEDGER_FILE(dir), JSON.stringify(led, null, 2), 'utf-8'); }
  catch { /* лог отчётности не должен ронять сам пайплайн */ }
}

// Зафиксировать старт пачки: ожидаемый состав (имена/slug'и) и время.
function recordBatchStart(dir, items) {
  const led = readLedger(dir);
  const at = nowIso();
  led.batches.push({ started_at: at, count: items.length, names: items.map(i => i.name) });
  led.finished_at = null; // новая пачка — снимаем терминальную метку
  for (const it of items) {
    const slug = slugName(it.name);
    if (!led.items[slug]) led.items[slug] = { name: it.name, slug, requested_at: at };
    else led.items[slug].requested_at = at;
  }
  led.last_event = { at, event: 'batch_start', count: items.length };
  writeLedger(dir, led);
}

// Обновить состояние одного видео (событие с меткой времени).
function recordItem(dir, slug, patch, event) {
  const led = readLedger(dir);
  const at = nowIso();
  led.items[slug] = Object.assign({ slug }, led.items[slug] || {}, patch, { updated_at: at });
  led.last_event = Object.assign({ at, event, slug }, patch.error ? { error: patch.error } : {});
  writeLedger(dir, led);
}

// Терминальная метка пачки — «дошли до конца цикла», не зависит от контекста сессии.
function recordBatchDone(dir, summary) {
  const led = readLedger(dir);
  const at = nowIso();
  led.finished_at = at;
  led.last_event = Object.assign({ at, event: 'batch_done' }, summary || {});
  writeLedger(dir, led);
}

// ── Яндекс.Диск: публичная ссылка → прямой href ──────────────────────────────

function resolveYandex(publicUrl) {
  return new Promise((resolve) => {
    const api = 'https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=' +
      encodeURIComponent(publicUrl);
    https.get(api, { timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data).href || ''); } catch { resolve(''); }
      });
    }).on('error', () => resolve('')).on('timeout', function () { this.destroy(); resolve(''); });
  });
}

async function resolveSource(source) {
  const s = String(source || '').trim();
  if (/yadi\.sk|disk\.yandex/i.test(s)) {
    const href = await resolveYandex(s);
    return href || s;
  }
  return s; // локальный путь или прямой http(s)-URL — ffmpeg читает и то, и то
}

// ── ffmpeg: отклеиваем аудио (моно 16кГц opus) ───────────────────────────────

function extractAudio(input, outPath) {
  return new Promise((resolve, reject) => {
    // -vn: без видео. opus @24k моно 16кГц — крошечный, Deepgram ест ogg/opus.
    const args = ['-y', '-loglevel', 'error', '-i', input,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '24k', outPath];
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', c => { err += c; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) resolve(outPath);
      else reject(new Error(`ffmpeg failed (code ${code}): ${err.slice(0, 300)}`));
    });
  });
}

// ── Deepgram (pre-recorded) ──────────────────────────────────────────────────

function deepgramTranscribe(key, audioBuf, language) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({
      model: 'nova-2',
      smart_format: 'true',
      punctuate: 'true',
      paragraphs: 'true',
    });
    if (language && language !== 'auto') qs.set('language', language);
    else qs.set('detect_language', 'true');
    const req = https.request({
      hostname: 'api.deepgram.com',
      path: `/v1/listen?${qs.toString()}`,
      method: 'POST',
      headers: {
        Authorization: `Token ${key}`,
        'Content-Type': 'audio/ogg',
        'Content-Length': audioBuf.length,
      },
      timeout: 300000,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const d = JSON.parse(data);
          const alt = d?.results?.channels?.[0]?.alternatives?.[0];
          const text = String(alt?.paragraphs?.transcript || alt?.transcript || '').trim();
          if (!text) return reject(new Error('Deepgram вернул пустой транскрипт (тишина/не распознано) — не кэшируем, повтор перепробует'));
          resolve(text);
        } catch { reject(new Error(`Deepgram parse error: ${data.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Deepgram timeout')); });
    req.write(audioBuf);
    req.end();
  });
}

// Тот же движок разбора, что и для готовых транскриптов — не переизобретаем.
// interview_analyze lives in trained-assist-hh-skill (#1470); resolved lazily through the
// sibling bridge so a missing checkout only fails the analysis step, not this server.
const interviewAnalyze = (...args) =>
  require('../../domains/sibling-lib').siblingLib('hh', 'src/mcp-skills/tools/99-interview-analysis.js')
    .tools.interview_analyze.handler(...args);

// Нормализация входа: строка / список строк / список {name, source|url|path}.
function normalizeVideos(videos) {
  const arr = Array.isArray(videos) ? videos : [videos];
  return arr.map((v, i) => {
    if (typeof v === 'string') return { name: `video-${i + 1}`, source: v };
    const source = v.source || v.url || v.path || v.href || '';
    const name = v.name || v.candidate_name || v.title || `video-${i + 1}`;
    return { name, source };
  }).filter(v => v.source);
}

// ── Tools ────────────────────────────────────────────────────────────────────

module.exports = {
  isReady: () => true,
  // set-ключ виден всегда, даже пока ключ не задан — чтобы можно было настроить.
  setupTools: ['video_set_deepgram_key', 'video_analysis_status'],

  tools: {
    video_set_deepgram_key: {
      description:
        'Сохранить API-ключ Deepgram для расшифровки видео/аудио (нужен для video_analyze_batch). ' +
        'Задаётся один раз, переживает сессии. Ключ хранится только на сервере (файл в директории юзера), ' +
        'не в коде и не в ответах.',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Deepgram API key (токен).' } },
        required: ['key'],
      },
      handler: async ({ key }) => {
        if (!key || !key.trim()) throw new Error('key пустой');
        fs.writeFileSync(KEY_FILE(), key.trim(), 'utf-8');
        return { saved: true, path: KEY_FILE(), hint: 'Ключ сохранён. Теперь video_analyze_batch может расшифровывать.' };
      },
    },

    video_analysis_status: {
      description:
        'АВТОРИТЕТНОЕ состояние пайплайна разбора видео — читается С ДИСКА, не из памяти. Показывает по каждому ' +
        'видео: расшифровано ли, разобрано ли, скоринг/вердикт; сколько ожидалось в пачке (из леджера), что ' +
        'осталось, завершена ли пачка и когда было последнее событие. ВСЕГДА вызывай это перед тем, как ' +
        'отчитаться пользователю о прогрессе разбора видео — отчитывайся по этому ответу, а НЕ по своему ' +
        'контексту (пустая папка audio/ = норма, аудио чистится после расшифровки, это НЕ «работа потеряна»).',
      inputSchema: { type: 'object', properties: { out_dir: { type: 'string', description: 'Опц.: та же папка, что передавалась в video_analyze_batch (для проверки конкретного каталога).' } } },
      handler: async ({ out_dir } = {}) => {
        const dir = workDir(out_dir);
        const tdir = path.join(dir, 'transcripts');
        const adir = path.join(dir, 'analysis');
        const audioDir = path.join(dir, 'audio');

        // 1) Факты С ДИСКА — источник истины.
        const txtFiles = fs.existsSync(tdir) ? fs.readdirSync(tdir).filter(f => f.endsWith('.txt')) : [];
        const jsonFiles = fs.existsSync(adir) ? fs.readdirSync(adir).filter(f => f.endsWith('.analysis.json')) : [];
        const audioLeftover = fs.existsSync(audioDir) ? fs.readdirSync(audioDir).filter(f => !f.startsWith('.')) : [];

        const transcribed = new Set(txtFiles.map(f => f.replace(/\.txt$/, '')));
        const analyzed = new Map(); // slug → {score, max, rec}
        for (const f of jsonFiles) {
          const slug = f.replace(/\.analysis\.json$/, '');
          let meta = {};
          try {
            const d = JSON.parse(fs.readFileSync(path.join(adir, f), 'utf-8'));
            meta = { total_score: d.total_score, max_score: d.max_score, recommendation: d.recommendation };
          } catch { /* битый json — всё равно считаем разобранным по факту файла */ }
          analyzed.set(slug, meta);
        }

        // 2) Ожидаемый состав пачки — из леджера (durable, переживает сессии).
        const led = readLedger(dir);
        const ledgerSlugs = Object.keys(led.items || {});
        const expected = ledgerSlugs.length
          ? ledgerSlugs
          : Array.from(new Set([...transcribed, ...analyzed.keys()]));

        // 3) Пофайловая сводка + что осталось.
        const items = expected.map((slug) => {
          const li = (led.items && led.items[slug]) || {};
          const a = analyzed.get(slug) || null;
          return {
            name: li.name || slug,
            slug,
            transcribed: transcribed.has(slug),
            analyzed: analyzed.has(slug),
            total_score: a ? a.total_score : undefined,
            max_score: a ? a.max_score : undefined,
            recommendation: a ? a.recommendation : undefined,
            error: li.error || undefined,
          };
        }).sort((x, y) => x.slug.localeCompare(y.slug, 'ru'));

        const outstanding = items.filter(i => !i.transcribed || !i.analyzed)
          .map(i => ({ name: i.name, needs: !i.transcribed ? 'transcribe+analyze' : 'analyze' }));
        const complete = expected.length > 0 && outstanding.length === 0;

        // 4) Готовый к пересказу текст — чтобы агент отчитался по нему дословно.
        const parts = [
          `Разбор видео: ${transcribed.size}/${expected.length} расшифровано, ${analyzed.size}/${expected.length} проанализировано.`,
        ];
        if (complete) parts.push('Пачка завершена — всё готово.');
        else if (outstanding.length) parts.push(`Осталось: ${outstanding.map(o => `${o.name} (${o.needs})`).join(', ')}.`);
        if (led.finished_at) parts.push(`Последнее завершение пачки: ${led.finished_at}.`);
        else if (led.last_event) parts.push(`Последнее событие: ${led.last_event.event} @ ${led.last_event.at}.`);
        parts.push('Папка audio/ пустая — это норма (аудио удаляется после расшифровки), НЕ признак потери работы.');

        return {
          deepgram_key_set: !!loadDeepgramKey(),
          ffmpeg: true,
          complete,
          expected_total: expected.length,
          transcripts_done: transcribed.size,
          analyses_done: analyzed.size,
          outstanding,
          items,
          last_event: led.last_event,
          batch_finished_at: led.finished_at,
          audio_leftover: audioLeftover,
          work_dir: dir,
          has_ledger: ledgerSlugs.length > 0,
          summary: parts.join(' '),
          note: 'Это состояние прочитано С ДИСКА. Отчитывайся пользователю по нему, не по своей памяти. ' +
            'Пустая audio/ — норма (аудио чистится после расшифровки), не «потеря работы».' +
            (ledgerSlugs.length ? '' : ' Леджер пачки отсутствует (эти файлы могли быть сделаны прежним пайплайном) — expected_total выведен из файлов на диске.'),
          hint: loadDeepgramKey() ? undefined : 'Ключ Deepgram не задан — вызови video_set_deepgram_key(key).',
        };
      },
    },

    video_analyze_batch: {
      description:
        'Разбор/анализ длинных и многих видео (интервью, созвоны) одним вызовом: для каждого видео ' +
        'отклеивает аудио (ffmpeg -vn, ускоряет в разы), расшифровывает через Deepgram и сразу прогоняет ' +
        'через interview_analyze (портрет / вопросы рекрутёру / чек-лист / взвешенный скоринг + вердикт по ' +
        'критериям заказчика из interview_set_criteria). Идемпотентно и резюмируемо пофайлово — пачку можно ' +
        'доганивать по частям, повтор скипает готовое. Вызывай, когда пользователь даёт видео/ссылки на ' +
        'записи интервью и просит их разобрать/оценить. Требует ключ Deepgram (video_set_deepgram_key).',
      inputSchema: {
        type: 'object',
        properties: {
          videos: {
            description: 'Видео: путь/URL строкой, список строк, или список объектов {name, source} ' +
              '(source = локальный путь, прямой http(s)-URL или публичная ссылка Яндекс.Диска).',
            type: ['array', 'string'],
          },
          criteria: { type: 'string', description: 'Опц.: критерии заказчика на эту пачку. Если не задано — берутся сохранённые (interview_set_criteria).' },
          language: { type: 'string', description: 'Опц.: язык расшифровки (ru/en/…) или "auto" для авто-детекта. Дефолт ru.' },
          model: { type: 'string', description: 'Опц.: модель OpenRouter для разбора. Дефолт google/gemini-2.5-flash.' },
          max_items: { type: 'number', description: 'Опц.: обработать не больше N новых видео за вызов (для очень больших пачек). Дефолт без лимита.' },
          out_dir: { type: 'string', description: 'Опц.: куда складывать транскрипты/разборы. По умолчанию видимая папка юзера ~/users/<id>/interviews (transcripts/ + analysis/). Относительный путь — от рабочей директории юзера.' },
          transcribe_only: { type: 'boolean', description: 'Опц.: только расшифровать, без анализа.' },
          force: { type: 'boolean', description: 'Опц.: перерасшифровать/переоценить, даже если результат уже есть.' },
        },
        required: ['videos'],
      },
      handler: async ({ videos, criteria, language, model, max_items, out_dir, transcribe_only, force }) => {
        const key = loadDeepgramKey();
        if (!key) {
          return {
            error: 'deepgram_key_missing',
            hint: 'Ключ Deepgram не задан. Вызови video_set_deepgram_key(key) и повтори.',
          };
        }
        const items = normalizeVideos(videos);
        if (!items.length) throw new Error('videos пустой — нет ни одного источника');

        const dir = workDir(out_dir);
        // Разборы кладём рядом с транскриптами — в подпапку analysis/ той же видимой
        // директории (совпадает с per-user раскладкой interviews/analysis).
        const analysisDir = path.join(dir, 'analysis');
        const results = [];
        let processed = 0;

        // Durable-леджер: фиксируем ожидаемый состав пачки ДО обработки, чтобы любая
        // будущая сессия знала, сколько видео ожидалось, даже если эта прервётся.
        recordBatchStart(dir, items);

        for (const item of items) {
          const slug = slugName(item.name);
          const txtPath = path.join(dir, 'transcripts', `${slug}.txt`);
          const r = { name: item.name, slug };

          try {
            // 1) Транскрипт — резюмируемость: готовый переиспользуем.
            let transcript;
            if (!force && fs.existsSync(txtPath) && fs.statSync(txtPath).size > 0) {
              transcript = fs.readFileSync(txtPath, 'utf-8');
              r.transcribed = 'cached';
            } else {
              if (max_items && processed >= max_items) { r.skipped = 'max_items reached'; results.push(r); continue; }
              const src = await resolveSource(item.source);
              const audioPath = path.join(dir, 'audio', `${slug}.ogg`);
              await extractAudio(src, audioPath);
              const audioBuf = fs.readFileSync(audioPath);
              r.audio_bytes = audioBuf.length;
              transcript = await deepgramTranscribe(key, audioBuf, language || 'ru');
              fs.writeFileSync(txtPath, transcript, 'utf-8');
              fs.unlinkSync(audioPath); // аудио — промежуточное, чистим
              r.transcribed = 'ok';
              processed++;
              recordItem(dir, slug, { name: item.name, transcript_chars: transcript.length, transcribed_at: nowIso(), error: null }, 'transcribed');
            }
            r.transcript_chars = transcript.length;
            r.transcript_path = txtPath;

            // 2) Анализ (если не transcribe_only) — тот же движок, идемпотентный.
            if (!transcribe_only) {
              const a = await interviewAnalyze({
                transcript, candidate_name: item.name, criteria, model, out_dir: analysisDir, force,
              });
              r.analyzed = a.cached ? 'cached' : 'ok';
              r.total_score = a.total_score ?? a.analysis?.total_score;
              r.max_score = a.max_score ?? a.analysis?.max_score;
              r.recommendation = a.recommendation ?? a.analysis?.recommendation;
              r.analysis_md_path = a.md_path;
              recordItem(dir, slug, {
                name: item.name, analyzed_at: nowIso(),
                total_score: r.total_score, max_score: r.max_score, recommendation: r.recommendation, error: null,
              }, 'analyzed');
            }
          } catch (e) {
            r.error = String(e.message || e);
            recordItem(dir, slug, { name: item.name, error: r.error }, 'error');
          }
          results.push(r);
        }

        const ok = results.filter(x => !x.error).length;
        // Терминальная метка пачки на диске — durable-факт «дошли до конца цикла».
        recordBatchDone(dir, { total: items.length, succeeded: ok, failed: results.length - ok, new_transcriptions: processed });
        return {
          total: items.length,
          succeeded: ok,
          failed: results.length - ok,
          new_transcriptions: processed,
          results,
          work_dir: dir,
          hint: 'Транскрипты и разборы сохранены пофайлово + записан durable-леджер. ' +
            'Прогресс проверяй/отчитывай через video_analysis_status (читает с диска), а не по памяти — ' +
            'повторный вызов доганит незавершённое.',
        };
      },
    },
  },
};
