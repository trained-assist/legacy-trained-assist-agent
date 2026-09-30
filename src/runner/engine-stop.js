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
// Второй контур (SS-01, #1934): группа процессов. Слота может не быть вовсе —
// рабочий режим без AGENT_RUN_AS_USERS, — и тогда pkill -u некому слать, а
// прямой ребёнок (bash-ребёнок движка) переживал бы и TERM, и KILL. Дети
// спавнятся detached (claude-runner.js), поэтому TERM/KILL группе достаёт и
// внуков; см. groupSignal() ниже.
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

// Дефолт — 5с по спеке (§2). Ленивое чтение env нужно тестам: §4 case 1 гоняет
// реальное дерево процессов и не хочет ждать 5с в каждом прогоне. Экспорт
// STOP_ESCALATE_MS остаётся контрактом дефолта (тесты проверяют >= 4000).
function escalateDelayMs() {
  const v = Number(process.env.STOP_ESCALATE_MS);
  return Number.isFinite(v) && v > 0 ? v : STOP_ESCALATE_MS;
}

// fire-and-forget: ошибку (pkill выходит с 1, когда нечего убивать) глотаем.
function defaultExec(bin, argv, opts) {
  execFile(bin, argv, opts, () => { /* exit 1 = nothing matched — не ошибка */ });
}

/**
 * Сигнал ПРОЦЕССНОЙ ГРУППЕ рана (spec §2/SS-01: «вся группа, включая MCP/bash-детей»).
 * Ребёнок спавнится detached (claude-runner.js) — pgid = его pid, все его bash-дети
 * наследуют группу. ESRCH → false (группы нет — мёртвые не сигналятся), EPERM → true
 * (группа есть, но сигналить её не наш пользователь — слот-режим, там основной
 * адресом остаётся pkill -u <slot>).
 *
 * Второй контур, а не замена слота: под изоляцией прямой ребёнок — sudo-обёртка, и
 * `pkill -u <slot>` добивает дерево; без изоляции слота нет, и группа — ЕДИНСТВЕННЫЙ
 * способ достать внуков (внук, игнорирующий TERM, переживал бы Stop до 24ч).
 */
function groupSignal(pgid, signal) {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try { process.kill(-pgid, signal); return true; }
  catch (e) { return e.code === 'EPERM'; }
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
 * Остановить ран по state из activeTimers: TERM слоту (пока lease наш) + группе
 * процессов + прямому ребёнку, через 5с — KILL тем, кто ещё жив. Ставит
 * `state.userStopped = true`, чтобы хендлер close не ушёл в автопродолжение (R5).
 *
 * @param {{proc?:object, pgid?:number|null, slot?:string|null, slotLease?:{slot:string,released:boolean}, userStopped?:boolean}} state
 * @param {object} [opts]
 * @param {Function} [opts.exec]  — подмена запуска sudo (тесты)
 * @param {Function} [opts.setTimeout] — подмена таймера эскалации (тесты)
 * @param {Function} [opts.signalGroup] — подмена сигнала группе (тесты)
 * @returns {boolean} был ли отправлен хоть один сигнал
 */
function stopEngineProcess(state, { exec = defaultExec, setTimeout: schedule = setTimeout, signalGroup: group = groupSignal } = {}) {
  if (!state || !state.proc) return false;
  state.userStopped = true;
  const slot = leasedSlot(state);
  const procAlive = alive(state.proc);
  const pgid = Number.isInteger(state.pgid) ? state.pgid : null;
  const groupAlive = pgid ? group(pgid, 0) : false;
  if (!slot && !procAlive && !groupAlive) return false; // всё вышло, слот отдан, группы нет — сигналить некому
  if (slot) signalSlot(slot, 'TERM', exec);
  if (groupAlive) group(pgid, 'SIGTERM');
  if (procAlive) { try { state.proc.kill('SIGTERM'); } catch { /* уже вышел */ } }
  if (state.stopEscalateTimer) return true;
  state.stopEscalateTimer = schedule(() => {
    state.stopEscalateTimer = null;
    // Перепроверка lease/группы на момент эскалации: слот, отданный за эти 5с,
    // чужой; группа, раздавленная до того, как мы её увидели, — не наша (ESRCH).
    const stillLeased = leasedSlot(state);
    const stillAlive = alive(state.proc);
    const stillGroup = pgid ? group(pgid, 0) : false;
    if (!stillLeased && !stillAlive && !stillGroup) return;
    if (stillLeased) signalSlot(stillLeased, 'KILL', exec);
    if (stillGroup) group(pgid, 'SIGKILL');
    if (stillAlive) { try { state.proc.kill('SIGKILL'); } catch { /* уже вышел */ } }
    console.warn(`[stop] run survived SIGTERM for ${escalateDelayMs() / 1000}s — escalated to SIGKILL`);
  }, escalateDelayMs());
  state.stopEscalateTimer?.unref?.();
  return true;
}

module.exports = {
  stopEngineProcess, signalSlot, groupSignal, slotHasProcesses, runAlive, leasedSlot, STOP_ESCALATE_MS,
  _internals: { alive, escalateDelayMs },
};
