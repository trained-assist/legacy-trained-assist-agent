'use strict';
// «Стоп» реально убивает движок — под run-as изоляцией (spec §2, K3/K11).
//
// Проблема: с AGENT_RUN_AS_USERS прямой ребёнок `proc` — это НЕ движок, а
// `sudo -n -u <slot> -- <engine>`. Проверено на живом GCP (28.09.2026):
//   • SIGTERM в обёртку  → сигнал доставлен, handler отработал, движок жив;
//   • SIGKILL в обёртку  → движок осиротевает (PPID=1) и продолжает работать.
// Поэтому «остановлено» в логе не означало остановлено — ровно инцидент §0.
//
// Рабочая схема — тот же паттерн, что уже используется в reapSlot
// (agent-isolation.js): писать сигнал ПОЛЬЗОВАТЕЛЮ слота, а не обёртке:
//     sudo -n -u <slot> -- pkill -TERM -u <slot>
// Слот арендуется эксклюзивно на один ран (lock-файл), значит `pkill -u <slot>`
// адресует ровно дерево процессов ЭТОГО рана — движок + bash-дети. MCP-серверы
// бегут от сервис-пользователя, их добивает isolation.release() →
// bridge.unregisterRun() на 'close' движка (agent-mcp-bridge.js:44).
//
// Эскалация: SIGTERM → 5с → SIGKILL (spec §2).
//
// «Жив» — это НЕ «жива обёртка». Под изоляцией `proc` — sudo-обёртка: движок мог
// выйти, а его ребёнок пережить TERM (или держать stdout-pipe — тогда 'close' не
// придёт и слот не освободится). Поэтому живость рана = жива обёртка ИЛИ слот ещё
// арендован ЭТИМ раном и в нём есть процессы (pgrep -u <slot>).
//
// Аренда (lease): claude-runner кладёт в state `slotLease = { slot, released }` и
// выставляет `released = true` в том же хендлере 'close', где isolation.release()
// добивает слот (reapSlot) и отдаёт lock. Сигнал слоту уходит ТОЛЬКО пока lease
// наш: после release слот мог достаться чужому рану (другого юзера), и слепой
// `pkill -u <slot>` убил бы невиновного. После release добивать нечего — release
// сам делает reapSlot до отдачи lock.
//
// Все вызовы sudo — асинхронные: Стоп не имеет права блокировать event loop
// (execFileSync с таймаутом 10с замораживал бы весь сервер на каждом Стопе).

const { execFile } = require('child_process');
const { isolationConfig } = require('../agent-isolation');

const STOP_ESCALATE_MS = 5000;
const SUDO_TIMEOUT_MS = 10_000;

// fire-and-forget: ошибку (pkill выходит с 1, когда нечего убивать) глотаем.
function defaultExec(bin, argv, opts) {
  execFile(bin, argv, opts, () => { /* exit 1 = nothing matched — не ошибка */ });
}

/** Отправить сигнал всем процессам слота. false = нечего/не удалось запустить. */
function signalSlot(slot, signal, exec = defaultExec) {
  if (!slot) return false;
  try {
    exec(
      isolationConfig().sudoBin,
      ['-n', '-u', slot, '--', 'pkill', `-${signal}`, '-u', slot],
      { stdio: ['ignore', 'ignore', 'pipe'], timeout: SUDO_TIMEOUT_MS },
    );
    return true;
  } catch { return false; }
}

/** Есть ли у слота процессы. Любая ошибка кроме «ничего не найдено» → true (осторожно: не подтверждаем). */
function slotHasProcesses(slot, run = execFile) {
  if (!slot) return Promise.resolve(false);
  return new Promise(resolve => {
    try {
      run(isolationConfig().sudoBin, ['-n', '-u', slot, '--', 'pgrep', '-u', slot],
        { timeout: SUDO_TIMEOUT_MS }, (err) => {
          if (!err) return resolve(true);          // pgrep нашёл процессы
          resolve(err.code === 1 ? false : true);  // 1 = пусто; иное (sudo/таймаут) — не знаем → «жив»
        });
    } catch { resolve(true); }
  });
}

// `== null`: у ChildProcess до выхода оба поля null; объект без этих полей
// (обёртки/тестовые дублёры) считаем живым — ошибиться в сторону «жив» дешевле:
// лишний сигнал мёртвому процессу безвреден, пропущенный живому — инцидент §0.
function alive(proc) {
  return !!proc && proc.exitCode == null && proc.signalCode == null;
}

/**
 * Слот, который СЕЙЧАС арендован этим раном, иначе null. Без lease-объекта
 * (старые вызовы/тесты) — `state.slot`, но только пока жив процесс: мёртвый
 * процесс без lease-флага мог уже отдать слот.
 */
function leasedSlot(state) {
  if (!state) return null;
  if (state.slotLease) return state.slotLease.released ? null : (state.slotLease.slot || null);
  return alive(state.proc) ? (state.slot || null) : null;
}

/** Жив ли ран: обёртка или процессы в ещё НАШЕМ слоте. */
async function runAlive(state, { hasProcesses = slotHasProcesses } = {}) {
  if (alive(state?.proc)) return true;
  const slot = leasedSlot(state);
  return slot ? hasProcesses(slot) : false;
}

/**
 * Остановить ран по state из activeTimers: TERM слоту (пока lease наш) + прямому
 * ребёнку, через 5с — KILL тем, кто ещё жив. Ставит `state.userStopped = true`,
 * чтобы хендлер close не ушёл в автопродолжение (R5).
 *
 * @param {{proc?:object, slot?:string|null, slotLease?:{slot:string,released:boolean}, userStopped?:boolean}} state
 * @param {object} [opts]
 * @param {Function} [opts.exec]  — подмена запуска sudo (тесты)
 * @param {Function} [opts.setTimeout] — подмена таймера эскалации (тесты)
 * @returns {boolean} был ли отправлен хоть один сигнал
 */
function stopEngineProcess(state, { exec = defaultExec, setTimeout: schedule = setTimeout } = {}) {
  if (!state || !state.proc) return false;
  state.userStopped = true;
  const slot = leasedSlot(state);
  const procAlive = alive(state.proc);
  if (!slot && !procAlive) return false; // всё уже вышло, слот отдан — сигналить некому
  if (slot) signalSlot(slot, 'TERM', exec);
  if (procAlive) { try { state.proc.kill('SIGTERM'); } catch { /* уже вышел */ } }
  if (state.stopEscalateTimer) return true;
  state.stopEscalateTimer = schedule(() => {
    state.stopEscalateTimer = null;
    // Перепроверка lease на момент эскалации: слот, отданный за эти 5с, чужой.
    const stillLeased = leasedSlot(state);
    const stillAlive = alive(state.proc);
    if (!stillLeased && !stillAlive) return;
    if (stillLeased) signalSlot(stillLeased, 'KILL', exec);
    if (stillAlive) { try { state.proc.kill('SIGKILL'); } catch { /* уже вышел */ } }
    console.warn(`[stop] run survived SIGTERM for ${STOP_ESCALATE_MS / 1000}s — escalated to SIGKILL`);
  }, STOP_ESCALATE_MS);
  state.stopEscalateTimer?.unref?.();
  return true;
}

module.exports = {
  stopEngineProcess, signalSlot, slotHasProcesses, runAlive, leasedSlot, STOP_ESCALATE_MS,
  _internals: { alive },
};
