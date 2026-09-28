#!/usr/bin/env node
// Sandbox Ф0 «speech_transcribe» — исполнимая форма сценария
// docs/user-scenarios/speech/01-speech-transcribe.md (шаги 0–4).
//
// Зачем: замкнуть цикл «изменил → увидел результат» без человека. Одна команда:
//
//     npm run sandbox:speech
//
// Уровень автономности: S5 — агент сам поднимает окружение и гоняет сценарий
// end-to-end локально, внешние зависимости — фейк: loopback-заглушка Deepgram
// (DEEPGRAM_API_HOST), никакой сети и никакого ключа. Реальный аудиофайл + реальный
// ключ остаются живым смоуком на хосте (сикл-репо, scripts/speech-smoke.cjs).
// Целевое время цикла: ≤60 с (фактически секунды).
//
// Что проверяет (сценарий → проверка):
//   C1  скил-репозиторий подключён (SPEECH_SKILL_DIR || sibling рядом с ядром)
//   C2  статическая форма скила: scripts/check-skill-contract.js
//   C3  MCP-граница вживую (реальный stdio JSON-RPC сервер скила) — шаги 0–2 сценария:
//         tools/list содержит speech_transcribe/_set_key/_status;
//         speech_set_key → файл ключа 0o600 по ожидаемому пути;
//         speech_status → key_present:true;
//         speech_transcribe(локальный файл) → {text,duration,language,cost_hint},
//           в запросе к Deepgram model=nova-2 + smart_format=true + language=ru,
//           полей segments/speakers нет;
//         diarize:true → feature_disabled (не молчаливый no-op);
//         .mp4 → unsupported_source; и source=URL → временный файл удалён (finally).
//   C4  регистрация сиблинга в ядре — 6 точек §2.6 (skill-siblings, skill-catalog,
//       deploy.sh, ci.yml ×2, playbook-store, tests/skill-contract.test.js)
//   C5  ядро больше не знает, КАК распознавать: в 95-video-analysis.js нет
//       deepgramTranscribe/loadDeepgramKey/keyDir, есть делегирование и легаси-алиас.
//   C6  приёмка сценария: пара «аудио↔транскрипт» по правилу mtime + нормализация +
//       similarity ≥ 0.9 (и метрика отсекает несовпадающий текст — не «зелёный всегда»).
//
// Контракты, которые песочница пинит для реализации (срезы S1–S5):
//   • DEEPGRAM_API_HOST — полный origin: значение по умолчанию `https://api.deepgram.com`,
//     для заглушки — `http://127.0.0.1:<port>`. Схема берётся из значения.
//   • Типизированные ошибки — JSON `{error, hint}` в text-содержимом tools/call.
//   • Скил использует os.tmpdir() (песочница изолирует временные файлы через TMPDIR).
//   • Видео-контейнер определяется по расширению (unsupported_source), не по магии.
//
// Пока срезы S1–S5 не сделаны, песочница обязана быть КРАСНОЙ по этим причинам.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { startMcpServer } = require('../../packages/mcp-skill-testkit/lib/start-mcp-server.js');

const CORE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SPEECH_REPO = 'trained-assist-speech-skill';

const results = [];
function check(id, name, fn) {
  try {
    const r = fn();
    if (r === true || r === undefined) results.push({ id, name, ok: true });
    else if (r && r.ok === false) results.push({ id, name, ok: false, reason: r.reason });
    else results.push({ id, name, ok: true, note: r && r.note });
  } catch (e) {
    results.push({ id, name, ok: false, reason: `${e.name}: ${e.message}` });
  }
}
function fail(id, name, reason) { results.push({ id, name, ok: false, reason }); }
function pass(id, name, note) { results.push({ id, name, ok: true, note }); }

// ── C1: где лежит скил ────────────────────────────────────────────────────────
function resolveSkillDir() {
  if (process.env.SPEECH_SKILL_DIR) return process.env.SPEECH_SKILL_DIR;
  // Повторяем резолвинг ядра (src/skill-siblings.js): сиблинг лежит рядом с ядром.
  const siblingNextToCore = path.join(CORE_ROOT, '..', SPEECH_REPO);
  if (fs.existsSync(siblingNextToCore)) return siblingNextToCore;
  return siblingNextToCore;
}
const SKILL_DIR = resolveSkillDir();
const SKILL_ENTRY = path.join(SKILL_DIR, 'src', 'mcp-skills', 'index.js');

// ── seed: фикстуры и детерминированное время ──────────────────────────────────
const CANONICAL = 'привет это тестовое голосовое сообщение для песочницы';
const DEEPGRAM_MUTATED = 'Привет!  Это тестовое голосовое сообщение, для песочницы.';
const UNRELATED = 'совершенно другой текст про погоду и кошек';
const OGG_BYTES = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(256, 7)]);

const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-f0-'));
const intakeDir = path.join(seed, 'intake');
const tokensRoot = path.join(seed, 'tokens');
const sandboxTmp = path.join(seed, 'tmp');
fs.mkdirSync(intakeDir, { recursive: true });
fs.mkdirSync(tokensRoot, { recursive: true });
fs.mkdirSync(sandboxTmp, { recursive: true });

const A_LATEST = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-audio.ogg';
const A_OLD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-audio.ogg';
const A_AFTER = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc-audio.ogg';
const T_REF = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd-transcript-1.txt';
const VIDEO = path.join(intakeDir, 'clip.mp4');
const BASE_T = Date.now() / 1000 - 600;
function seedFile(name, bytes, mtimeSec) {
  const p = path.join(intakeDir, name);
  fs.writeFileSync(p, bytes);
  fs.utimesSync(p, mtimeSec, mtimeSec);
  return p;
}
seedFile(A_OLD, OGG_BYTES, BASE_T - 30);
seedFile(A_LATEST, OGG_BYTES, BASE_T - 0.3);
seedFile(A_AFTER, OGG_BYTES, BASE_T + 5);
seedFile(T_REF, CANONICAL + '\n', BASE_T);
fs.writeFileSync(VIDEO, Buffer.from('0000'), 'utf8');

// ── Deepgram loopback-заглушка ────────────────────────────────────────────────
function startDeepgramStub() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'POST' && req.url.startsWith('/v1/listen')) {
      req.resume();
      const body = JSON.stringify({
        metadata: { duration: 312.4, channels: 1 },
        results: {
          channels: [{
            alternatives: [{
              transcript: DEEPGRAM_MUTATED,
              paragraphs: { transcript: DEEPGRAM_MUTATED },
            }],
          }],
        },
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    if (req.url.startsWith('/fixture.ogg')) {
      res.writeHead(200, { 'content-type': 'audio/ogg' });
      res.end(OGG_BYTES);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });
}

// ── метрика приёмки (нормализация + similarity), C6 ───────────────────────────
function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function similarity(a, b) {
  const ta = normalize(a).split(' ').filter(Boolean);
  const tb = normalize(b).split(' ').filter(Boolean);
  if (!ta.length || !tb.length) return 0;
  const counts = new Map();
  for (const t of ta) counts.set(t, (counts.get(t) || 0) + 1);
  let common = 0;
  for (const t of tb) {
    const n = counts.get(t) || 0;
    if (n > 0) { common += 1; counts.set(t, n - 1); }
  }
  return (2 * common) / (ta.length + tb.length);
}
// Правило пары из сценария §Шаг 4: аудио с наибольшим mtime ≤ mtime транскрипта.
function pickPair(dir) {
  const entries = fs.readdirSync(dir).map((f) => ({
    f,
    mtime: fs.statSync(path.join(dir, f)).mtimeMs / 1000,
  }));
  const transcripts = entries.filter((e) => e.f.includes('-transcript-'));
  const audios = entries.filter((e) => e.f.includes('-audio.'));
  if (!transcripts.length) return { error: 'в intake нет файла -transcript-' };
  if (!audios.length) return { error: 'в intake нет файла -audio.' };
  const t = transcripts.slice().sort((a, b) => a.mtime - b.mtime)[0];
  const before = audios.filter((a) => a.mtime <= t.mtime);
  if (!before.length) return { error: `нет аудио с mtime ≤ mtime транскрипта (${t.f})` };
  const a = before.slice().sort((x, y) => y.mtime - x.mtime)[0];
  return { audio: a.f, transcript: t.f, deltaSec: Number((t.mtime - a.mtime).toFixed(3)) };
}

// ── MCP-хелперы ───────────────────────────────────────────────────────────────
async function callTool(server, name, args) {
  const res = await server.call('tools/call', { name, arguments: args || {} });
  const text = (res?.content || []).filter((c) => c && c.type === 'text').map((c) => c.text).join('');
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { text, parsed, isError: !!res?.isError };
}

async function runMcpSteps(stub) {
  const server = await startMcpServer({
    entrypoint: SKILL_ENTRY,
    env: {
      AGENT_TOKENS_DIR: tokensRoot,
      USER_ID: 'sandbox-user',
      DEEPGRAM_API_HOST: `http://127.0.0.1:${stub.port}`,
      TMPDIR: sandboxTmp,
    },
    timeoutMs: 20000,
  });
  try {
    // tools/list
    const listed = await server.call('tools/list', {});
    const names = (listed?.tools || []).map((t) => t.name);
    const wanted = ['speech_transcribe', 'speech_set_key', 'speech_status'];
    const missing = wanted.filter((w) => !names.includes(w));
    if (missing.length) fail('C3a', 'tools/list содержит speech_transcribe/_set_key/_status',
      `нет инструментов: ${missing.join(', ')} (есть: ${names.join(', ') || '—'})`);
    else pass('C3a', 'tools/list содержит speech_transcribe/_set_key/_status', names.join(', '));

    // speech_set_key → файл 0o600
    const setKey = await callTool(server, 'speech_set_key', { key: 'dg-sandbox-key' });
    const keyPath = path.join(tokensRoot, 'sandbox-user', 'deepgram', 'key.txt');
    if (!fs.existsSync(keyPath)) {
      fail('C3b', 'speech_set_key пишет ключ по ожидаемому пути',
        `нет файла ${keyPath}; ответ: ${setKey.text.slice(0, 200)}`);
    } else {
      const mode = fs.statSync(keyPath).mode & 0o777;
      const nonEmpty = fs.statSync(keyPath).size > 0;
      if (!nonEmpty) fail('C3b', 'speech_set_key пишет ключ по ожидаемому пути', 'файл ключа пуст');
      else if (mode !== 0o600) fail('C3b', 'speech_set_key пишет ключ по ожидаемому пути', `mode=0${mode.toString(8)}, ожидали 0600`);
      else pass('C3b', 'speech_set_key пишет ключ по ожидаемому пути (0o600)');
    }

    // speech_status
    const status = await callTool(server, 'speech_status', {});
    if (status.parsed && status.parsed.key_present === true) pass('C3c', 'speech_status → key_present:true');
    else fail('C3c', 'speech_status → key_present:true', `ответ: ${status.text.slice(0, 200)}`);

    // speech_transcribe локальный файл
    const audioPath = path.join(intakeDir, A_LATEST);
    const tr = await callTool(server, 'speech_transcribe', { source: audioPath, language: 'ru' });
    const t = tr.parsed || {};
    const schemaOk = typeof t.text === 'string' && t.text.trim()
      && typeof t.duration === 'number'
      && t.language === 'ru'
      && t.cost_hint && typeof t.cost_hint === 'object';
    if (!schemaOk) {
      fail('C3d', 'speech_transcribe(локальный файл) → {text,duration,language,cost_hint}',
        `ответ: ${tr.text.slice(0, 300)}`);
    } else if ('segments' in t || 'speakers' in t) {
      fail('C3d', 'speech_transcribe(локальный файл) → {text,duration,language,cost_hint}',
        'в Ф0 не должно быть полей segments/speakers');
    } else {
      pass('C3d', 'speech_transcribe(локальный файл) → {text,duration,language,cost_hint}');
    }

    // параметры запроса к Deepgram
    const dgReq = stub.requests.find((u) => u.includes('/v1/listen')) || '';
    const q = (() => { try { return new URL('http://x' + dgReq.slice(dgReq.indexOf('/'))).searchParams; } catch { return new URLSearchParams(); } })();
    const want = { model: 'nova-2', smart_format: 'true', language: 'ru' };
    const bad = Object.entries(want).filter(([k, v]) => q.get(k) !== v);
    if (!dgReq) fail('C3e', 'запрос к Deepgram несёт model=nova-2&smart_format=true&language=ru', 'заглушка не получила запрос');
    else if (bad.length) fail('C3e', 'запрос к Deepgram несёт model=nova-2&smart_format=true&language=ru',
      `отличается: ${bad.map(([k]) => `${k}=${q.get(k)}`).join(', ')} (url: ${dgReq.slice(0, 200)})`);
    else pass('C3e', 'запрос к Deepgram несёт model=nova-2&smart_format=true&language=ru');

    // diarize → feature_disabled
    const dz = await callTool(server, 'speech_transcribe', { source: audioPath, diarize: true });
    if (dz.parsed && dz.parsed.error === 'feature_disabled') pass('C3f', 'diarize:true → feature_disabled');
    else fail('C3f', 'diarize:true → feature_disabled', `ответ: ${dz.text.slice(0, 200)}`);

    // видео-контейнер → unsupported_source
    const vid = await callTool(server, 'speech_transcribe', { source: VIDEO });
    if (vid.parsed && vid.parsed.error === 'unsupported_source') pass('C3g', '.mp4 → unsupported_source');
    else fail('C3g', '.mp4 → unsupported_source', `ответ: ${vid.text.slice(0, 200)}`);

    // URL → tmp-файл удалён
    const url = await callTool(server, 'speech_transcribe', { source: `http://127.0.0.1:${stub.port}/fixture.ogg` });
    const leftovers = fs.readdirSync(sandboxTmp);
    if (!url.parsed || typeof url.parsed.text !== 'string') {
      fail('C3h', 'source=URL скачан, tmp-файл удалён (finally)', `ответ: ${url.text.slice(0, 200)}`);
    } else if (leftovers.length) {
      fail('C3h', 'source=URL скачан, tmp-файл удалён (finally)', `в TMPDIR остались файлы: ${leftovers.join(', ')}`);
    } else {
      pass('C3h', 'source=URL скачан, tmp-файл удалён (finally)');
    }
  } finally {
    await server.stop();
  }
}

// ── C4: точки регистрации в ядре ─────────────────────────────────────────────
function readCore(rel) { return fs.readFileSync(path.join(CORE_ROOT, rel), 'utf8'); }

function checkRegistration() {
  const sib = readCore('src/skill-siblings.js');
  if (/id:\s*'speech'/.test(sib) && sib.includes(SPEECH_REPO)) pass('C4a', 'skill-siblings.js: запись speech');
  else fail('C4a', 'skill-siblings.js: запись speech', `нет { id:'speech', repo:'${SPEECH_REPO}' }`);

  try {
    const cat = JSON.parse(readCore('config/skill-catalog.json'));
    const serverOk = cat.servers && cat.servers['speech-skills'] && cat.servers['speech-skills'].repo === SPEECH_REPO;
    const section = cat.sections && cat.sections['recruiting/interview'];
    const sectionOk = section && Array.isArray(section.siblings) && section.siblings.includes('speech-skills');
    if (serverOk && sectionOk) pass('C4b', 'skill-catalog.json: server speech-skills + секция recruiting/interview');
    else fail('C4b', 'skill-catalog.json: server speech-skills + секция recruiting/interview',
      !serverOk ? 'нет servers["speech-skills"]' : 'секция recruiting/interview не перечисляет sibling speech-skills');
  } catch (e) {
    fail('C4b', 'skill-catalog.json: server speech-skills + секция recruiting/interview', e.message);
  }

  const deploy = readCore('scripts/deploy.sh');
  const ensure = new RegExp(`ensure_sibling\\s+${SPEECH_REPO}`).test(deploy);
  const varOk = /SPEECH_SKILL_DIR=/.test(deploy);
  const hardGuard = new RegExp(`${SPEECH_REPO}/src/mcp-skills/index\\.js`).test(deploy);
  if (ensure && varOk && hardGuard) pass('C4c', 'deploy.sh: SPEECH_SKILL_DIR + ensure_sibling + жёсткий guard');
  else fail('C4c', 'deploy.sh: SPEECH_SKILL_DIR + ensure_sibling + жёсткий guard',
    `ensure_sibling=${ensure}, SPEECH_SKILL_DIR=${varOk}, hard-guard=${hardGuard}`);

  const ci = readCore('.github/workflows/ci.yml');
  const ciCount = (ci.match(new RegExp(SPEECH_REPO, 'g')) || []).length;
  if (ciCount >= 2) pass('C4d', 'ci.yml: репо в обоих циклах клонирования', `${ciCount} упоминаний`);
  else fail('C4d', 'ci.yml: репо в обоих циклах клонирования', `${ciCount} упоминаний, нужно ≥2`);

  const pb = readCore('src/playbook-store.js');
  if (pb.includes(`'${SPEECH_REPO}'`)) pass('C4e', 'playbook-store.js: DEFAULT_SIBLING_REPOS');
  else fail('C4e', 'playbook-store.js: DEFAULT_SIBLING_REPOS', `нет '${SPEECH_REPO}' в DEFAULT_SIBLING_REPOS`);

  const sc = readCore('tests/skill-contract.test.js');
  if (sc.includes(SPEECH_REPO)) pass('C4f', 'tests/skill-contract.test.js: цикл checkMcpConformance');
  else fail('C4f', 'tests/skill-contract.test.js: цикл checkMcpConformance', `нет '${SPEECH_REPO}' в списке сиблингов`);
}

// ── C5: ядро делегирует ───────────────────────────────────────────────────────
function checkDelegation() {
  const core = readCore('src/mcp-skills/tools/95-video-analysis.js');
  const leftovers = ['deepgramTranscribe', 'loadDeepgramKey', 'keyDir'].filter((s) => core.includes(s));
  if (leftovers.length) fail('C5a', '95-video-analysis.js: движка Deepgram в ядре нет', `осталось: ${leftovers.join(', ')}`);
  else pass('C5a', '95-video-analysis.js: движка Deepgram в ядре нет');

  const delegates = /siblingLib\(\s*'speech'|speech_skill_unavailable/.test(core);
  if (delegates) pass('C5b', '95-video-analysis.js: делегирование в sibling speech (siblingLib/speech_skill_unavailable)');
  else fail('C5b', '95-video-analysis.js: делегирование в sibling speech (siblingLib/speech_skill_unavailable)', 'нет вызова сиблинга speech');

  if (/video_set_deepgram_key/.test(core)) pass('C5c', 'легаси-алиас video_set_deepgram_key живёт в ядре');
  else fail('C5c', 'легаси-алиас video_set_deepgram_key живёт в ядре', 'алиас пропал — сломана обратная совместимость');
}

// ── main ──────────────────────────────────────────────────────────────────────
const started = process.hrtime.bigint();
console.log('SPEECH-F0 SANDBOX — исполнимая форма сценария speech_transcribe (Ф0)');
console.log(`Уровень S5 · команда: npm run sandbox:speech · скил: ${SKILL_DIR}`);
console.log(`Fixture: ${intakeDir}`);
console.log('');

// C1
if (fs.existsSync(SKILL_ENTRY)) pass('C1', `скил-репозиторий подключён (${SKILL_ENTRY})`);
else fail('C1', `скил-репозиторий подключён (${SKILL_ENTRY})`,
  `репозитория нет — ожидается на срезе S1 (SPEECH_SKILL_DIR или ${path.join('…/', SPEECH_REPO)})`);

// C2 / C3 — только если репо есть (иначе честно красные по причине «фичи нет»)
if (!fs.existsSync(SKILL_ENTRY)) {
  fail('C2', 'статика скила: check-skill-contract.js PASS', 'репозиторий скила не подключён');
  for (const [id, name] of [
    ['C3a', 'tools/list содержит speech_transcribe/_set_key/_status'],
    ['C3b', 'speech_set_key пишет ключ по ожидаемому пути (0o600)'],
    ['C3c', 'speech_status → key_present:true'],
    ['C3d', 'speech_transcribe(локальный файл) → {text,duration,language,cost_hint}'],
    ['C3e', 'запрос к Deepgram несёт model=nova-2&smart_format=true&language=ru'],
    ['C3f', 'diarize:true → feature_disabled'],
    ['C3g', '.mp4 → unsupported_source'],
    ['C3h', 'source=URL скачан, tmp-файл удалён (finally)'],
  ]) fail(id, name, 'репозиторий скила не подключён (срезы S1–S3 не сделаны)');
} else {
  const { execFileSync } = await import('node:child_process');
  check('C2', 'статика скила: check-skill-contract.js PASS', () => {
    try {
      const out = execFileSync(process.execPath, [path.join(CORE_ROOT, 'scripts', 'check-skill-contract.js'), SKILL_DIR], { encoding: 'utf8' });
      return { ok: true, note: out.trim().split('\n').slice(-1)[0] };
    } catch (e) {
      const out = `${e.stdout || ''}${e.stderr || ''}`.trim().split('\n').slice(-3).join(' | ');
      return { ok: false, reason: out || e.message };
    }
  });
  const stub = await startDeepgramStub();
  try {
    await runMcpSteps(stub);
  } catch (e) {
    fail('C3', 'MCP-граница скила (шаги 0–2)', `${e.name}: ${e.message}`);
  } finally {
    stub.server.close();
  }
}

// C4 / C5
checkRegistration();
checkDelegation();

// C6 — приёмка: пара, нормализация, similarity
check('C6a', 'пара «аудио↔транскрипт» выбирается по правилу mtime', () => {
  const pair = pickPair(intakeDir);
  if (pair.error) return { ok: false, reason: pair.error };
  if (pair.audio !== A_LATEST) return { ok: false, reason: `выбрано ${pair.audio}, ожидали ${A_LATEST}` };
  if (!(pair.deltaSec >= 0 && pair.deltaSec < 5)) return { ok: false, reason: `Δ=${pair.deltaSec}s вне [0,5)` };
  return { ok: true, note: `Δ=${pair.deltaSec}s` };
});
check('C6b', 'similarity нормализованного текста ≥ 0.9 (и отсекает чужой текст)', () => {
  const good = similarity(DEEPGRAM_MUTATED, CANONICAL);
  const bad = similarity(UNRELATED, CANONICAL);
  if (good < 0.9) return { ok: false, reason: `similarity=${good.toFixed(3)} < 0.9` };
  if (bad >= 0.9) return { ok: false, reason: `метрика не различает (чужой текст даёт ${bad.toFixed(3)})` };
  return { ok: true, note: `совпадение=${good.toFixed(3)}, чужой=${bad.toFixed(3)}` };
});

// ── отчёт ─────────────────────────────────────────────────────────────────────
const ms = Number(process.hrtime.bigint() - started) / 1e6;
console.log('');
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id.padEnd(4)} ${r.name}${r.ok && r.note ? ` — ${r.note}` : ''}`);
  if (!r.ok) console.log(`     ↳ причина: ${r.reason}`);
}
const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`── ${results.length - failed.length}/${results.length} PASS · цикл ${(ms / 1000).toFixed(1)}с (цель ≤60с) · уровень S5`);
if (failed.length) {
  console.log(`SPEECH-F0 SANDBOX: FAIL — ${failed.length} проверок красные.`);
  console.log('Красный по делу: срезы S1–S5 (сикл-репо + делегирование) ещё не сделаны.');
} else {
  console.log('SPEECH-F0 SANDBOX: PASS — сценарий Ф0 замкнут. Остаётся живой смоук с ключом.');
}
fs.rmSync(seed, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
