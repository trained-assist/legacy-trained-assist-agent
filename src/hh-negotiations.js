'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHmac } = require('crypto');
const { hhFetch, readActiveVacancies } = require('./hh-utils');
const { hasRealAvailability } = require('./hh-message-prompts');
const { hydrateResumes } = require('./hh-resume');
const { scoreUnscoredCandidates, generateDraftMessages, readAtsConfig } = require('./hh-scoring');
const {
  runProactiveSearch, scoreUnscoredProactiveCandidates,
  loadSchedule, saveSchedule,
} = require('./hh-proactive-search');

const BASE_USERS_DIR = process.env.USERS_DIR ||
  path.join(process.env.HOME || '/home/vova', 'users');

// Whether the recruiter's ATS config carries real (non-placeholder) interview time slots.
// Used by the /hh message flows to decide whether to offer specific-time suggestions.
function hhInterviewConfigAllowsTime(username) {
  try {
    const configFile = path.join(BASE_USERS_DIR, String(username), 'contexts', 'hh', 'ats_config.json');
    if (!fs.existsSync(configFile)) return false;
    let config = JSON.parse(fs.readFileSync(configFile, 'utf8')).value || {};
    if (typeof config === 'string') config = JSON.parse(config);
    return hasRealAvailability(config.interview_config);
  } catch {
    return false;
  }
}

// Fetch negotiations across all active stages for a vacancy (parallel per-state requests).
// Excludes 'discard' (rejected) and 'hired' (done) — only actionable/in-progress candidates.
const HH_REVIEW_STATES = ['response', 'consider', 'phone_interview', 'assessment', 'interview', 'offer'];

// HH exposes negotiation collections named after the ACTION that produced them.
// There is no generic `/negotiations/discard` — real HH returns 404 for it; the
// rejections live in the collection of the action that was applied. A rejection
// can be produced by two actions, so fetch both and union by id:
//   - discard_by_employer    → normal rejection on a still-open vacancy (REJECT_REASON_ACTION)
//   - discard_vacancy_closed → legacy rejections and hh_bulk_reject when a vacancy is closed
// Both are needed: covering only the new action would hide replies on the older
// rejections that started this bug report.
const HH_DISCARD_ACTIONS = ['discard_by_employer', 'discard_vacancy_closed'];

// HH negotiations/messages/background-scoring (moved from server.js, see issue #942 Phase 0).
// Uses the shared HH HTTP client from hh-utils (single implementation, issue #942 P0.4).
// refreshHhToken is still defined inline in server.js (it is not an HTTP client — OAuth
// refresh with secrets) — injected here to avoid a circular require.
// readChatId is also still in server.js (used by many other handlers there).
// getSecretsCache reads server.js's live `_secretsCache` (populated once in main()).
function createHhNegotiations({ refreshHhToken, readChatId, getSecretsCache }) {
  async function fetchAllHhNegotiations(vacancyId, accessToken) {
    const token = { access_token: accessToken };
    const results = await Promise.all(HH_REVIEW_STATES.map(async state => {
      let items = [];
      let page = 0, totalPages = 1;
      do {
        const data = await hhFetch(`/negotiations/${state}?vacancy_id=${vacancyId}&per_page=50&page=${page}`, token);
        items = items.concat(data.items || []);
        totalPages = data.pages ?? 1;
        page++;
        if (page >= 50) { console.warn(`[hh] fetchAllHhNegotiations: hit 50-page cap for state=${state}`); break; }
      } while (page < totalPages);
      return items.map(item => ({ ...item, _state: state }));
    }));
    return hydrateResumes(results.flat(), { access_token: accessToken });
  }

// Fetch discarded (rejected) negotiations for a vacancy. Kept out of
// HH_REVIEW_STATES so rejected candidates never re-enter the review list or the
// scorer; used only to sync post-rejection replies and surface them on the page.
async function fetchDiscardedNegotiations(vacancyId, accessToken) {
  const token = { access_token: accessToken };
  const byId = new Map();
  for (const action of HH_DISCARD_ACTIONS) {
    let page = 0, totalPages = 1;
    do {
      const data = await hhFetch(`/negotiations/${action}?vacancy_id=${vacancyId}&per_page=50&page=${page}`, token);
      for (const item of (data.items || [])) byId.set(item.id, { ...item, _state: 'discard' });
      totalPages = data.pages ?? 1;
      page++;
      if (page >= 20) { console.warn(`[hh] fetchDiscardedNegotiations: hit 20-page cap for ${action}`); break; }
    } while (page < totalPages);
  }
  return [...byId.values()];
}

  // Keyed by vacancy_id — profiles tracking several vacancies (readActiveVacancies)
  // switch between them via /hh/review tabs, and a single shared cache file would
  // thrash on every switch (always a miss against whichever vacancy was cached last),
  // doubling HH API calls for no reason.
  function hhCacheFile(dataDir, username, vacancyId) {
    return path.join(dataDir, 'hh', String(username), `negotiations-cache:${vacancyId}.json`);
  }

  async function getHhNegotiationsWithCache(dataDir, username, vacancyId, accessToken, options = {}) {
    const cacheFile = hhCacheFile(dataDir, username, vacancyId);
    const CACHE_TTL_MS = 5 * 60 * 1000;
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const ageMs = Date.now() - (cached.synced_at || 0);
      if (!options.force && cached.resume_version === 1 && ageMs < CACHE_TTL_MS && String(cached.vacancy_id) === String(vacancyId)) {
        return { negotiations: cached.negotiations, synced_at: cached.synced_at };
      }
    } catch {}
    let negotiations;
    try {
      negotiations = await fetchAllHhNegotiations(vacancyId, accessToken);
    } catch (e) {
      // If HH rejected the token (401/403 oauth_error=token-expired), refresh once and retry.
      // Without this, /hh/review silently goes empty 14 days after every re-auth.
      if (username && /HH(?: API)? 40[13].*token[-_]?expired/i.test(String(e.message || ''))) {
        const fresh = await refreshHhToken(username, getSecretsCache());
        if (fresh) negotiations = await fetchAllHhNegotiations(vacancyId, fresh);
        else throw e;
      } else { throw e; }
    }
    const synced_at = Date.now();
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ resume_version: 1, synced_at, vacancy_id: String(vacancyId), negotiations }), { mode: 0o600 });
      fs.renameSync(tmp, cacheFile);
    } catch (e) { console.error('[hh-cache] write error:', e.message); }
    return { negotiations, synced_at };
  }

  function hhDiscardCacheFile(dataDir, username, vacancyId) {
    return path.join(dataDir, 'hh', String(username), `negotiations-cache:${vacancyId}:discard.json`);
  }

  // Same 5-min TTL as the active-negotiations cache: a review-page reload (e.g. after
  // archiving) must not hit HH again just to re-list discarded candidates.
  async function getHhDiscardedWithCache(dataDir, username, vacancyId, accessToken, options = {}) {
    const cacheFile = hhDiscardCacheFile(dataDir, username, vacancyId);
    const CACHE_TTL_MS = 5 * 60 * 1000;
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const ageMs = Date.now() - (cached.synced_at || 0);
      if (!options.force && String(cached.vacancy_id) === String(vacancyId) && ageMs < CACHE_TTL_MS) {
        return cached.negotiations;
      }
    } catch {}
    const negotiations = await fetchDiscardedNegotiations(vacancyId, accessToken);
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ synced_at: Date.now(), vacancy_id: String(vacancyId), negotiations }), { mode: 0o600 });
      fs.renameSync(tmp, cacheFile);
    } catch (e) { console.error('[hh-discard-cache] write error:', e.message); }
    return negotiations;
  }

  // Sync HH thread messages to local candidate history.
  // Fetches messages from HH API for negotiations where HH has more messages than we've stored,
  // merges them into local history (deduplicates by HH message ID), stores applicant replies.
  // Capped at 15 negotiations per call to avoid long page loads.
  // options.incremental=true  → only sync candidates where neg.updated_at > last_hh_message_at
  //                              (used in background loop — avoids redundant API calls)
  // options.incremental=false → sync all candidates with messages, capped at options.cap (default 15)
  //                              (used on page load — ensures fresh data, bounded latency)
  // Returns { synced: N, newMessages: M } for sync-log stats.
  async function syncHhMessagesToHistory(dataDir, username, negotiations, accessToken, options = {}) {
    const { incremental = false, cap = 15, maxConcurrent = 4 } = options;
    const candDir = path.join(dataDir, 'hh', String(username), 'candidates');
    try { fs.mkdirSync(candDir, { recursive: true }); } catch {}

    let candidates = negotiations.filter(n => (n.counters?.messages || 0) > 0);

    if (incremental) {
      // Only sync candidates where HH updated_at is newer than our last sync timestamp
      candidates = candidates.filter(neg => {
        const file = path.join(candDir, `${neg.id}.json`);
        try {
          const h = JSON.parse(fs.readFileSync(file, 'utf8'));
          const lastSynced = h.last_hh_message_at || 0;
          const hhUpdated = neg.updated_at ? new Date(neg.updated_at).getTime() : 0;
          return hhUpdated > lastSynced;
        } catch {
          return true; // no file yet → sync
        }
      });
    } else {
      candidates = candidates.slice(0, cap);
    }

    let synced = 0;
    let newMessages = 0;

    // Process in batches to avoid API burst
    for (let i = 0; i < candidates.length; i += maxConcurrent) {
      const batch = candidates.slice(i, i + maxConcurrent);
      await Promise.allSettled(batch.map(async neg => {
        const file = path.join(candDir, `${neg.id}.json`);
        let history = { messages: [], ats_result: null };
        try { history = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
        history.messages = history.messages || [];

        try {
          // Fetch full message thread (HH supports up to 50 per page; paginate if needed)
          let allHhMsgs = [];
          for (let page = 0; ; page++) {
            const data = await hhFetch(`/negotiations/${neg.id}/messages?per_page=50&page=${page}`, { access_token: accessToken });
            const items = (data.items || []).filter(m => m.text);
            allHhMsgs = allHhMsgs.concat(items);
            if (!data.pages || page >= data.pages - 1) break;
          }
          if (!allHhMsgs.length) {
            // No messages yet — still update last_hh_message_at so we skip next time
            history.last_hh_message_at = neg.updated_at ? new Date(neg.updated_at).getTime() : Date.now();
            fs.writeFileSync(file, JSON.stringify(history, null, 2), { mode: 0o600 });
            synced++;
            return;
          }

          const storedIds = new Set(history.messages.map(m => m.hh_id).filter(Boolean));
          let added = 0;
          for (const m of allHhMsgs) {
            if (storedIds.has(m.id)) continue;
            history.messages.push({
              hh_id: m.id,
              role: m.author?.participant_type === 'applicant' ? 'applicant' : 'employer',
              text: m.text,
              timestamp: m.created_at,
            });
            storedIds.add(m.id);
            added++;
          }
          if (added > 0) {
            history.messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
            newMessages += added;
          }
          history.last_hh_message_at = neg.updated_at ? new Date(neg.updated_at).getTime() : Date.now();
          fs.writeFileSync(file, JSON.stringify(history, null, 2), { mode: 0o600 });
          synced++;
        } catch (e) {
          console.error(`[hh-msg-sync] neg ${neg.id}: ${e.message}`);
        }
      }));
    }

    return { synced, newMessages };
  }

  // Background HH scoring: fetch negotiations + score unscored candidates for all users
  // with HH token + active vacancy + ATS config. Runs every 5 min so the review page
  // shows scores immediately without blocking on page open.
  const _hhBgRunning = new Set();

  // Scores one tracked vacancy. Returns the (possibly refreshed) access token so the
  // caller can reuse it for the next vacancy in the loop without refreshing twice.
  async function runHhScoringForVacancy(username, workDir, dataDir, vacancy, accessToken) {
    const { negotiations } = await getHhNegotiationsWithCache(dataDir, username, vacancy.id, accessToken, { force: true });
    // Refresh may have replaced the persisted token; use it for message sync too.
    const currentToken = require('./hh-utils').readHhToken(username);
    accessToken = currentToken?.access_token || accessToken;

    // Sync HH thread messages incrementally — only candidates changed since last sync
    const msgSync = await syncHhMessagesToHistory(dataDir, username, negotiations, accessToken, {
      incremental: true,
      maxConcurrent: 4,
    }).catch(e => { console.error(`[hh-bg] msg-sync error for ${username}/${vacancy.id}:`, e.message); return { synced: 0, newMessages: 0 }; });
    if (msgSync.newMessages > 0) console.log(`[hh-bg] msg-sync ${username}/${vacancy.id}: +${msgSync.newMessages} new messages across ${msgSync.synced} candidates`);

    // Rejected candidates: sync their threads too, so a reply after rejection is
    // stored locally (and shown on the review page) instead of waiting unread.
    try {
      const discarded = await fetchDiscardedNegotiations(vacancy.id, accessToken);
      if (discarded.length) {
        const dSync = await syncHhMessagesToHistory(dataDir, username, discarded, accessToken, { incremental: true, maxConcurrent: 4 });
        if (dSync.newMessages > 0) console.log(`[hh-bg] discard msg-sync ${username}/${vacancy.id}: +${dSync.newMessages} new messages`);
      }
    } catch (e) {
      console.error(`[hh-bg] discard msg-sync error for ${username}/${vacancy.id}:`, e.message);
    }

    // Sync is independent of scoring setup. No LLM calls without an ATS config.
    if (!readAtsConfig(workDir, vacancy.id)) return accessToken;

    const scored = await scoreUnscoredCandidates(negotiations, username, workDir, { maxConcurrent: 4, msgSyncStats: msgSync, vacancyId: vacancy.id });
    if (scored > 0) console.log(`[hh-bg] scored ${scored} new candidates for ${username}/${vacancy.id}`);

    const drafted = await generateDraftMessages(negotiations, username, workDir, { maxConcurrent: 3, vacancyId: vacancy.id });
    if (drafted > 0) console.log(`[hh-bg] generated ${drafted} draft messages for ${username}/${vacancy.id}`);

    return accessToken;
  }

  async function runHhScoringForUser(username) {
    if (_hhBgRunning.has(username)) return;
    _hhBgRunning.add(username);
    try {
      const hhTokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
      const tokenFile = path.join(hhTokensBase, String(username), 'hh');
      if (!fs.existsSync(tokenFile)) return;
      let tokenData;
      try { tokenData = JSON.parse(fs.readFileSync(tokenFile, 'utf8')); } catch { return; }
      if (!tokenData?.access_token) return;

      // workDir must match where Claude writes context (/run handler uses BASE_USERS_DIR)
      const workDir = path.join(BASE_USERS_DIR, String(username));
      const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');

      // active_vacancies[] — every vacancy this profile tracks concurrently (falls
      // back to the legacy singleton for profiles that never tracked a second one).
      // Scored sequentially, not in parallel: each vacancy already fans out its own
      // candidates with maxConcurrent, and this keeps HH/LLM rate-limit exposure
      // per background tick bounded regardless of how many vacancies a recruiter adds.
      const vacancies = readActiveVacancies(workDir);
      if (!vacancies.length) return;

      let accessToken = tokenData.access_token;
      for (const vacancy of vacancies) {
        if (!vacancy?.id) continue;
        try {
          accessToken = await runHhScoringForVacancy(username, workDir, dataDir, vacancy, accessToken);
        } catch (e) {
          console.error(`[hh-bg] error for ${username}/${vacancy.id}:`, e.message);
        }
      }

      const proactiveScored = await scoreUnscoredProactiveCandidates(username, {
        refreshAccessToken: (u) => refreshHhToken(u, getSecretsCache()),
      });
      if (proactiveScored > 0) console.log(`[hh-bg] enriched ${proactiveScored} cold-search candidates for ${username}`);
    } catch (e) {
      console.error(`[hh-bg] error for ${username}:`, e.message);
    } finally {
      _hhBgRunning.delete(username);
    }
  }

  // Compatibility URL helper for existing callers.
  function buildProactiveUrlForScheduler(username, vacancyId) {
    return require('./hh-autoscan').proactiveUrlFor(username, vacancyId);
  }

  function scheduleHhBackgroundScoring() {
    async function run() {
      const hhTokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
      if (!fs.existsSync(hhTokensBase)) return;
      for (const username of fs.readdirSync(hhTokensBase)) {
        runHhScoringForUser(username).catch(() => {});
        await new Promise(r => setTimeout(r, 1000)); // stagger users to avoid API burst
      }
    }
    setTimeout(() => run().catch(() => {}), 3 * 60 * 1000); // first run 3 min after start
    setInterval(() => run().catch(() => {}), 5 * 60 * 1000);
  }

  return {
    fetchAllHhNegotiations,
    fetchDiscardedNegotiations,
    getHhDiscardedWithCache,
    hhCacheFile,
    getHhNegotiationsWithCache,
    syncHhMessagesToHistory,
    runHhScoringForUser,
    buildProactiveUrlForScheduler,
    scheduleHhBackgroundScoring,
  };
}

module.exports = { createHhNegotiations, HH_REVIEW_STATES, HH_DISCARD_ACTIONS, hhInterviewConfigAllowsTime };
