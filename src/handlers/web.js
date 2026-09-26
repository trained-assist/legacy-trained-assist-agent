// Web handler — /web/* cookie/bearer-auth UI endpoints + static asset serving
// (issue #942 P3.3b). server.js is the router; the bulk of /web/* business logic
// already lives in ../web-routes.js (handleWebRoute) — this module covers the
// remaining routes that were still defined inline in server.js: the external-
// frontend bearer endpoints (verify/projects/sessions-list/session-get/
// run-bearer/reply-bearer), cookie auth (auth/logout), and the static web-ui
// asset server.
//
// Dispatcher pattern (same as src/handlers/hh.js #1030, src/handlers/connect.js
// #1039): returns `false` when no route matched so server.js can continue to
// the next handler; any route match ends the request itself.
const path = require('path');
const fs = require('fs');

const { signJwt, setTokenCookie, clearTokenCookie, checkPassword } = require('../web-auth');

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req, maxBytes = 1_048_576) {
  return readBodyBuffer(req, maxBytes).then(buf => buf.toString());
}
function readBodyBuffer(req, maxBytes = 1_048_576) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let rejected = false;
    req.on('data', c => {
      if (rejected) return;
      total += c.length;
      if (total > maxBytes) { rejected = true; return reject(new Error('body too large')); }
      chunks.push(c);
    });
    req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

async function handleWeb(req, url, res, ctx) {
  const { secrets } = ctx;

  // ── POST /web/verify — stateless password check for external frontends ────
  // An external web front-end (e.g. the Cloudflare session-manager worker at
  // app.trainedassist.store) POSTs {username, password} here to validate a
  // login against the SAME per-profile password store the bot writes to
  // (savePassword → ~/agent-tokens/<user>/.webpasswd). This lets any password
  // the bot generates work on the web UI automatically, with no manual sync.
  // Protected by a shared bearer secret so it can't be used as a public
  // password oracle; does NOT require WEB_JWT_SECRET (no cookie is issued —
  // the caller mints its own session token on a 200).
  if (req.method === 'POST' && url.pathname === '/web/verify') {
    const verifySecret = secrets.WEB_VERIFY_SECRET || secrets.AGENT_SECRET;
    const auth = req.headers['authorization'] || '';
    if (!verifySecret || auth !== `Bearer ${verifySecret}`) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const { username, password } = body || {};
    if (!username || !password || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username or password' });
    if (!checkPassword(username, password)) return json(res, 401, { error: 'invalid username or password' });
    return json(res, 200, { ok: true, username });
  }

  // ── POST /web/projects — authoritative project list for external frontends ─
  // Same delegation pattern as /web/verify: an external UI (the Cloudflare
  // session-manager worker) POSTs {username} + shared bearer, and gets back the
  // profile's project list read from the SINGLE source of truth — projects.js /
  // the on-disk projects/ folder. The worker must NOT keep its own list, or it
  // drifts from the bot the same way the password store did (see [028]). Flat,
  // linear list (no tree) — {id,name,type,label,lastAt}. Empty array if the
  // profile has not opted into the projects model yet (no projects/ folder).
  if (req.method === 'POST' && url.pathname === '/web/projects') {
    const verifySecret = secrets.WEB_VERIFY_SECRET || secrets.AGENT_SECRET;
    const auth = req.headers['authorization'] || '';
    if (!verifySecret || auth !== `Bearer ${verifySecret}`) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const { username } = body || {};
    if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username' });
    // Lazy require so this file still loads on branches where the projects model
    // has not landed yet — a missing module degrades to an empty list, not a crash.
    try {
      const { listProjects } = require('../projects');
      const { userWorkDir } = require('../data-paths');
      const projects = listProjects(userWorkDir(username)).map(p => ({
        id: p.id, name: p.name, type: p.type, label: p.label, lastAt: p.lastAt || 0,
      }));
      return json(res, 200, { projects });
    } catch (e) {
      return json(res, 200, { projects: [], note: 'projects model unavailable' });
    }
  }

  // ── POST /web/project-create — create a project from an external frontend ──
  // Symmetric to POST /web/projects (list): the Cloudflare session-manager worker
  // POSTs {username, name, type?} + shared bearer, and we create the project on the
  // SINGLE source of truth (projects.js / on-disk projects/ folder). This is also
  // the opt-in action — creating the first project rolls out the projects/ folder,
  // switching the profile onto the project model. Deliberate and reversible (rm the
  // folder). type must be a known key (recruiting|expo|generic); a bare name with a
  // "recruiting: X" prefix is also parsed by createProject. Empty type → generic.
  if (req.method === 'POST' && url.pathname === '/web/project-create') {
    const verifySecret = secrets.WEB_VERIFY_SECRET || secrets.AGENT_SECRET;
    const auth = req.headers['authorization'] || '';
    if (!verifySecret || auth !== `Bearer ${verifySecret}`) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const { username, name, type } = body || {};
    if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username' });
    const trimmed = (name || '').trim();
    if (!trimmed || trimmed.length > 120) return json(res, 400, { error: 'invalid name' });
    const ALLOWED_TYPES = ['recruiting', 'expo', 'generic'];
    if (type && !ALLOWED_TYPES.includes(type)) return json(res, 400, { error: 'invalid type' });
    try {
      const { createProject } = require('../projects');
      const { userWorkDir } = require('../data-paths');
      // type given → structured {type,name}; otherwise let createProject parse any
      // "recruiting: X"-style prefix out of the bare name (defaults to generic).
      const input = type ? { type, name: trimmed } : trimmed;
      const meta = createProject(userWorkDir(username), input);
      return json(res, 200, { project: { id: meta.id, name: meta.name, type: meta.type, label: meta.label, lastAt: meta.lastAt || 0 } });
    } catch (e) {
      return json(res, 500, { error: 'project create failed', detail: String(e && e.message || e) });
    }
  }

  // ── POST /web/reproject-preview — rebuild the project structure proposal ──
  // Bearer twin of the MCP reproject_preview tool, exposed so the web UI can
  // offer the "⟳ Переструктурировать проекты" button. POSTs {username, criteria?}
  // + shared bearer; runs the CHEAP-model classification (gemini-2.5-flash default,
  // never Claude) and returns the proposed structure + markdown report. NON-
  // destructive; the plan is saved to projects/.reproject-state.json for the
  // follow-up adjust/apply/revert endpoints. Long-running (~10-60s) — the caller
  // waits on the HTTP response, no streaming.
  if (req.method === 'POST' && url.pathname === '/web/reproject-preview') {
    const verifySecret = secrets.WEB_VERIFY_SECRET || secrets.AGENT_SECRET;
    const auth = req.headers['authorization'] || '';
    if (!verifySecret || auth !== `Bearer ${verifySecret}`) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const { username, criteria } = body || {};
    if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username' });
    try {
      const { userWorkDir } = require('../data-paths');
      const reproject = require('../reproject');
      const out = await reproject.preview(userWorkDir(username), { criteria, now: Date.now() });
      if (out.error) return json(res, 200, { error: out.error });
      return json(res, 200, {
        plan: out.plan,
        report: out.report,
        totalSessions: out.plan.totalSessions,
        projectCount: out.plan.projects.length,
        unassigned: out.plan.unassigned.length,
        warnings: out.plan.warnings,
      });
    } catch (e) {
      return json(res, 500, { error: 'reproject preview failed', detail: String(e && e.message || e) });
    }
  }

  // ── POST /web/reproject-adjust — edit the saved plan manually ─────────────
  // Body: {username, moves?: [{sessionId,toCluster,name?,type?}], renames?:
  // [{cluster,name?,type?}]}. Edits the saved plan in place (nothing moves on
  // disk), re-renders the report. Returns the updated plan+report.
  if (req.method === 'POST' && url.pathname === '/web/reproject-adjust') {
    const verifySecret = secrets.WEB_VERIFY_SECRET || secrets.AGENT_SECRET;
    const auth = req.headers['authorization'] || '';
    if (!verifySecret || auth !== `Bearer ${verifySecret}`) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const { username, moves, renames } = body || {};
    if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username' });
    try {
      const { userWorkDir } = require('../data-paths');
      const reproject = require('../reproject');
      const out = reproject.adjustPlan(userWorkDir(username), { moves: moves || [], renames: renames || [] }, { now: Date.now() });
      if (out.error) return json(res, 200, { error: out.error });
      return json(res, 200, { adjusted: true, plan: out.plan, report: out.report, warnings: out.plan.warnings });
    } catch (e) {
      return json(res, 500, { error: 'reproject adjust failed', detail: String(e && e.message || e) });
    }
  }

  // ── POST /web/reproject-apply — apply the saved plan (reversible) ─────────
  // Body: {username, confirm:boolean}. confirm=false → dry-run (actions preview),
  // confirm=true → re-tag sessions to their planned projects, write the ledger.
  if (req.method === 'POST' && url.pathname === '/web/reproject-apply') {
    const verifySecret = secrets.WEB_VERIFY_SECRET || secrets.AGENT_SECRET;
    const auth = req.headers['authorization'] || '';
    if (!verifySecret || auth !== `Bearer ${verifySecret}`) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const { username, confirm } = body || {};
    if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username' });
    try {
      const { userWorkDir } = require('../data-paths');
      const reproject = require('../reproject');
      const state = reproject.loadState(userWorkDir(username));
      if (!state || !state.plan) return json(res, 200, { error: 'no saved plan — run preview first' });
      const res_ = reproject.applyPlan(userWorkDir(username), state.plan, { dryRun: !confirm, now: Date.now() });
      return json(res, 200, {
        applied: !!confirm,
        dryRun: res_.dryRun,
        sessionsMoved: res_.moves,
        projectsAffected: state.plan.projects.length,
        ledgerWritten: res_.ledgerWritten,
      });
    } catch (e) {
      return json(res, 500, { error: 'reproject apply failed', detail: String(e && e.message || e) });
    }
  }

  // ── POST /web/reproject-revert — undo the last apply ──────────────────────
  if (req.method === 'POST' && url.pathname === '/web/reproject-revert') {
    const verifySecret = secrets.WEB_VERIFY_SECRET || secrets.AGENT_SECRET;
    const auth = req.headers['authorization'] || '';
    if (!verifySecret || auth !== `Bearer ${verifySecret}`) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const { username } = body || {};
    if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username' });
    try {
      const { userWorkDir } = require('../data-paths');
      const reproject = require('../reproject');
      const out = reproject.revertPlan(userWorkDir(username), { now: Date.now() });
      return json(res, 200, out);
    } catch (e) {
      return json(res, 500, { error: 'reproject revert failed', detail: String(e && e.message || e) });
    }
  }

  // ── POST /web/sessions-list — authoritative session list for external UIs ─
  // Same delegation pattern as /web/verify & /web/projects. The Cloudflare
  // session-manager worker (app.trainedassist.store) POSTs {username, limit} +
  // shared bearer and gets back the profile's REAL sessions — the same ones the
  // bot writes to disk on every Telegram turn (session-store). Without this the
  // worker only ever showed its own Durable-Object demo/imported sessions, so a
  // user's Telegram dialogs never appeared. Single source of truth = disk.
  if (req.method === 'POST' && url.pathname === '/web/sessions-list') {
    const verifySecret = secrets.WEB_VERIFY_SECRET || secrets.AGENT_SECRET;
    const auth = req.headers['authorization'] || '';
    if (!verifySecret || auth !== `Bearer ${verifySecret}`) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const { username, limit } = body || {};
    if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username' });
    try {
      const { listSessionsFor } = require('../web-routes');
      return json(res, 200, { sessions: listSessionsFor(username, limit || 30) });
    } catch (e) {
      return json(res, 200, { sessions: [], note: 'session store unavailable' });
    }
  }

  // ── POST /web/session-get — full session (messages) for external UIs ──────
  if (req.method === 'POST' && url.pathname === '/web/session-get') {
    const verifySecret = secrets.WEB_VERIFY_SECRET || secrets.AGENT_SECRET;
    const auth = req.headers['authorization'] || '';
    if (!verifySecret || auth !== `Bearer ${verifySecret}`) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const { username, id } = body || {};
    if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username' });
    try {
      const { getSessionFor } = require('../web-routes');
      const session = getSessionFor(username, id);
      if (!session) return json(res, 404, { error: 'session not found' });
      return json(res, 200, { session });
    } catch (e) {
      return json(res, 500, { error: 'session read failed' });
    }
  }

  // ── POST /web/session-trace — full working log (reasoning/tools) for UIs ──
  // Bearer twin of GET /web/session/:id/trace for external frontends (the
  // Cloudflare worker can't hold a WEB_JWT cookie). Same delegation pattern as
  // /web/session-get. Returns {ok:true, ...trace} or {ok:false, error, engine}.
  if (req.method === 'POST' && url.pathname === '/web/session-trace') {
    const verifySecret = secrets.WEB_VERIFY_SECRET || secrets.AGENT_SECRET;
    const auth = req.headers['authorization'] || '';
    if (!verifySecret || auth !== `Bearer ${verifySecret}`) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const { username, id } = body || {};
    if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username' });
    try {
      const { getTraceFor } = require('../web-routes');
      const trace = getTraceFor(username, id);
      return json(res, 200, trace.ok
        ? { ok: true, engine: trace.engine, sessionId: trace.sessionId, events: trace.events, byMessage: trace.byMessage, ttlMs: trace.ttlMs }
        : { ok: false, error: trace.error, engine: trace.engine || null });
    } catch (e) {
      return json(res, 500, { error: 'session trace failed' });
    }
  }

  // ── POST /web/intake-file-bearer — store one web attachment durably ──────
  // The Cloudflare worker owns browser uploads first. Before a real run/reply it
  // copies each file here so the agent can materialize it into media/intake and
  // hand the model a real local path. Auth uses the same WEB_VERIFY/AGENT bearer.
  if (req.method === 'POST' && url.pathname === '/web/intake-file-bearer') {
    const verifySecret = secrets.WEB_VERIFY_SECRET || secrets.AGENT_SECRET;
    const auth = req.headers['authorization'] || '';
    if (!verifySecret || auth !== `Bearer ${verifySecret}`) return json(res, 401, { error: 'unauthorized' });
    const username = req.headers['x-username'] || '';
    const id = req.headers['x-file-id'] || '';
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username' });
    if (!/^[a-f0-9]{16,64}$/.test(id)) return json(res, 400, { error: 'invalid file id' });
    let buf;
    try { buf = await readBodyBuffer(req, 3 * 1024 * 1024); }
    catch { return json(res, 413, { error: 'file too large' }); }
    if (!buf.length) return json(res, 400, { error: 'empty file' });
    const rawName = decodeURIComponent(req.headers['x-filename'] || 'file');
    const safeName = path.basename(rawName).replace(/[^a-zA-Z0-9._\-() ]/g, '_').slice(0, 200);
    const mime = req.headers['content-type'] || 'application/octet-stream';
    const { userWorkDir } = require('../data-paths');
    const storeDir = path.join(userWorkDir(username), 'media', 'intake-store', id);
    try {
      fs.mkdirSync(storeDir, { recursive: true });
      fs.writeFileSync(path.join(storeDir, 'data'), buf, { mode: 0o600 });
      fs.writeFileSync(path.join(storeDir, 'meta.json'), JSON.stringify({ name: safeName, mime, size: buf.length, buffered: true }), { mode: 0o600 });
    } catch (e) {
      return json(res, 503, { error: 'attachment store failed' });
    }
    return json(res, 200, { id, name: safeName, mime, size: buf.length });
  }

  // ── POST /web/run-bearer — start a task from an external frontend (bearer) ─
  // The write-side twin of /web/sessions-list: an external UI (the Cloudflare
  // session-manager worker at app.trainedassist.store) can't hold a WEB_JWT
  // cookie, so it POSTs {username, task} + the shared bearer secret and we run a
  // REAL task for that profile, streaming SSE back exactly like the cookie-authed
  // /web/run. Without this the worker had no way to WRITE to the agent — its
  // reply/run went to a local demo echo — so a user's message on the web UI never
  // reached the agent ("agent doesn't answer"). checkOrigin is skipped on purpose:
  // the request comes server-to-server from the worker, not a browser, and the
  // bearer secret is the trust boundary here (same as verify/sessions-list).
  if (req.method === 'POST' && url.pathname === '/web/run-bearer') {
    const verifySecret = secrets.WEB_VERIFY_SECRET || secrets.AGENT_SECRET;
    const auth = req.headers['authorization'] || '';
    if (!verifySecret || auth !== `Bearer ${verifySecret}`) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const { username, task, sessionId, projectId, fileRefs, requestId } = body || {};
    if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username' });
    if (requestId != null && !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) return json(res, 400, { error: 'invalid requestId' });
    const refs = Array.isArray(fileRefs) ? fileRefs : [];
    const taskText = typeof task === 'string' ? task.trim() : '';
    if (!taskText && !refs.length) return json(res, 400, { error: 'task or attachment required' });
    if (projectId != null && !require('../valid-project-id').isValidProjectId(projectId)) return json(res, 400, { error: 'invalid projectId' });
    const { streamWebTask, prepareWebTaskFiles, claimWebMutation } = require('../web-routes');
    let prepared;
    try { prepared = prepareWebTaskFiles(username, taskText, refs); }
    catch (e) { return json(res, e.statusCode || 503, { error: e.message || 'attachment preparation failed' }); }
    const sid = (sessionId && /^[a-zA-Z0-9_-]+$/.test(sessionId)) ? sessionId : null;
    // Exact-session Web runs mint the new id BEFORE the receipt, so a duplicate
    // requestId arriving while the first run is still going gets the id to
    // navigate to (was sessionId:null until the run finished).
    const { webCanaryEnabled, newWebSessionId } = require('../core/web-conversation');
    const newSessionId = !sid && webCanaryEnabled(username) ? newWebSessionId() : null;
    let claim;
    try { claim = claimWebMutation(username, requestId || null, { kind: 'run', sessionId: sid || newSessionId }); }
    catch { return json(res, 503, { error: 'could not persist mutation receipt' }); }
    if (claim.invalid) return json(res, 400, { error: 'invalid requestId' });
    if (!claim.claimed) return json(res, 409, {
      error: 'duplicate request already accepted', duplicate: true,
      requestId, state: claim.receipt?.state || 'accepted', sessionId: claim.receipt?.sessionId || null,
    });
    if (prepared.fileRefs.length) {
      const { USERS_ROOT } = require('../data-paths');
      const released = require('../intake-media-retention').releaseIntakeRefs(
        USERS_ROOT, username, prepared.fileRefs.map(ref => ref.id),
        { releaseSource: 'web', requestId: requestId || null }
      );
      if (released.failed) console.warn('[web-media] failed to release %d original ref(s)', released.failed);
    }
    return streamWebTask({
      req, res, secrets, username, task: prepared.task, sessionId: sid, newSessionId,
      projectId: projectId || null, fileRefs: prepared.fileRefs, requestId: requestId || null,
    });
  }

  // ── POST /web/reply-bearer — resume a session from an external frontend ────
  // Same as /web/run-bearer but targets an existing session id. This is the exact
  // path that fixes the reported bug: replying to a real Telegram/agent session
  // from the web UI (that session lives on the agent's disk, never in the worker's
  // Durable Object, so the worker's local lookup 404'd and the user saw nothing).
  if (req.method === 'POST' && url.pathname === '/web/reply-bearer') {
    const verifySecret = secrets.WEB_VERIFY_SECRET || secrets.AGENT_SECRET;
    const auth = req.headers['authorization'] || '';
    if (!verifySecret || auth !== `Bearer ${verifySecret}`) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const { username, id, message, fileRefs, requestId } = body || {};
    if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username' });
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) return json(res, 400, { error: 'invalid session id' });
    if (requestId != null && !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) return json(res, 400, { error: 'invalid requestId' });
    const refs = Array.isArray(fileRefs) ? fileRefs : [];
    const messageText = typeof message === 'string' ? message.trim() : '';
    if (!messageText && !refs.length) return json(res, 400, { error: 'message or attachment required' });
    const { streamWebTask, prepareWebTaskFiles, claimWebMutation, getSessionFor } = require('../web-routes');
    // A reply targets an EXISTING dialog. An unknown id used to start a silent
    // new session under a client-chosen name (exact-session runs never heal
    // onto a pointer) — the UI then showed an answer in a dialog nobody opened.
    if (!getSessionFor(username, id)) return json(res, 404, { error: 'session not found', id });
    let prepared;
    try { prepared = prepareWebTaskFiles(username, messageText, refs); }
    catch (e) { return json(res, e.statusCode || 503, { error: e.message || 'attachment preparation failed' }); }
    let claim;
    try { claim = claimWebMutation(username, requestId || null, { kind: 'reply', sessionId: id }); }
    catch { return json(res, 503, { error: 'could not persist mutation receipt' }); }
    if (claim.invalid) return json(res, 400, { error: 'invalid requestId' });
    if (!claim.claimed) return json(res, 409, {
      error: 'duplicate request already accepted', duplicate: true,
      requestId, state: claim.receipt?.state || 'accepted', sessionId: claim.receipt?.sessionId || id,
    });
    if (prepared.fileRefs.length) {
      const { USERS_ROOT } = require('../data-paths');
      const released = require('../intake-media-retention').releaseIntakeRefs(
        USERS_ROOT, username, prepared.fileRefs.map(ref => ref.id),
        { releaseSource: 'web', requestId: requestId || null }
      );
      if (released.failed) console.warn('[web-media] failed to release %d original ref(s)', released.failed);
    }
    return streamWebTask({
      req, res, secrets, username, task: prepared.task, sessionId: id,
      fileRefs: prepared.fileRefs, requestId: requestId || null,
    });
  }

  // ── POST /web/stop-bearer — stop a running task from an external frontend ──
  // The write-side twin of /web/reply-bearer for the Stop button: without this,
  // the Cloudflare session-manager worker had no way to SIGTERM a real agent
  // session (it could only mark its own local demo session idle), so "Остановить
  // выполнение" silently did nothing for real Telegram/agent-backed sessions.
  if (req.method === 'POST' && url.pathname === '/web/stop-bearer') {
    const verifySecret = secrets.WEB_VERIFY_SECRET || secrets.AGENT_SECRET;
    const auth = req.headers['authorization'] || '';
    if (!verifySecret || auth !== `Bearer ${verifySecret}`) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const { username, id } = body || {};
    if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username' });
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) return json(res, 400, { error: 'invalid session id' });
    const { stopSessionFor } = require('../web-routes');
    const stopped = stopSessionFor(username, id);
    return stopped
      ? json(res, 200, { ok: true, id })
      : json(res, 409, { ok: false, error: 'session is not running', id });
  }

  // ── POST /web/auth — login, returns httpOnly JWT cookie ──────────────────
  if (req.method === 'POST' && url.pathname === '/web/auth') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const { username, password } = body || {};
    if (!username || !password || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username or password' });
    if (!secrets.WEB_JWT_SECRET) return json(res, 503, { error: 'web auth not configured' });
    if (!checkPassword(username, password)) return json(res, 401, { error: 'invalid username or password' });
    const token = signJwt(username, secrets.WEB_JWT_SECRET);
    setTokenCookie(res, token);
    return json(res, 200, { ok: true, username });
  }

  // ── POST /web/logout — clear the auth cookie ─────────────────────────────
  if (req.method === 'POST' && url.pathname === '/web/logout') {
    clearTokenCookie(res);
    return json(res, 200, { ok: true });
  }

  // ── GET /web, /web/, /web/<asset> — serve the vendored web UI (public) ────
  if (req.method === 'GET' && (url.pathname === '/web' || url.pathname === '/web/' ||
      /^\/web\/(index\.html|login\.html|app\.js|style\.css)$/.test(url.pathname))) {
    const WEB_UI_DIR = path.join(__dirname, '..', 'web-ui');
    const CT = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    let file = url.pathname.replace(/^\/web\/?/, '') || 'index.html';
    const full = path.join(WEB_UI_DIR, file);
    // Defence-in-depth: never serve outside the web-ui dir
    if (!path.resolve(full).startsWith(path.resolve(WEB_UI_DIR))) return json(res, 400, { error: 'bad path' });
    try {
      const buf = fs.readFileSync(full);
      res.writeHead(200, { 'Content-Type': CT[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(buf);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
    return;
  }

  return false;
}

module.exports = { handleWeb };
