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
    // POST /internal/gtd/tick — run one GTD/durable tick right now (same code path and
    // re-entrancy guard as the 5-min timer). Used by scripts/e2e/playbooks-e2e.js.
    if (req.method === 'POST' && url.pathname === '/internal/gtd/tick') {
      const gtdTickNow = getGtdTickNow();
      if (!gtdTickNow) return json(res, 409, { ok: false, error: 'gtd tick not scheduled on this process' });
      await gtdTickNow();
      return json(res, 200, { ok: true, heartbeat: require('../gtd-controller').tickHeartbeat() });
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
