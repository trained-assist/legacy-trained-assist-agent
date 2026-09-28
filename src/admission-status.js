// One ordered status stream until the runner owns the message. Never allow a
// slow queue edit to land after the running/failure status.
function createAdmissionStatus(opts, { edit, send, intervalMs = 15000 }) {
  const token = opts.secrets?.BOT_TOKEN;
  const chatId = opts.user.id;
  let tail = Promise.resolve();
  let timer = null;
  let phase = '';
  let closed = false;
  let outstanding = 0;
  const started = Date.now();
  const publish = text => {
    outstanding++;
    tail = tail.then(async () => {
      if (!token || !opts.initialMsgId) return;
      try {
        // Best-effort + coalesced: admission status is cosmetic, and with several
        // sessions on one bot token a retry storm on editMessageText 429 would
        // only make the flood worse (retry_after escalates 5s->44s).
        const result = await edit(token, chatId, opts.initialMsgId, text, {}, { bestEffort: true, coalesce: true });
        // A best-effort 429 drop (`flooded`) is an INTENTIONAL skip — the next tick
        // edits the same message again, same as a coalesce skip. Treating it as a
        // failure here used to trigger a fallback sendMessage on every rate-limited
        // tick, producing a pile of duplicate "Ожидаю завершения..." bubbles instead
        // of one message being edited in place (bug: voice+screenshot report 2026-09-23).
        if (result?.ok === false && !result?.flooded && !/message is not modified/i.test(result.description || '')) {
          throw new Error(result.description || 'Telegram edit failed');
        }
      } catch (err) {
        console.warn(`[${opts.taskId}] admission status: ${err.message}`);
        await send(token, chatId, text).catch(() => {});
      }
    }).finally(() => { outstanding--; });
    return tail;
  };
  return {
    waiting(reason) {
      if (closed) return;
      phase = reason;
      if (timer) clearInterval(timer);
      publish(phase);
      timer = setInterval(() => {
        if (!outstanding) publish(`${phase}\nОжидание: ${Math.round((Date.now() - started) / 1000)} с.`);
      }, intervalMs);
      timer.unref?.();
    },
    async finish(text) {
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
      await publish(text);
    },
    // Stop the waiting ticker WITHOUT publishing — the caller delivers its own
    // message through the normal send path instead (a pre-queue quick answer
    // that parked on the profile maintenance lock, #1784: without this the
    // «Ожидание: N с» interval would overwrite its ⚡ reply every 15s). Returns
    // the pending tail so the caller can order its own edit AFTER an in-flight
    // status edit.
    close() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
      return tail;
    },
  };
}
module.exports = { createAdmissionStatus };
