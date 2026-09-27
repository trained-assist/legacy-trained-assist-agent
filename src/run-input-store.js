// Per-run snapshot of the REAL model input — what the agent actually handed the
// engine for this run (system prompt + context/task), written at spawn time and
// keyed by taskId. Powers the gateway's «Посмотреть input» button: the button
// used to show only the gateway-side task text with a "the model gets more" note;
// this store is that missing "more", verifiable per run.
//
// Location: <workDir>/.run-inputs/<taskId>.txt — per-profile, survives restarts,
// pruned to the newest KEEP files. Best-effort by contract: every failure here
// must degrade to "no snapshot" (404 on the endpoint → gateway fallback), never
// to a blocked run.
const fs = require('fs');
const path = require('path');

// Mirrors the /run taskId grammar (username ≤32, audience ≤32, requestId ≤128,
// all [a-zA-Z0-9_-]) plus a safety margin. Doubles as the filename guard.
const TASK_ID_RE = /^[a-zA-Z0-9_.-]{1,200}$/;
const KEEP = 30;

const storeDir = workDir => path.join(workDir, '.run-inputs');

function buildDocument({ taskId, engine, sessionId, systemPrompt, prompt, createdAt }) {
  const sys = systemPrompt || '';
  const pr = prompt || '';
  const at = new Date(createdAt || Date.now()).toISOString();
  return [
    `Реальный input агента — ${taskId}`,
    `Записан: ${at} · движок: ${engine || '?'} · сессия: ${sessionId || '(новая)'}`,
    `Системный промпт: ${sys.length} символов · контекст+задача: ${pr.length} символов`,
    '',
    'Это всё, что агент передал модели в этот запуск: (1) системный промпт — роль/персона,',
    'правила проекта, режим ответа; (2) промпт — контекстные секции, история сессии, задача.',
    'Схемы MCP-инструментов и история с результатами инструментов собираются самим движком',
    'и здесь не воспроизведены — но они тоже входят в «вход N токенов» в строке расхода.',
    '',
    '────────── 1. СИСТЕМНЫЙ ПРОМПТ ──────────',
    sys,
    '',
    '────────── 2. ПРОМПТ (контекст + задача) ──────────',
    pr,
  ].join('\n');
}

function prune(dir) {
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.txt'))
      .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const stale of files.slice(KEEP)) fs.unlinkSync(path.join(dir, stale.f));
  } catch { /* pruning is never worth failing a run over */ }
}

function writeInput(workDir, taskId, doc) {
  if (!workDir || !taskId || !TASK_ID_RE.test(taskId) || typeof doc !== 'string') return false;
  const dir = storeDir(workDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${taskId}.txt`), doc, { mode: 0o600 });
  prune(dir);
  return true;
}

function readInput(workDir, taskId) {
  if (!workDir || !taskId || !TASK_ID_RE.test(taskId)) return null;
  try {
    return fs.readFileSync(path.join(storeDir(workDir), `${taskId}.txt`), 'utf8');
  } catch {
    return null;
  }
}

module.exports = { buildDocument, writeInput, readInput, TASK_ID_RE, KEEP };
