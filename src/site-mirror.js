'use strict';

// Branded mirror of site_deploy folders: https://recruiter-assistant.ru/s/<project>/.
//
// Why: site_deploy used to hand out only <project>.pages.dev links, while
// publish_page links live on the branded domain — a client got half the documents
// on recruiter-assistant.ru and half on a bare Cloudflare host (and pages.dev is
// throttled for part of the RU audience). site_deploy now also copies the folder to
// <AGENT_DATA_DIR>/sites/<project>/ and the agent serves it at /s/<project>/; the RU
// apex proxies /s/ to this server like it does /p/.
//
// Namespace: one project name = one owner profile (sites/<project>.meta.json),
// independent of which Cloudflare account the deploy used — a profile with its own
// token cannot overwrite another profile's branded site under the same name.
//
// Serving: user-authored HTML/JS on the product origin, so every response carries a
// CSP sandbox WITHOUT allow-same-origin — the page runs in an opaque origin and
// cannot read cookies/storage of the web app on the same host.

const fs = require('fs');
const path = require('path');

const MIRROR_MAX_BYTES = 100 * 1024 * 1024;
const MIRROR_MAX_FILES = 5000;
const DEFAULT_SITES_BASE = 'https://recruiter-assistant.ru';

const SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.webmanifest': 'application/manifest+json', '.map': 'application/json; charset=utf-8',
};

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/;

function sitesRoot(dataRoot) {
  return path.join(dataRoot, 'sites');
}

function metaPath(dataRoot, name) {
  return path.join(sitesRoot(dataRoot), `${name}.meta.json`);
}

/** Public base for branded site links. SITES_PUBLIC_URL overrides (isolated envs). */
function sitesPublicBase(env = process.env) {
  return String(env.SITES_PUBLIC_URL || DEFAULT_SITES_BASE).replace(/\/+$/, '');
}

/** Regular files of `src` (dot-entries and symlinks skipped), with size limits. */
function listFiles(src) {
  const out = [];
  let bytes = 0;
  const walk = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      const abs = path.join(dir, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { walk(abs, r); continue; }
      if (!ent.isFile()) continue; // symlinks, sockets, devices
      bytes += fs.statSync(abs).size;
      out.push(r);
      if (out.length > MIRROR_MAX_FILES) throw new Error(`слишком много файлов (> ${MIRROR_MAX_FILES})`);
      if (bytes > MIRROR_MAX_BYTES) throw new Error(`сайт больше ${MIRROR_MAX_BYTES >> 20} МБ`);
    }
  };
  walk(src, '');
  return out;
}

/**
 * Copy `src` to sites/<name>/ atomically (tmp dir + rename) for `username`.
 * → {ok:true, url} | {ok:false, error}
 */
function mirrorSite({ src, name, username, dataRoot, env = process.env }) {
  if (!NAME_RE.test(name)) return { ok: false, error: 'bad project name' };
  const root = sitesRoot(dataRoot);
  fs.mkdirSync(root, { recursive: true });
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(metaPath(dataRoot, name), 'utf8')); } catch { /* new */ }
  if (meta && meta.owner !== String(username)) {
    return { ok: false, error: `адрес /s/${name}/ уже занят другим профилем — выбери другое имя проекта` };
  }
  let files;
  try { files = listFiles(src); } catch (e) { return { ok: false, error: e.message }; }

  const stamp = `${process.pid}-${Date.now()}`;
  const tmp = path.join(root, `.tmp-${name}-${stamp}`);
  const old = path.join(root, `.old-${name}-${stamp}`);
  const dst = path.join(root, name);
  try {
    for (const rel of files) {
      const to = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(src, rel), to);
    }
    fs.mkdirSync(tmp, { recursive: true });
    const hadOld = fs.existsSync(dst);
    if (hadOld) fs.renameSync(dst, old);
    fs.renameSync(tmp, dst);
    if (hadOld) fs.rmSync(old, { recursive: true, force: true });
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!fs.existsSync(dst) && fs.existsSync(old)) fs.renameSync(old, dst);
    return { ok: false, error: `не удалось скопировать сайт: ${e.message}` };
  }
  const now = new Date().toISOString();
  fs.writeFileSync(metaPath(dataRoot, name), JSON.stringify({
    owner: String(username), created_at: meta?.created_at || now, updated_at: now, files: files.length,
  }, null, 2));
  return { ok: true, url: `${sitesPublicBase(env)}/s/${name}/` };
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('<h1>404</h1><p>Page not found.</p>');
  return true;
}

/** GET|HEAD /s/<name>[/<path>] → static file from sites/<name>/. Returns true if handled. */
function serveSite(req, url, res, dataRoot = process.env.AGENT_DATA_DIR || path.join(require('os').homedir(), 'agent-data')) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const m = url.pathname.match(/^\/s\/([a-z0-9][a-z0-9-]{0,57})(\/.*)?$/);
  if (!m) return false;
  const name = m[1];
  if (!NAME_RE.test(name)) return notFound(res);
  const base = path.join(sitesRoot(dataRoot), name);
  if (!fs.existsSync(path.join(base, 'index.html'))) return notFound(res);
  if (m[2] === undefined) {
    // Relative asset links need the trailing slash.
    res.writeHead(301, { Location: `/s/${name}/${url.search || ''}` });
    res.end();
    return true;
  }
  let rel;
  try { rel = decodeURIComponent(m[2]); } catch { return notFound(res); }
  if (rel.includes('\0') || rel.split('/').some(seg => seg.startsWith('.'))) return notFound(res);
  let file = path.resolve(base, '.' + rel);
  if (file !== base && !file.startsWith(base + path.sep)) return notFound(res);
  let st;
  try { st = fs.lstatSync(file); } catch { return notFound(res); }
  if (st.isDirectory()) {
    file = path.join(file, 'index.html');
    try { st = fs.lstatSync(file); } catch { return notFound(res); }
  }
  if (!st.isFile()) return notFound(res);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Content-Security-Policy': SANDBOX_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(file).pipe(res);
  return true;
}

module.exports = { mirrorSite, serveSite, sitesPublicBase, SANDBOX_CSP, MIRROR_MAX_BYTES };
