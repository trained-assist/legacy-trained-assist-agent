'use strict';
// Срез S5 (docs/user-scenarios/speech/03-proposal-design.md §2.5): ядро больше не
// содержит движка распознавания — только мост к trained-assist-speech-skill.
// Три вещи, которые только этот тест и держит:
//   1) в модуле нет собственного кода распознавания (движок уехал в скил);
//   2) без checkout'а — типизированная ошибка, а не «Unknown tool»/тишина;
//   3) контракт video_analyze_batch/video_analysis_status и ledger-идемпотентность
//      не изменились: повторный вызов НЕ идёт в распознавание.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MODULE = path.join(ROOT, 'src', 'mcp-skills', 'tools', '95-video-analysis.js');
const SIBLINGS = path.join(ROOT, 'src', 'skill-siblings.js');
const SIBLING_LIB = path.join(ROOT, 'src', 'domains', 'sibling-lib.js');

function hasFfmpeg() {
  return spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;
}

// Подмена ленивых require'ов внутри speechTools(): модуль родителя ничего не кэширует
// про сиблингов на момент загрузки, поэтому достаточно перехватить точку разрешения.
function stub(file, exportsObj) {
  const abs = require.resolve(file);
  const prev = require.cache[abs];
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exportsObj, children: [], paths: [] };
  return () => { if (prev) require.cache[abs] = prev; else delete require.cache[abs]; };
}

function loadTool() {
  delete require.cache[require.resolve(MODULE)];
  return require(MODULE);
}

test('движок распознавания в ядре отсутствует, мост присутствует', () => {
  const src = fs.readFileSync(MODULE, 'utf8');
  for (const bad of ['deepgramTranscribe', 'loadDeepgramKey', 'keyDir', 'api.deepgram.com']) {
    assert.ok(!src.includes(bad), `${bad} всё ещё есть в 95-video-analysis.js — движок не вынесен`);
  }
  assert.match(src, /siblingLib\(\s*'speech'/, 'нет делегирования в sibling speech');
  assert.match(src, /speech_skill_unavailable/, 'нет типизированной ошибки отсутствия скила');
  assert.match(src, /video_set_deepgram_key/, 'легаси-алиас пропал');
  // ffmpeg-обвязка, ledger и чейн остаются в ядре — это осознанно (Ф0).
  for (const keep of ['ffmpeg', 'libopus', 'video-pipeline-ledger.json', 'interview_analyze']) {
    assert.ok(src.includes(keep), `${keep} должен остаться в ядре`);
  }
});

test('без подключённого скила → speech_skill_unavailable (и статус, и пакет, и алиас)', async (t) => {
  const r1 = stub(SIBLINGS, { presentSiblings: () => [] });
  const r2 = stub(SIBLING_LIB, { siblingLib: () => { throw new Error('нет checkout'); } });
  t.after(() => { r1(); r2(); });
  const tool = loadTool();

  const batch = await tool.tools.video_analyze_batch.handler({ videos: '/tmp/never-used.mp4' });
  assert.equal(batch.error, 'speech_skill_unavailable', JSON.stringify(batch));
  assert.ok(batch.hint, 'ошибка обязана объяснять, что делать');

  const setKey = await tool.tools.video_set_deepgram_key.handler({ key: 'k' });
  assert.equal(setKey.error, 'speech_skill_unavailable', JSON.stringify(setKey));

  const status = await tool.tools.video_analysis_status.handler({});
  assert.strictEqual(status.deepgram_key_set, false, 'без скила ключа нет');
  assert.match(status.hint || '', /speech_skill_unavailable|не подключён/);
});

test('алиас уходит в speech_set_key, статус — в speech_status; поля ответа не изменились', async (t) => {
  const calls = { setKey: [], status: [] };
  const fakeTools = {
    speech_set_key: { handler: async (a) => { calls.setKey.push(a); return { saved: true, path: '/x/key.txt', hint: 'ok' }; } },
    speech_status: { handler: async () => { calls.status.push(1); return { key_present: true, last_calls: [] }; } },
    speech_transcribe: { handler: async () => ({ text: 'нет', duration: 1, language: 'ru', cost_hint: {} }) },
  };
  const r1 = stub(SIBLINGS, { presentSiblings: () => [{ id: 'speech' }] });
  const r2 = stub(SIBLING_LIB, { siblingLib: () => ({ tools: fakeTools }) });
  t.after(() => { r1(); r2(); });
  const tool = loadTool();

  const saved = await tool.tools.video_set_deepgram_key.handler({ key: 'abc' });
  assert.equal(saved.saved, true, JSON.stringify(saved));
  assert.deepStrictEqual(calls.setKey, [{ key: 'abc' }], 'алиас должен просто вызвать speech_set_key');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-status-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const status = await tool.tools.video_analysis_status.handler({ out_dir: dir });
  assert.strictEqual(status.deepgram_key_set, true, 'ключ берётся из speech_status');
  assert.deepStrictEqual(
    Object.keys(status).sort(),
    ['audio_leftover', 'analyses_done', 'batch_finished_at', 'complete', 'deepgram_key_set', 'expected_total',
      'ffmpeg', 'has_ledger', 'hint', 'items', 'last_event', 'note', 'outstanding', 'summary', 'transcripts_done',
      'work_dir'].sort(),
    'набор полей video_analysis_status изменился — это ломает контракт',
  );
  assert.strictEqual(status.hint, undefined, 'подсказка про ключ не нужна, когда ключ есть');
});

test('ledger-идемпотентность: повторный вызов не идёт в распознавание', { skip: !hasFfmpeg() }, async (t) => {
  const calls = { transcribe: [], setKey: [], status: [] };
  const fakeTools = {
    speech_set_key: { handler: async () => ({ saved: true }) },
    speech_status: { handler: async () => ({ key_present: true, last_calls: [] }) },
    speech_transcribe: {
      handler: async (a) => {
        calls.transcribe.push(a);
        if (!fs.existsSync(a.source)) return { error: 'source_unavailable', hint: `нет ${a.source}` };
        return { text: 'один два три', duration: 0.4, language: 'ru', cost_hint: {} };
      },
    },
  };
  const r1 = stub(SIBLINGS, { presentSiblings: () => [{ id: 'speech' }] });
  const r2 = stub(SIBLING_LIB, { siblingLib: () => ({ tools: fakeTools }) });
  t.after(() => { r1(); r2(); });
  const tool = loadTool();

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'video-batch-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const source = path.join(work, 'talk.wav');
  const gen = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'sine=frequency=440:duration=0.4', '-ac', '1', '-ar', '16000', source], { encoding: 'utf8' });
  assert.equal(gen.status, 0, `не смог создать тестовое аудио: ${gen.stderr}`);

  const out = path.join(work, 'out');
  const first = await tool.tools.video_analyze_batch.handler({
    videos: [{ name: 'Кандидат А', source }], out_dir: out, transcribe_only: true,
  });
  assert.equal(first.failed, 0, JSON.stringify(first));
  assert.equal(calls.transcribe.length, 1, 'первый вызов обязан пойти в распознавание');
  assert.match(calls.transcribe[0].source, /\.ogg$/, 'ядро отдаёт скилу путь к извлечённому аудио');
  const txt = path.join(out, 'transcripts', 'Кандидат-А.txt');
  assert.ok(fs.existsSync(txt), 'транскрипт записан');

  const second = await tool.tools.video_analyze_batch.handler({
    videos: [{ name: 'Кандидат А', source }], out_dir: out, transcribe_only: true,
  });
  assert.equal(second.failed, 0, JSON.stringify(second));
  assert.equal(second.results[0].transcribed, 'cached', 'повтор читает готовый транскрипт');
  assert.equal(calls.transcribe.length, 1, 'повторный вызов НЕ обращается к распознаванию (ledger)');

  const status = await tool.tools.video_analysis_status.handler({ out_dir: out });
  assert.strictEqual(status.has_ledger, true);
  assert.strictEqual(status.expected_total, 1);
  assert.ok(status.summary.includes('1/1'), status.summary);
});
