'use strict';
// Read-only / profile API routes behind the AGENT_SECRET Bearer gate, moved verbatim
// from server.js: /capabilities, /skills, /health-full, /analytics, /stats,
// /tasks/running, /projects, /project-decision, /sessions (+archive, /:id), /files,
// /files/read, /publish/pages (GET/DELETE). Same dispatcher pattern as handlers/internal.js:
// host helpers arrive in ctx; returns false when no route matched.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, execFile } = require('child_process');
const dataPaths = require('../data-paths');
const workspacePath = dataPaths.workspacePath;
const { listSessions, getSession: getSessionData, archiveSessions, needsSummary, setSummary } = require('../session-store');
const { generateSummary } = require('../session-summary');
const { getResumeStats } = require('../resume-stats');
const { computeSkillsList } = require('../capabilities-skills');
const { presentSiblings } = require('../skill-siblings');

async function handleApi(req, url, res, ctx) {
  const { json, readBody, secrets } = ctx;

    // GET /capabilities?userId=XXX — list services with tokens on this machine
    if (req.method === 'GET' && url.pathname === '/capabilities') {
      const userId = url.searchParams.get('userId') || '';
      if (!userId || !/^[a-zA-Z0-9_-]{1,64}$/.test(userId)) return json(res, 400, { error: 'invalid userId' });
      const tokensDir = path.join(os.homedir(), 'agent-tokens', userId);
      const SKIP = new Set(['.secrets_log', 'gdrive-seen', 'gdrive-catalog', 'gdrive-catalog.json']);
      let capabilities = [];
      if (fs.existsSync(tokensDir)) {
        capabilities = fs.readdirSync(tokensDir).filter(f => !SKIP.has(f) && !f.startsWith('.'));
      }
      // skills[] — MCP tool categories available on this agent: core tools plus the
      // tools of every sibling domain repo checked out on this host (#942, #1470).
      const toolsDir = path.join(__dirname, '..', 'mcp-skills', 'tools');
      const siblingsHere = presentSiblings();
      const toolFilenames = [toolsDir, ...siblingsHere.map(sib => path.join(path.dirname(sib.indexPath), 'tools'))]
        .flatMap(dir => (fs.existsSync(dir) ? fs.readdirSync(dir) : []));
      const skills = computeSkillsList(toolFilenames,
        siblingsHere.some(sib => sib.id === 'hh'), siblingsHere.some(sib => sib.id === 'freelance'));
      const upsell_text = process.env.AGENT_UPSELL_TEXT ||
        'За HH-рекрутингом, налогами, задачами Weeek и другим — обратитесь к @super_personal_assistant_bot';
      return json(res, 200, { capabilities, skills, upsell_text });
    }

    // GET /skills — list all available MCP skills (for bot /skills command)
    if (req.method === 'GET' && url.pathname === '/skills') {
      const { tools: metaTools } = require('../mcp-skills/tools/00-meta.js');
      const { skills } = await metaTools.list_skills.handler();
      return json(res, 200, { skills });
    }

    // GET /health-full — runs actual claude call, verifies OAuth end-to-end
    if (req.method === 'GET' && url.pathname === '/health-full') {
      const start = Date.now();
      const { ANTHROPIC_API_KEY: _stripped, ...cleanEnv } = process.env;
      try {
        const output = await new Promise((resolve, reject) => {
          execFile('claude', ['--dangerously-skip-permissions', '--print', 'say: pipeline-ok'], {
            env: cleanEnv,
            timeout: 45000,
          }, (err, stdout, stderr) => {
            if (err) return reject(new Error((stdout || stderr || err.message).trim().slice(0, 300)));
            resolve(stdout.trim());
          });
        });
        const ok = output.toLowerCase().includes('pipeline-ok');
        return json(res, ok ? 200 : 500, { ok, output: output.slice(0, 200), auth: 'oauth', latencyMs: Date.now() - start });
      } catch (err) {
        return json(res, 500, { ok: false, error: err.message, latencyMs: Date.now() - start });
      }
    }

    // GET /analytics — aggregated token/cost usage across all users
    if (req.method === 'GET' && url.pathname === '/analytics') {
      const { getUsageLog } = require('../usage-store');
      // Usage logs live in each profile's workspace (USERS_ROOT/<u>/usage.json),
      // not the legacy SYSTEM_ROOT/sessions tree.
      const totals = { tasks: 0, input: 0, output: 0, cost_usd: 0 };
      const byDate = {};   // date → { model → { input, output, cost, tasks } }
      const byUser = {};   // username → { tasks, input, output, cost_usd }
      try {
        for (const username of dataPaths.listProfiles()) {
          const workDir = dataPaths.userWorkDir(username);
          if (!fs.statSync(workDir).isDirectory()) continue;
          const log = getUsageLog(workDir);
          if (!log || !log.length) continue;
          const u = byUser[username] = { tasks: 0, input: 0, output: 0, cost_usd: 0 };
          for (const entry of log) {
            const inp = entry.input_tokens || 0;
            const out = entry.output_tokens || 0;
            const cost = entry.cost_usd || 0;
            const model = entry.model || (entry.engine === 'opencode' ? 'opencode' : 'claude');
            const date = new Date(entry.at || 0).toISOString().slice(0, 10);
            totals.tasks += 1; totals.input += inp; totals.output += out; totals.cost_usd += cost;
            u.tasks += 1; u.input += inp; u.output += out; u.cost_usd += cost;
            if (!byDate[date]) byDate[date] = {};
            if (!byDate[date][model]) byDate[date][model] = { input: 0, output: 0, cost: 0, tasks: 0 };
            byDate[date][model].input += inp;
            byDate[date][model].output += out;
            byDate[date][model].cost += cost;
            byDate[date][model].tasks += 1;
          }
        }
      } catch (e) { console.error('[analytics]', e.message); }
      return json(res, 200, { totals, by_date: byDate, by_user: byUser });
    }

    if (req.method === 'GET' && url.pathname === '/stats') {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const cpus = os.cpus();
      const load = os.loadavg();
      let disk = null;
      try {
        const df = execSync('df -BM / --output=size,used,avail', { encoding: 'utf8' });
        const [, line] = df.trim().split('\n');
        const [size, used, avail] = line.trim().split(/\s+/).map(s => parseInt(s));
        disk = { totalMb: size, usedMb: used, availMb: avail };
      } catch { /* ignore */ }
      return json(res, 200, {
        cpu: { cores: cpus.length, load1m: load[0], load5m: load[1] },
        memory: { totalMb: Math.round(totalMem / 1048576), usedMb: Math.round(usedMem / 1048576), freeMb: Math.round(freeMem / 1048576) },
        disk,
        uptime: process.uptime(),
        resume: getResumeStats(), // #1240: native vs fallback post-restart resumes
      });
    }

    // GET /tasks/running?username=xxx — ground truth for whether a Claude
    // session is live for this user. The gateway IntakeBuffer polls this to
    // hold new messages for the REAL duration of a run (not just the /run
    // enqueue, which returns 202 immediately). Reading live state here — rather
    // than trusting a fire-and-forget completion callback — means a dropped
    // packet can't trap the buffer; the next poll self-heals.
    if (req.method === 'GET' && url.pathname === '/tasks/running') {
      // chatId-scoped check (epic #1527 PR1): what the gateway's IntakeBuffer
      // alarm poll uses to self-heal a lost run-finished push. acceptedByChat
      // is true from the synchronous runTask entry (before 202) until the run
      // settles — no admission-wait window where a poll would see "idle" and
      // wrongly release the chat's busy hold.
      const chatIdParam = url.searchParams.get('chatId');
      if (chatIdParam != null && chatIdParam !== '') {
        const chatId = Number(chatIdParam);
        if (!Number.isSafeInteger(chatId)) return json(res, 400, { error: 'invalid chatId' });
        const { isChatTaskRunning } = require('../runner');
        return json(res, 200, { running: isChatTaskRunning(chatId), scope: 'chat', chatId });
      }
      const username = url.searchParams.get('username');
      if (!username || !/^[a-zA-Z0-9_-]+$/.test(username))
        return json(res, 400, { error: 'invalid username' });
      // audience scopes which bot's task this checks — omitted -> 'default' only,
      // never "any audience" (#1302 §3.2/§2).
      const audience = url.searchParams.get('audience');
      if (audience != null && !/^[a-zA-Z0-9_-]{1,32}$/.test(audience))
        return json(res, 400, { error: 'invalid audience' });
      const { isTaskRunning } = require('../runner');
      return json(res, 200, { running: isTaskRunning(username, audience || null), audience: audience || 'default' });
    }

    // GET /projects?username=xxx — TYPED project list (projects.js), most-used first
    // (session count desc, recency as tiebreaker — matches /project-decision's ordering
    // so index-based lookups like tg-bot's pp:<i> stay in sync between the two endpoints).
    // Single source of truth: the on-disk projects/ folder. Replaces the old raw-subdir
    // listing (issue #517 convergence — no more folder-name picker).
    if (req.method === 'GET' && url.pathname === '/projects') {
      const username = url.searchParams.get('username');
      if (!username || !/^[a-zA-Z0-9_-]+$/.test(username))
        return json(res, 400, { error: 'invalid username' });
      // audience scopes the list to the calling bot/surface (see AUDIENCE-SCOPE-SPEC);
      // omitted -> 'default', matching every project created before this feature existed.
      const audience = url.searchParams.get('audience') || 'default';

      const workDir = workspacePath(username);
      try {
        const { listProjects, sortByUsage } = require('../projects');
        const sessions = require('../session-store');
        const countByProject = {};
        for (const s of sessions.listSessions(workDir, 1000, audience)) {
          if (s.projectId) countByProject[s.projectId] = (countByProject[s.projectId] || 0) + 1;
        }
        const projects = sortByUsage(listProjects(workDir, audience), countByProject).map(p => ({
          id: p.id, name: p.name, type: p.type, label: p.label || p.name, lastAt: p.lastAt || 0,
        }));
        return json(res, 200, { projects });
      } catch (e) {
        return json(res, 200, { projects: [], note: 'projects model unavailable' });
      }
    }

    // GET /project-decision?username=xxx&chatId=yyy[&task=...] — what the gateway should do when a
    // NEW dialog starts (issue #517): {action:'auto'|'create'|'ask', choices:[{id,name,label}], active}.
    // 'ask' -> gateway renders the inline picker and defers the task until the user chooses.
    // When `task` is provided and it's a project-agnostic quick command (engine switch, agent info,
    // etc.), returns action:'auto' immediately — no picker shown, task goes straight to /run.
    if (req.method === 'GET' && url.pathname === '/project-decision') {
      const username = url.searchParams.get('username');
      const chatId = url.searchParams.get('chatId') || null;
      // audience scopes the decision to the calling bot/surface (see AUDIENCE-SCOPE-SPEC);
      // omitted -> 'default', matching every project/session created before this feature existed.
      const audience = url.searchParams.get('audience') || 'default';
      const threadIdParam = Number(url.searchParams.get('threadId'));
      const decisionThreadId = Number.isInteger(threadIdParam) && threadIdParam > 0 ? threadIdParam : null;
      if (!username || !/^[a-zA-Z0-9_-]+$/.test(username))
        return json(res, 400, { error: 'invalid username' });

      // Quick commands don't belong to any project — skip picker entirely.
      // Regex mirrors ENGINE_SWITCH_INTENT + other global slash commands from runner.js.
      const taskParam = (url.searchParams.get('task') || '').trim();
      const GLOBAL_QUICK_COMMAND = /^\/?switch\s*2\s*(klod|codex|opencode|клод|кодекс)(?:@\S+)?(?=\s|$)|(?:переключ\S*|switch)\s+(?:меня\s+)?(?:на|to)\s+(klod|claude|codex|opencode|клод|кодекс)(?=\s|$)|^\/(?:get_agent_info|agent_info|oc_\S+|get_webpass|webpass|вебпароль|info)(?:@\S+)?(?=\s|$)/i;
      if (taskParam && GLOBAL_QUICK_COMMAND.test(taskParam)) {
        return json(res, 200, { action: 'quick', choices: [], active: null });
      }

      const workDir = workspacePath(username);
      try {
        const projects = require('../projects');
        const sessions = require('../session-store');

        // Session counts per project (metadata read, cheap) — computed up front so
        // decideNewSessionProject can order choices by usage (most-used first), not
        // just by recency.
        const allSess = sessions.listSessions(workDir, 1000, audience);
        const countByProject = {};
        for (const s of allSess) if (s.projectId) countByProject[s.projectId] = (countByProject[s.projectId] || 0) + 1;

        const d = projects.decideNewSessionProject(workDir, chatId, countByProject, audience, decisionThreadId);
        // No project-mismatch classifier any more: the bot never asks «какой проект?»
        // (owner decision 2026-09-26). Misfiled sessions are regrouped later by reproject.
        const out = { action: d.action, active: d.active || null, pinned: d.pinned ? d.project.id : null };

        const enrich = (p) => ({
          id: p.id, name: p.name, type: p.type || 'generic', label: p.label || p.name,
          summary: p.summary || null,
          sessionCount: countByProject[p.id] || 0,
          lastAt: p.lastAt || 0,
        });
        if (d.action === 'auto') out.choices = [enrich(d.project)];
        else out.choices = [];
        return json(res, 200, out);
      } catch (e) {
        return json(res, 200, { action: 'create', choices: [], active: null, note: 'projects model unavailable' });
      }
    }

    // GET /sessions?username=xxx[&limit=N][&audience=xxx] — list sessions for a user
    if (req.method === 'GET' && url.pathname === '/sessions') {
      const username = url.searchParams.get('username');
      if (!username || !/^[a-zA-Z0-9_-]+$/.test(username))
        return json(res, 400, { error: 'invalid username' });
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10), 50);
      // audience scopes the list to the calling bot/surface (see AUDIENCE-SCOPE-SPEC);
      // omitted -> 'default', matching every session created before this feature existed.
      const audience = url.searchParams.get('audience') || 'default';
      const workDir = workspacePath(username);
      let sessionList = listSessions(workDir, limit, audience);
      // Lazily backfill durable summaries so external consumers (Telegram gateway,
      // web UI) get a meaningful {title, gist} — not a raw first-message truncation.
      // Mirrors the /sessions lazy-generation in runner.runQuickAnswer; this is the
      // HTTP entry point those UIs actually hit, so the class lives here too.
      const orKey = secrets.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;
      const stale = sessionList.filter(s => needsSummary(s));
      if (stale.length && orKey) {
        await Promise.all(stale.map(async (s) => {
          try {
            const full = getSessionData(workDir, s.id);
            if (!full) return;
            const sum = await generateSummary(full.messages, { apiKey: orKey });
            if (sum) setSummary(workDir, s.id, sum, s.messageCount);
          } catch { /* best-effort; fall back to raw topic */ }
        }));
        sessionList = listSessions(workDir, limit, audience); // reload with fresh summaries
      }
      // Resolve projectId -> projectName so the gateway/web session lists can label
      // each dialog by its typed project (issue #517).
      try {
        const { getProject } = require('../projects');
        const nameCache = {};
        sessionList = sessionList.map(s => {
          if (!s.projectId) return s;
          if (!(s.projectId in nameCache)) {
            const p = getProject(workDir, s.projectId);
            nameCache[s.projectId] = p ? p.name : null;
          }
          return { ...s, projectName: nameCache[s.projectId] };
        });
      } catch { /* projects model unavailable — leave list as-is */ }
      return json(res, 200, { sessions: sessionList });
    }

    // POST /sessions/archive — remove sessions from the index
    if (req.method === 'POST' && url.pathname === '/sessions/archive') {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid json' }); }
      const { username, sessionIds } = payload;
      if (!username || !/^[a-zA-Z0-9_-]+$/.test(username))
        return json(res, 400, { error: 'invalid username' });
      if (!Array.isArray(sessionIds) || sessionIds.length === 0)
        return json(res, 400, { error: 'sessionIds must be a non-empty array' });
      const workDir = workspacePath(username);
      const archived = archiveSessions(workDir, sessionIds);
      return json(res, 200, { archived });
    }

    // GET /sessions/:id?username=xxx — get full session with messages
    const sessionMatch = url.pathname.match(/^\/sessions\/([a-zA-Z0-9_-]+)$/);
    if (req.method === 'GET' && sessionMatch) {
      const id = sessionMatch[1];
      const username = url.searchParams.get('username');
      if (!username || !/^[a-zA-Z0-9_-]+$/.test(username))
        return json(res, 400, { error: 'invalid username' });
      const workDir = workspacePath(username);
      const session = getSessionData(workDir, id);
      if (!session) return json(res, 404, { error: 'not found' });
      return json(res, 200, session);
    }

    // GET /files?username=xxx&path=relative — list directory contents
    if (req.method === 'GET' && url.pathname === '/files') {
      const username = url.searchParams.get('username');
      const relPath  = url.searchParams.get('path') || '';
      if (!username || !/^[a-zA-Z0-9_-]+$/.test(username))
        return json(res, 400, { error: 'invalid username' });

      const workDir = workspacePath(username);
      const target  = path.resolve(path.join(workDir, relPath));
      if (target !== workDir && !target.startsWith(workDir + path.sep))
        return json(res, 400, { error: 'path traversal' });

      try {
        const entries = fs.readdirSync(target, { withFileTypes: true })
          .filter(e => !e.name.startsWith('.')) // hide dotfiles
          .map(e => {
            if (e.isDirectory()) {
              let count = 0;
              try { count = fs.readdirSync(path.join(target, e.name)).filter(n => !n.startsWith('.')).length; } catch {}
              return { name: e.name, type: 'dir', count };
            }
            let size = 0;
            try { size = fs.statSync(path.join(target, e.name)).size; } catch {}
            return { name: e.name, type: 'file', size };
          })
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
        return json(res, 200, { path: relPath, entries });
      } catch (e) {
        return json(res, 404, { error: 'not found' });
      }
    }

    // GET /files/read?username=xxx&path=relative — read a file
    if (req.method === 'GET' && url.pathname === '/files/read') {
      const username = url.searchParams.get('username');
      const relPath  = url.searchParams.get('path') || '';
      if (!username || !/^[a-zA-Z0-9_-]+$/.test(username))
        return json(res, 400, { error: 'invalid username' });

      const workDir = workspacePath(username);
      const target  = path.resolve(path.join(workDir, relPath));
      if (target !== workDir && !target.startsWith(workDir + path.sep))
        return json(res, 400, { error: 'path traversal' });

      const ext = path.extname(target).toLowerCase();
      const READABLE = ['.md', '.json', '.txt', '.log', '.js', '.ts', '.yaml', '.yml', '.toml', '.env'];
      if (!READABLE.includes(ext))
        return json(res, 400, { error: 'not a readable file type' });

      try {
        const raw = fs.readFileSync(target, 'utf8');
        const MAX = 3500;
        return json(res, 200, {
          path: relPath,
          content: raw.length > MAX ? raw.slice(0, MAX) : raw,
          truncated: raw.length > MAX,
          size: raw.length,
        });
      } catch (e) {
        return json(res, 404, { error: 'not found' });
      }
    }

    // GET /publish/pages?username=X — list published pages for a user
    if (req.method === 'GET' && url.pathname === '/publish/pages') {
      const username = url.searchParams.get('username') || '';
      if (!username) return json(res, 400, { error: 'username required' });
      const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
      const indexFile = path.join(dataDir, 'publish-owners', `${username}.json`);
      const pages = fs.existsSync(indexFile)
        ? JSON.parse(fs.readFileSync(indexFile, 'utf8'))
        : [];
      return json(res, 200, { pages });
    }

    // DELETE /publish/pages — delete a page by slug
    if (req.method === 'DELETE' && url.pathname === '/publish/pages') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const { username, slug } = body || {};
      if (!username || !slug) return json(res, 400, { error: 'username and slug required' });

      const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
      const metaFile = path.join(dataDir, 'pages', slug, 'meta.json');
      if (!fs.existsSync(metaFile)) return json(res, 404, { error: 'page not found' });
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (meta.owner !== username) return json(res, 403, { error: 'not your page' });

      fs.rmSync(path.join(dataDir, 'pages', slug), { recursive: true, force: true });

      const indexFile = path.join(dataDir, 'publish-owners', `${username}.json`);
      if (fs.existsSync(indexFile)) {
        const list = JSON.parse(fs.readFileSync(indexFile, 'utf8')).filter(p => p.slug !== slug);
        fs.writeFileSync(indexFile, JSON.stringify(list));
      }
      return json(res, 200, { ok: true });
    }

  return false;
}

module.exports = { handleApi };
