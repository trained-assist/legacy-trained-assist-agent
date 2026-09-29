'use strict';
// /internal/* routes — machine-to-machine endpoints behind the AGENT_SECRET Bearer gate:
// domain-repo services (publish, cron jobs), gateway views (run input), GTD / cron engine
// ticks + status, engine auth status. server.js mounts this AFTER the auth gate for
// /internal/ paths only; host helpers arrive in ctx (same dispatcher pattern as
// handlers/web.js and handlers/connect.js — returns false when no route matched).
const path = require('path');
const { getAuthFlag, getAllAuthFlags, clearAuthFailedFlag } = require('../auth-flag');
const { getAllEngineHealth } = require('../engine-health');

async function handleInternal(req, url, res, ctx) {
  const { json, readBody, BASE_USERS_DIR, getGtdTickNow } = ctx;

    // POST /internal/publish — publish a page for a profile on behalf of a domain skill
    // repo (#1470): the same writer as the publish_page tool, reached over HTTP so a
    // sibling never requires core code. Body: { username, slug, content, title?,
    // password?, is_public?, format? } → { url, public_url, slug, is_protected, … }.
    if (req.method === 'POST' && url.pathname === '/internal/publish') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const { username, slug, content, title, password, is_public, format } = body || {};
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(username || ''))) return json(res, 400, { error: 'invalid username' });
      const out = require('../mcp-skills/tools/97-publish').publishPage({ username, slug, content, title, password, is_public, format });
      return json(res, out.error ? 400 : 200, out);
    }

    // POST /internal/flush-profile — drop this process's buffered JSONL records
    // BEFORE the profile migrator snapshots a profile (epic #1784). The migrator
    // is a SEPARATE process: without this call the batched flush
    // (src/jsonl-batched-flush.js) would later write a buffer the snapshot never
    // saw and re-create an archived file — risk R2 of the live-implementation
    // analysis. Body OR query: { username } (validated + logged; flushAll writes
    // every file this process has buffered — a buffer is never partial-profile).
    // Response: { ok, flushed, failed } — `failed > 0` means records are STILL
    // buffered and the snapshot is not safe yet, which is a 500 so even a caller
    // that only checks the HTTP status cannot walk into R2.
    if (req.method === 'POST' && url.pathname === '/internal/flush-profile') {
      let body = {};
      try { const raw = await readBody(req); if (raw) body = JSON.parse(raw); }
      catch { return json(res, 400, { error: 'bad json' }); }
      const username = (body && body.username) || url.searchParams.get('username') || '';
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(username))) return json(res, 400, { error: 'invalid username' });
      const { flushed, failed } = require('../jsonl-batched-flush').flushAll();
      const ok = failed === 0;
      console.log('[flush-profile] username=%s flushed=%d failed=%d', username, flushed, failed);
      return json(res, ok ? 200 : 500, { ok, flushed, failed });
    }

    // GET /internal/run-input?username=X&taskId=Y — the REAL model input of a run
    // (system prompt + context/task), written by the runner at spawn time
    // (src/run-input-store.js). Powers the gateway's «Посмотреть input» button.
    // 404 for unknown/old runs: the gateway falls back to its own snapshot view,
    // so a miss is a degraded view, never an error surfaced to the user.
    if (req.method === 'GET' && url.pathname === '/internal/run-input') {
      const username = url.searchParams.get('username') || '';
      const taskId = url.searchParams.get('taskId') || '';
      if (!/^[a-zA-Z0-9_-]{1,32}$/.test(username)) return json(res, 400, { error: 'invalid username' });
      const doc = require('../run-input-store').readInput(path.join(BASE_USERS_DIR, username), taskId);
      if (!doc) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(doc);
      return;
    }

    // GET /internal/gtd-status — GTD tick heartbeat + backlog (issue #512 pt.3). The tick lives
    // inside an in-process setInterval (scheduleGtdController below); if it ever silently stopped
    // firing, open records would sit forever with no external signal. `stale` flips once we've
    // missed 3 ticks' worth of time AND there's backlog waiting on it — cheap enough to poll from
    // a cron-skill job without spawning Claude.
    // POST /internal/orphan-checklists/action — «▶️ Делать» / «✖️ Отменить» под
    // напоминанием об осиротевшем чек-листе (#1729 BV-08/08a; шлюз, callback `ocl|do|<id>`
    // / `ocl|no|<id>`). Детерминированно, без LLM. Body: { username, action: 'do'|'no',
    // id, chatId?, threadId?, audience? } → { ok, status, text } (text — во что шлюз
    // правит сообщение с кнопками). «Делать» пишет GTD-запись с dueAt=now и дёргает тик,
    // не дожидаясь (ран идёт в фоне; тик в полёте → подхватит следующий, ≤ 5 мин).
    if (req.method === 'POST' && url.pathname === '/internal/orphan-checklists/action') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const { username, action, id, chatId, threadId, audience } = body || {};
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(username || ''))) return json(res, 400, { error: 'invalid username' });
      if (action !== 'do' && action !== 'no') return json(res, 400, { error: 'invalid action' });
      if (!/^[a-f0-9]{6,40}$/.test(String(id || ''))) return json(res, 400, { error: 'invalid id' });
      if (audience != null && !/^[a-zA-Z0-9_-]{1,32}$/.test(String(audience))) return json(res, 400, { error: 'invalid audience' });
      const out = require('../orphan-checklists').act({
        workDir: path.join(BASE_USERS_DIR, username), username, id, action,
        chatId: chatId ?? null, threadId: Number.isInteger(threadId) && threadId > 0 ? threadId : null,
        audience: audience || null,
      });
      if (out.status === 'started') {
        const tick = getGtdTickNow && getGtdTickNow();
        if (tick) Promise.resolve().then(tick).catch(e => console.warn('[orphan-checklists] tick:', e.message));
      }
      return json(res, out.status === 'bad-request' ? 400 : 200, out);
    }

    // POST /internal/durable/kick — run ONE durable pass now (wait-latency plan
    // a61bb2c5): task_item_wake and a credential write nudge the executor instead
    // of waiting for the 30s wait tick / the 5-min GTD tick. Kick is debounced (3s)
    // and serialized in gtd-controller, so bursts collapse to one pass.
    // NOT the full /internal/gtd/tick: that one also runs checklists and crons.
    if (req.method === 'POST' && url.pathname === '/internal/durable/kick') {
      let reason = null;
      try { const raw = await readBody(req); if (raw) reason = (JSON.parse(raw) || {}).reason || null; } catch { /* best-effort */ }
      const armed = require('../gtd-controller').kickDurable();
      return json(res, 200, { ok: true, armed: !!armed, reason });
    }

    // POST /internal/gtd/tick — run one GTD/durable tick right now (same code path and
    // re-entrancy guard as the 5-min timer). Used by scripts/e2e/playbooks-e2e.js.
    // Optional body {accelerate: {plan_id, profile}}: that plan's waiting steps poll now.
    if (req.method === 'POST' && url.pathname === '/internal/gtd/tick') {
      const gtdTickNow = getGtdTickNow();
      if (!gtdTickNow) return json(res, 409, { ok: false, error: 'gtd tick not scheduled on this process' });
      let body = {};
      try { const raw = await readBody(req); body = raw ? JSON.parse(raw) : {}; } catch { return json(res, 400, { error: 'bad json' }); }
      let accelerated = 0;
      if (body && body.accelerate && body.accelerate.plan_id) {
        try { accelerated = require('../durable-e2e').accelerateWaits(body.accelerate.plan_id, body.accelerate.profile); }
        catch (e) { return json(res, e.status || 400, { error: e.message }); }
      }
      await gtdTickNow();
      return json(res, 200, { ok: true, accelerated, heartbeat: require('../gtd-controller').tickHeartbeat() });
    }

    // ── Playbook e2e API (driven by scripts/e2e/playbooks-e2e.js --remote) ──────────
    // POST /internal/e2e/plans {profile, playbook_id, goal, level_map?}   → start a plan
    // GET  /internal/e2e/plans?profile=                                   → list plans
    // GET  /internal/e2e/plans/:id?profile=                               → step report
    // POST /internal/e2e/plans/:id/cancel {profile}                       → cancel
    // POST /internal/durable/items/:id/wake {profile, message}            → answer a waiting step
    // GET  /internal/e2e/defects?profile=&plan=&kind=                     → playbook defects log
    if (url.pathname === '/internal/e2e/plans' || url.pathname.startsWith('/internal/e2e/plans/') || url.pathname === '/internal/e2e/defects'
      || /^\/internal\/durable\/items\/[^/]+\/wake$/.test(url.pathname)) {
      const e2e = require('../durable-e2e');
      const readJson = async () => { const raw = await readBody(req); return raw ? JSON.parse(raw) : {}; };
      try {
        if (req.method === 'POST' && url.pathname === '/internal/e2e/plans') {
          const b = await readJson();
          return json(res, 200, e2e.startPlan({ profile: b.profile, playbookId: b.playbook_id, goal: b.goal, vars: b.vars || null, levelMap: b.level_map || null }));
        }
        if (req.method === 'GET' && url.pathname === '/internal/e2e/defects') {
          const { readDefects } = require('../playbook-defects-log');
          return json(res, 200, { defects: readDefects({ profileId: url.searchParams.get('profile') || null, taskId: url.searchParams.get('plan') || null, kind: url.searchParams.get('kind') || null }) });
        }
        if (req.method === 'GET' && url.pathname === '/internal/e2e/plans') {
          return json(res, 200, { plans: e2e.listPlans(url.searchParams.get('profile')) });
        }
        const cancel = /^\/internal\/e2e\/plans\/([^/]+)\/cancel$/.exec(url.pathname);
        if (req.method === 'POST' && cancel) {
          const b = await readJson();
          return json(res, 200, e2e.cancelPlan(decodeURIComponent(cancel[1]), b.profile));
        }
        const one = /^\/internal\/e2e\/plans\/([^/]+)$/.exec(url.pathname);
        if (req.method === 'GET' && one) {
          return json(res, 200, e2e.planReport(decodeURIComponent(one[1]), url.searchParams.get('profile')));
        }
        const wake = /^\/internal\/durable\/items\/([^/]+)\/wake$/.exec(url.pathname);
        if (req.method === 'POST' && wake) {
          const b = await readJson();
          return json(res, 200, e2e.wakeStep(decodeURIComponent(wake[1]), b.profile, b.message ?? null));
        }
      } catch (e) {
        if (e instanceof SyntaxError) return json(res, 400, { error: 'bad json' });
        return json(res, e.status || 500, { error: e.message });
      }
      return json(res, 405, { error: 'method not allowed' });
    }

    if (req.method === 'GET' && url.pathname === '/internal/gtd-status') {
      const gtd = require('../gtd-controller');
      const heartbeat = gtd.tickHeartbeat();
      const legacy = gtd.countOpenLegacy(BASE_USERS_DIR);
      const durable = gtd.durableItemCounts();
      const msSinceLastTick = heartbeat.lastFinishAt != null ? Date.now() - heartbeat.lastFinishAt : null;
      const backlog = legacy.open + durable.pending + durable.waiting;
      const stale = msSinceLastTick != null && msSinceLastTick > 3 * 5 * 60 * 1000;
      return json(res, stale && backlog > 0 ? 503 : 200, {
        heartbeat, msSinceLastTick, stale, backlog, legacy, durable,
      });
    }

    // POST /internal/cron/tick — external alarm for the generic cron engine (#1489; systemd
    // timer in P2.1). Answers after claiming; the claimed runs finish in the background.
    // GET /internal/cron-status — engine heartbeat + due/running counts.
    // POST /internal/cron/jobs — skill providers manage their named jobs (#1514, cron-jobs-api.js).
    if (req.method === 'POST' && url.pathname === '/internal/cron/jobs') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, error: 'bad json' }); }
      const cronRuntime = require('../cron-runtime');
      const out = require('../cron-jobs-api').handleCronJobs(body, {
        service: cronRuntime.getCronService(), role: cronRuntime.schedulerRole(),
      });
      return json(res, out.status, out.body);
    }
    if (url.pathname === '/internal/cron/tick' || url.pathname === '/internal/cron-status') {
      const cronRuntime = require('../cron-runtime');
      const role = cronRuntime.schedulerRole();
      if (req.method === 'GET' && url.pathname === '/internal/cron-status') {
        return json(res, 200, { role, ...cronRuntime.getCronService().status() });
      }
      if (req.method === 'POST' && url.pathname === '/internal/cron/tick') {
        if (role !== 'primary') return json(res, 409, { ok: false, role, error: 'scheduler is not primary on this host' });
        const { claimed, recovered } = cronRuntime.getCronService().tick();
        return json(res, 200, { ok: true, role, claimed, recovered });
      }
    }

    // GET /internal/auth-status — engine auth + health. Derived view of current state (spec §12):
    // `engine_health` is the operational truth (healthy|degraded|unavailable, self-healed on the
    // next successful call); `claude_auth_ok`/`reason`/… and `engines` are kept for back-compat
    // with the existing repair system (they reflect the auth flag, which now only ever tracks a
    // real credential loss — QUOTA/RATE_LIMIT no longer write it, see engine-health.js).
    if (req.method === 'GET' && url.pathname === '/internal/auth-status') {
      const flag = getAuthFlag('claude');
      return json(res, 200, {
        claude_auth_ok: !flag.failed,
        ...(flag.failed ? { reason: flag.reason, vm: flag.vm, failed_at: flag.failed_at, error_text: flag.error_text } : {}),
        engines: getAllAuthFlags(),
        engine_health: getAllEngineHealth(),
      });
    }

    // POST /internal/auth-status/clear?engine=claude|codex|opencode — mark repaired (called by
    // repair system after fixing auth). engine omitted → 'claude', same as before per-engine tracking.
    if (req.method === 'POST' && url.pathname === '/internal/auth-status/clear') {
      clearAuthFailedFlag(url.searchParams.get('engine'));
      return json(res, 200, { ok: true });
    }

  return false;
}

module.exports = { handleInternal };
