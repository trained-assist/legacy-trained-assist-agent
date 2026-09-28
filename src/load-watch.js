'use strict';

// Load watch — sustained-overload alert to the operator Telegram chat.
//
// Why (2026-09-28): a runaway `pam-auth-update` burned 100% of a core for 8.3 h
// and nothing said a word; separately the engine queue (MAX_CONCURRENT_TASKS)
// made chats wait minutes while the box was oversubscribed. Both are the same
// blind spot — nobody watches the HOST. This samples loadavg once a minute and
// alerts only when the load is high *continuously* for a sustain window, so a
// normal deep-run spike never pings the operator.
//
// Alert body lists the top CPU consumers (that is the whole point: the 02:16
// incident was only diagnosable by finding `frontend` at 98.5%).
//
// Env:
//   LOAD_ALERT_DISABLE=1     off entirely
//   LOAD_ALERT_RATIO         load1 threshold per core     (default 0.9)
//   LOAD_ALERT_SUSTAIN_MIN   minutes continuously above it (default 10)
//   LOAD_ALERT_COOLDOWN_MIN  min spacing between alerts    (default 30)
//   LOAD_ALERT_TOP_N         processes listed in the alert  (default 12)

const os = require('os');
const { execFile } = require('child_process');

// ── decision core (pure — the test drives this directly) ─────────────────────

/**
 * @param {object} [o]
 * @param {number} [o.ratio=0.9]        load1 per-core threshold
 * @param {number} [o.sustainMs=600000] how long load must stay above it
 * @param {number} [o.cooldownMs=1800000] min spacing between alerts
 * @param {number} [o.recoveryRatio=0.7] load1 drops below this → recovery notice
 * @returns {{sample: (load1:number, cores:number, now:number) => {event:'alert'|'recovery'|null, overMs:number}}}
 */
function createLoadWatcher({ ratio = 0.9, sustainMs = 10 * 60_000, cooldownMs = 30 * 60_000, recoveryRatio = 0.7 } = {}) {
  let overSince = null;      // when load1 first crossed the threshold (null = calm)
  // -Infinity, not 0: wall-clock `now` in tests starts at 0, and 0-cooldown would
  // have suppressed the very first alert for cooldownMs.
  let lastAlertAt = -Infinity;
  let inAlert = false;       // an alert is open; next drop below recoveryRatio closes it

  return {
    sample(load1, cores, now) {
      const threshold = ratio * cores;
      let event = null;

      if (load1 >= threshold) {
        if (overSince === null) overSince = now;
        const overMs = now - overSince;
        if (!inAlert && overMs >= sustainMs && now - lastAlertAt >= cooldownMs) {
          inAlert = true;
          lastAlertAt = now;
          event = 'alert';
        }
        return { event, overMs };
      }

      // Below threshold: does this close an open alert?
      const wasOverMs = overSince === null ? 0 : now - overSince;
      const closed = inAlert && load1 < recoveryRatio * cores;
      if (closed) {
        inAlert = false;
        event = 'recovery';
      }
      overSince = null;
      return { event, overMs: wasOverMs };
    },
  };
}

// ── top CPU consumers ────────────────────────────────────────────────────────
// `comm` alone is misleading (the 02:16 culprit showed as "frontend" — it was
// debconf's perl wrapper), so args are included, truncated.
function topProcesses(count = 12) {
  return new Promise(resolve => {
    // No `--sort`: BSD ps (macOS) rejects it, and ps pcpu is a lifetime average
    // anyway — sort in JS, portable across the dev Mac and the Linux prod VM.
    execFile('ps', ['-eo', 'pid,pcpu,pmem,rss,comm,args'],
      { timeout: 5000, maxBuffer: 1 << 20 }, (err, stdout) => {
        if (err) return resolve([]);
        const rows = String(stdout).trim().split('\n').slice(1).map(l => {
          const m = l.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s*(.*)$/);
          if (!m) return null;
          return { pid: m[1], cpu: parseFloat(m[2]), mem: parseFloat(m[3]), rssMb: Math.round(m[4] / 1024), comm: m[5], args: (m[6] || '').slice(0, 90) };
        }).filter(Boolean);
        rows.sort((a, b) => b.cpu - a.cpu);
        resolve(rows.slice(0, count));
      });
  });
}

function _num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ── runtime ──────────────────────────────────────────────────────────────────
/**
 * @param {object} o
 * @param {string} o.botToken  TELEGRAM_BOT_TOKEN
 * @param {string} o.chatId    OPERATOR_CHAT_ID (operator chat)
 * @param {number} [o.intervalMs=60000]
 * @returns {{stop: () => void}} timer handle
 */
function startLoadWatch({ botToken, chatId, intervalMs = 60_000 } = {}) {
  if (process.env.LOAD_ALERT_DISABLE === '1') {
    console.log('[load-watch] disabled (LOAD_ALERT_DISABLE=1)');
    return { stop() {} };
  }
  if (!botToken || !chatId) {
    console.warn('[load-watch] no botToken/chatId — not started');
    return { stop() {} };
  }

  const ratio = _num(process.env.LOAD_ALERT_RATIO, 0.9);
  const watcher = createLoadWatcher({
    ratio,
    sustainMs: _num(process.env.LOAD_ALERT_SUSTAIN_MIN, 10) * 60_000,
    cooldownMs: _num(process.env.LOAD_ALERT_COOLDOWN_MIN, 30) * 60_000,
  });
  const topN = _num(process.env.LOAD_ALERT_TOP_N, 12);
  const cores = os.cpus().length || 1;
  const start = Date.now();

  const send = async text => {
    const base = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
    try {
      const res = await fetch(`${base}/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) console.warn(`[load-watch] telegram HTTP ${res.status}`);
    } catch (e) { console.warn('[load-watch] telegram:', e.message); }
  };

  let busy = false; // never overlap samples; a hung `ps` must not pile up
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const load = os.loadavg();
      const { event, overMs } = watcher.sample(load[0], cores, Date.now());
      if (!event) return;

      const mins = ms => Math.max(1, Math.round(ms / 60_000));
      const loadLine = `load ${load[0].toFixed(1)} / ${load[1].toFixed(1)} / ${load[2].toFixed(1)} при ${cores} ядрах (порог ${(ratio * cores).toFixed(1)})`;
      const mem = (() => {
        const t = os.totalmem(), f = os.freemem();
        return `RAM ${(t / 2 ** 30).toFixed(1)} GB, свободно ${(f / 2 ** 30).toFixed(1)} GB`;
      })();

      if (event === 'alert') {
        const top = await topProcesses(topN);
        const rows = top.map((p, i) =>
          `${i + 1}. ${String(p.cpu).padStart(5)}% cpu ${String(p.rssMb).padStart(4)}MB  pid ${p.pid}  ${p.args || p.comm}`
        ).join('\n');
        const uptimeH = Math.round((Date.now() - start) / 3_600_000 * 10) / 10;
        await send(
          `⚠️ Перегрузка VM — ${mins(overMs)} мин выше порога\n` +
          `${loadLine}\n${mem}\nuptime этой сессии ${uptimeH} ч\n\n` +
          `Топ по CPU:\n${rows || '(ps не ответил)'}`
        );
        console.log(`[load-watch] ALERT load=${load[0].toFixed(1)} cores=${cores} over=${mins(overMs)}m`);
      } else if (event === 'recovery') {
        await send(`✅ Перегрузка спала — длилась ${mins(overMs)} мин\n${loadLine}\n${mem}`);
        console.log(`[load-watch] recovered after ${mins(overMs)}m load=${load[0].toFixed(1)}`);
      }
    } catch (e) {
      console.warn('[load-watch]', e.message);
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  console.log(`[load-watch] started: cores=${cores} interval=${intervalMs}ms ratio=${process.env.LOAD_ALERT_RATIO || 0.9} sustain=${process.env.LOAD_ALERT_SUSTAIN_MIN || 10}m`);
  return { stop: () => clearInterval(timer) };
}

module.exports = { createLoadWatcher, startLoadWatch, topProcesses };
