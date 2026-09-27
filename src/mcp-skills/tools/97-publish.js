'use strict';

// instant-publish MCP tool
// Publishes pages directly to disk on the GCP VM.
// Served by the agent server at /p/{slug} (no auth, public endpoint).
// Per-profile domain: ~/agent-tokens/{USER_ID}/publish-domain (e.g. https://report.recruiter-assistant.ru)
// Pages stored in: $AGENT_DATA_DIR/pages/{slug}/{meta.json, index.html, source}

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash } = require('crypto');
const { marked } = require('marked');
const { publicPageBase } = require('../../public-links');

const USER_ID = process.env.USER_ID || '';
const AGENT_DATA_DIR = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
// Public base: prefer profile's configured domain, fall back to AGENT_PUBLIC_URL
const DEFAULT_BASE = process.env.AGENT_PUBLIC_URL || 'https://recruiter-assistant.ru';

// A raw IP or sslip.io host looks unprofessional on a link sent to a client/partner
// (flagged during the Renovatio ТЗ session). set_publish_domain already lets a profile
// fix this once; nudge whoever is calling publish_page so they don't have to be told
// by hand every time.
const RAW_HOST_RE = /^https?:\/\/(\d{1,3}[.-]\d{1,3}[.-]\d{1,3}[.-]\d{1,3}(\.sslip\.io)?)(\/|$)/i;

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

function pagesDir() {
  return path.join(AGENT_DATA_DIR, 'pages');
}

function ownerIndexPath(username) {
  return path.join(AGENT_DATA_DIR, 'publish-owners', `${username}.json`);
}

function profileDomain(username) {
  const domainFile = path.join(os.homedir(), 'agent-tokens', String(username || USER_ID), 'publish-domain');
  try {
    const d = fs.readFileSync(domainFile, 'utf8').trim();
    return publicPageBase(d);
  } catch {
    return publicPageBase(DEFAULT_BASE);
  }
}

function cleanSlug(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60) || 'page';
}

function detectFormat(content) {
  const t = content.trim();
  if (t.startsWith('<!DOCTYPE') || t.startsWith('<html') || (t.startsWith('<') && t.includes('>'))) return 'html';
  return 'markdown';
}

// Minimal markdown/text → HTML wrapper (no external deps).
// For real rendering use the CLI; here we just wrap in a legible prose page.
function wrapContent(source, title, format) {
  const escapedTitle = title.replace(/</g, '&lt;');
  const styles = `
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;line-height:1.7;color:#24292f;background:#fff;max-width:820px;margin:0 auto;padding:48px 32px 80px;-webkit-font-smoothing:antialiased}
h1,h2,h3,h4{color:#1a1a2e;font-weight:700;line-height:1.3;margin-top:1.8em;margin-bottom:.6em}
h1{font-size:2.1em;padding-bottom:.35em;border-bottom:2px solid #e8e8e8;margin-top:0}
h2{font-size:1.6em;border-bottom:1px solid #eaecef;padding-bottom:.25em}
h3{font-size:1.3em} h4{font-size:1.1em}
p{margin:0 0 1.1em} strong{font-weight:600}
a{color:#0969da;text-decoration:none}
code{background:#f0f3f6;padding:.15em .4em;border-radius:4px;font-size:.88em;font-family:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace}
pre{background:#f6f8fa;border:1px solid #d8dee4;border-radius:8px;padding:18px 20px;overflow-x:auto;margin:0 0 1.2em}
pre code{background:none;padding:0}
ul,ol{padding-left:2em;margin:0 0 1.1em} li{margin:.3em 0}
blockquote{border-left:4px solid #d0d7de;padding:.5em 1em;color:#57606a;background:#f8f9fa;margin:0 0 1.2em;border-radius:0 6px 6px 0}
table{border-collapse:collapse;width:100%;margin-bottom:1.2em;font-size:.95em}
th,td{border:1px solid #d8dee4;padding:10px 14px;text-align:left;vertical-align:top}
th{background:#f0f3f6;font-weight:600}
tr:nth-child(even){background:#f8f9fa}
hr{border:none;border-top:2px solid #e8e8e8;margin:2.5em 0}
img{max-width:100%;border-radius:8px}
.toolbar{position:fixed;top:12px;right:16px;display:flex;gap:6px;z-index:100}
.toolbar a,.toolbar button{font-size:12px;color:#656d76;background:#f6f8fa;padding:5px 12px;border-radius:6px;border:1px solid #d8dee4;cursor:pointer;text-decoration:none;font-family:inherit;line-height:1.4}
.toolbar a:hover,.toolbar button:hover{color:#24292f;background:#eef1f5}
@media print{.toolbar{display:none}body{padding:0;max-width:none}}
</style>`;

  if (format === 'html') return source; // serve as-is

  let body;
  if (format === 'markdown') {
    body = `<article>${marked.parse(source)}</article>`;
  } else {
    // plain text — preserve whitespace
    const escaped = source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    body = `<article><pre style="white-space:pre-wrap;background:none;border:none;padding:0;font-family:inherit;font-size:1em;line-height:1.7">${escaped}</pre></article>`;
  }

  return `<!DOCTYPE html><html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapedTitle}</title>${styles}</head><body>
<div class="toolbar">
  <a href="?raw">raw</a>
  <button onclick="window.print()">print</button>
</div>
${body}
</body></html>`;
}

function writePage({ slug, title, content, source, format, passwordHash, is_public, username }) {
  const dir = path.join(pagesDir(), slug);
  fs.mkdirSync(dir, { recursive: true });

  const meta = {
    slug, title, owner: username, passwordHash: passwordHash || null,
    format, created: new Date().toISOString(), is_public: !!is_public,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(dir, 'index.html'), content, 'utf8');
  if (source) fs.writeFileSync(path.join(dir, 'source'), source, 'utf8');

  // Update owner index
  const idxPath = ownerIndexPath(username);
  fs.mkdirSync(path.dirname(idxPath), { recursive: true });
  let list = [];
  try { list = JSON.parse(fs.readFileSync(idxPath, 'utf8')); } catch {}
  const existing = list.findIndex(p => p.slug === slug);
  const entry = { slug, title, created: meta.created, format, is_public: meta.is_public };
  if (existing >= 0) list[existing] = entry; else list.unshift(entry);
  fs.writeFileSync(idxPath, JSON.stringify(list.slice(0, 200)));
}

// Publish one page for a profile — the publish_page tool and core's
// POST /internal/publish (domain skill repos, #1470) both go through here.
function publishPage({ username, content, slug, title, password, is_public, format } = {}) {
  if (!content) return { error: 'content required' };
  if (!slug) return { error: 'slug required' };
  const slugClean = cleanSlug(slug);
  const pageTitle = title || slugClean;
  const fmt = format || detectFormat(content);
  const passwordHash = password ? sha256(password) : null;
  const isPublic = is_public !== undefined ? is_public : !password;

  let htmlContent = fmt === 'html' ? content : wrapContent(content, pageTitle, fmt);
  const rawSource = fmt !== 'html' ? content : undefined;

  try {
    writePage({
      slug: slugClean,
      title: pageTitle,
      content: htmlContent,
      source: rawSource,
      format: fmt,
      passwordHash,
      is_public: isPublic,
      username,
    });
  } catch (e) {
    return { error: `Write failed: ${e.message}` };
  }

  const base = profileDomain(username);
  const pageUrl = `${base}/p/${slugClean}`;

  return {
    url: password ? `${pageUrl}?password=${password}` : pageUrl,
    public_url: pageUrl,
    slug: slugClean,
    is_protected: !!password,
    ...(rawSource ? { raw_url: `${pageUrl}?raw` } : {}),
    ...(RAW_HOST_RE.test(base) ? {
      domain_tip: 'Ссылка на сыром IP/sslip.io — для документов, уходящих клиенту/партнёру, ' +
        'настрой один раз красивый домен: set_publish_domain("https://your-domain.ru"), дальше все ссылки будут на нём.',
    } : {}),
  };
}

module.exports = {
  publishPage,
  tools: {
    publish_page: {
      description:
        'Publish content as a shareable link and return the URL. ' +
        'MUST use this instead of sending long text in Telegram whenever the reply is: ' +
        'a report, analysis, candidate review, table, invoice, proposal, summary with sections — ' +
        'or ANY reply longer than ~800 characters. ' +
        'After publishing: reply to user with only the link + 1-sentence summary of what\'s inside. ' +
        'Public by default. For sensitive content add password and include it in the link (url?password=X). ' +
        'Same slug = update in place, same URL.',
      inputSchema: {
        type: 'object',
        required: ['content', 'slug'],
        properties: {
          content: {
            type: 'string',
            description: 'Page content — HTML string, Markdown, or plain text.',
          },
          slug: {
            type: 'string',
            description: 'URL identifier, e.g. "invoice-sep-2026". Republish with same slug to update.',
          },
          title: {
            type: 'string',
            description: 'Page title shown in browser tab.',
          },
          password: {
            type: 'string',
            description: 'Optional password. If given, page shows a lock form. Share as url?password=…',
          },
          is_public: {
            type: 'boolean',
            description: 'Explicit public flag. Defaults to true when no password, false when password given.',
          },
          format: {
            type: 'string',
            enum: ['html', 'markdown', 'text'],
            description: 'Content format. Auto-detected from content when omitted.',
          },
        },
      },
      handler: async ({ content, slug, title, password, is_public, format } = {}) => {
        if (!USER_ID) return { error: 'USER_ID not set — not running inside agent session' };
        return publishPage({ username: USER_ID, content, slug, title, password, is_public, format });
      },
    },

    list_pages: {
      description: 'List all pages published by this user profile. Shows slug, title, URL, protection status.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        if (!USER_ID) return { error: 'USER_ID not set' };
        const username = USER_ID;
        const base = profileDomain(username);
        let list = [];
        try {
          const f = ownerIndexPath(username);
          if (fs.existsSync(f)) list = JSON.parse(fs.readFileSync(f, 'utf8'));
        } catch {}
        return {
          pages: list.map(p => ({
            slug: p.slug,
            title: p.title,
            url: `${base}/p/${p.slug}`,
            format: p.format,
            is_protected: !p.is_public,
            created: p.created,
          })),
        };
      },
    },

    get_page_content: {
      description:
        'Read back the current source (markdown/text) of a page you published, for a safe edit. ' +
        'Use this BEFORE editing a published page in place — load the current source, edit it as a normal ' +
        'string in your own context, then republish the FULL content with publish_page (same slug). ' +
        'Never patch the on-disk index.html/source file directly (e.g. via sed/python) — that has previously ' +
        'corrupted a published page through double JSON-escaping and collapsed the markdown into one blob.',
      inputSchema: {
        type: 'object',
        required: ['slug'],
        properties: {
          slug: { type: 'string', description: 'Slug of the page to read.' },
        },
      },
      handler: async ({ slug } = {}) => {
        if (!slug) return { error: 'slug required' };
        if (!USER_ID) return { error: 'USER_ID not set' };

        const username = USER_ID;
        const dir = path.join(pagesDir(), cleanSlug(slug));
        if (!fs.existsSync(dir)) return { error: 'page not found' };

        let meta;
        try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch {
          return { error: 'could not read page metadata' };
        }
        if (meta.owner !== username) return { error: 'not your page' };

        const sourcePath = path.join(dir, 'source');
        const hasSource = fs.existsSync(sourcePath);
        const content = hasSource
          ? fs.readFileSync(sourcePath, 'utf8')
          : fs.readFileSync(path.join(dir, 'index.html'), 'utf8');

        return {
          slug: meta.slug,
          title: meta.title,
          format: meta.format,
          content,
          note: hasSource
            ? 'Это исходный markdown/text — редактируй его и вызови publish_page с тем же slug целиком.'
            : 'Страница опубликована как html без сохранённого markdown-источника — content это сам HTML.',
        };
      },
    },

    delete_page: {
      description: 'Delete a published page by slug. Permanent.',
      inputSchema: {
        type: 'object',
        required: ['slug'],
        properties: {
          slug: { type: 'string', description: 'Slug of the page to delete.' },
        },
      },
      handler: async ({ slug } = {}) => {
        if (!slug) return { error: 'slug required' };
        if (!USER_ID) return { error: 'USER_ID not set' };

        const username = USER_ID;
        const dir = path.join(pagesDir(), cleanSlug(slug));
        if (!fs.existsSync(dir)) return { error: 'page not found' };

        let meta;
        try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch {
          return { error: 'could not read page metadata' };
        }
        if (meta.owner !== username) return { error: 'not your page' };

        fs.rmSync(dir, { recursive: true, force: true });

        const idxPath = ownerIndexPath(username);
        if (fs.existsSync(idxPath)) {
          const list = JSON.parse(fs.readFileSync(idxPath, 'utf8')).filter(p => p.slug !== slug);
          fs.writeFileSync(idxPath, JSON.stringify(list));
        }

        return { ok: true, deleted: slug };
      },
    },

    set_publish_domain: {
      description:
        'Configure the custom domain for this profile\'s published pages. ' +
        'After setting, all publish_page calls return URLs on that domain. ' +
        'Example: set_publish_domain("https://report.recruiter-assistant.ru")',
      inputSchema: {
        type: 'object',
        required: ['domain'],
        properties: {
          domain: {
            type: 'string',
            description: 'Full base URL, e.g. "https://report.recruiter-assistant.ru"',
          },
        },
      },
      handler: async ({ domain } = {}) => {
        if (!domain) return { error: 'domain required' };
        if (!USER_ID) return { error: 'USER_ID not set' };
        const clean = domain.trim().replace(/\/$/, '');
        const dir = path.join(os.homedir(), 'agent-tokens', USER_ID);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'publish-domain'), clean, { mode: 0o600 });
        return { ok: true, domain: clean, message: `Домен установлен. Все новые ссылки будут на ${clean}/p/{slug}` };
      },
    },
  },
};
