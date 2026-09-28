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
// Эскалация: SIGTERM → 5с → SIGKILL (spec §2). Таймер делает KILL только пока
// процесс жив — как только движок вышел, слот уже мог быть переарендован
// чужому рану, и слепой pkill убил бы невиновного.

const { execFileSync } = require('child_process');
const { isolationConfig } = require('../agent-isolation');

const STOP_ESCALATE_MS = 5000;

/** Отправить сигнал всем процессам слота. false = ничего не совпало / нет прав. */
function signalSlot(slot, signal, exec = execFileSync) {
  if (!slot) return false;
  try {
    exec(
      isolationConfig().sudoBin,
      ['-n', '-u', slot, '--', 'pkill', `-${signal}`, '-u', slot],
      { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10_000 },
    );
    return true;
  } catch { return false; } // pkill выходит с 1, когда нечего убивать
}

function alive(proc) {
  return !!proc && proc.exitCode === null && proc.signalCode === null;
}

/**
 * Остановить ран по state из activeTimers: TERM слоту + прямому ребёнку,
 * через 5с — KILL (если процесс ещё жив). Ставит `state.userStopped = true`,
 * чтобы хендлер close не ушёл в автопродолжение (R5).
 *
 * @param {{proc?:object, slot?:string|null, userStopped?:boolean}} state
 * @param {object} [opts]
 * @param {Function} [opts.exec]  — подмена execFileSync (тесты)
 * @param {Function} [opts.setTimeout] — подмена таймера эскалации (тесты)
 * @returns {boolean} был ли отправлен TERM
 */
function stopEngineProcess(state, { exec = execFileSync, setTimeout: schedule = setTimeout } = {}) {
  if (!state || !state.proc) return false;
  state.userStopped = true;
  signalSlot(state.slot, 'TERM', exec);
  try { state.proc.kill('SIGTERM'); } catch { /* уже вышел */ }
  if (state.stopEscalateTimer) return true;
  const slot = state.slot || null;
  state.stopEscalateTimer = schedule(() => {
    state.stopEscalateTimer = null;
    if (!alive(state.proc)) return; // вышел сам — слот мог уже уйти другому рану
    signalSlot(slot, 'KILL', exec);
    try { state.proc.kill('SIGKILL'); } catch { /* уже вышел */ }
    console.warn(`[stop] engine survived SIGTERM for ${STOP_ESCALATE_MS / 1000}s — escalated to SIGKILL`);
  }, STOP_ESCALATE_MS);
  state.stopEscalateTimer.unref?.();
  return true;
}

module.exports = { stopEngineProcess, signalSlot, STOP_ESCALATE_MS, _internals: { alive } };
