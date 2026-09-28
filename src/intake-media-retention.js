const fs = require('fs');
const path = require('path');
const { listProfiles, writeMode } = require('./data-paths');
const { atomicJson } = require('./atomic-json');
const TTL_MS = 48 * 60 * 60 * 1000;

function releaseIntakeRefs(baseDir, username, ids, extra = {}, now = Date.now()) {
  if (!username || !Array.isArray(ids) || !ids.length) return { released: 0, missing: 0, failed: 0 };
  let released = 0, missing = 0, failed = 0;
  for (const id of ids) {
    if (typeof id !== 'string' || !/^[a-f0-9]{16,64}$/.test(id)) { failed++; continue; }
    const metaPath = path.join(baseDir, username, 'media', 'intake-store', id, 'meta.json');
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const next = { ...meta, ...extra, buffered: false, releasedAt: now };
      atomicJson(metaPath, next, writeMode(0o600));
      released++;
    } catch (e) {
      if (e.code === 'ENOENT') missing++;
      else failed++;
    }
  }
  return { released, missing, failed };
}

// Only new transient intake media; never scan project artifacts or legacy uploads.
function purgeIntakeMedia(baseDir, now = Date.now()) {
  let deleted = 0;
  // Corrupt journals fail closed: never purge media while ownership is unknown.
  const pendingDir = require('path').join(process.env.AGENT_DATA_DIR || require('path').join(require('os').homedir(), 'agent-data'), 'pending-tasks');
  let pendingText = '';
  const retainedRefs = new Set();
  const retain = (username, payload) => {
    pendingText += JSON.stringify(payload);
    for (const ref of payload?.fileRefs || []) {
      if (username && typeof ref?.id === 'string') retainedRefs.add(JSON.stringify([username, ref.id]));
    }
  };
  try {
    const legacy = fs.existsSync(path.join(path.dirname(pendingDir), 'execution-authority.json')) ? [] : fs.readdirSync(pendingDir);
    for (const file of legacy.filter(f => f.endsWith('.json'))) {
      const raw = fs.readFileSync(require('path').join(pendingDir, file), 'utf8');
      const entry = JSON.parse(raw); retain(entry.username, entry);
    }
  } catch (e) { if (e.code !== 'ENOENT') return 0; }
  // restart-intents.sqlite removed in simplification — SQLite intent retention no longer needed

  for (const profileName of listProfiles(baseDir)) {
    const dir = path.join(baseDir, profileName, 'media', 'intake');
    try {
      // Do not follow a profile's symlink into an unrelated directory.
      if (fs.lstatSync(path.dirname(dir)).isSymbolicLink() || !fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) continue;
      for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!file.isFile()) continue;
        const target = path.join(dir, file.name);
        if (!pendingText.includes(target) && now - fs.lstatSync(target).mtimeMs >= TTL_MS) { fs.unlinkSync(target); deleted++; }
      }
    } catch (error) { if (error.code !== 'ENOENT') console.warn('[intake-media cleanup]', error.code); }

    // intake-store originals are only eligible after an explicit release. This
    // preserves unseen gateway retries (buffered=true / no releasedAt) forever,
    // while web/gateway flows that have durably accepted + materialized the ref
    // can retire their original after the same 48h safety window.
    const store = path.join(baseDir, profileName, 'media', 'intake-store');
    try {
      if (!fs.existsSync(store) || fs.lstatSync(store).isSymbolicLink() || !fs.lstatSync(store).isDirectory()) continue;
      for (const entry of fs.readdirSync(store, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const refDir = path.join(store, entry.name);
        if (fs.lstatSync(refDir).isSymbolicLink()) continue;
        const metaPath = path.join(refDir, 'meta.json');
        let meta;
        try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); }
        catch { continue; } // corrupt/unknown ownership => fail closed
        if (meta.buffered !== false || !Number.isFinite(meta.releasedAt)) continue;
        if (now - meta.releasedAt < TTL_MS) continue;
        fs.rmSync(refDir, { recursive: true, force: true });
        deleted++;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[intake-store cleanup]', error.code);
    }

  }
  return deleted;
}
function startIntakeMediaRetention(baseDir) {
  const purge = () => { try { purgeIntakeMedia(baseDir); } catch (error) { console.warn('[intake-media cleanup]', error.code); } };
  purge();
  const timer = setInterval(purge, 15 * 60 * 1000);
  timer.unref();
  return timer;
}
module.exports = { TTL_MS, releaseIntakeRefs, purgeIntakeMedia, startIntakeMediaRetention };
