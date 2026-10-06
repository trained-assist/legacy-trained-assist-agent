'use strict';

const { createHash } = require('node:crypto');
const { Marked, Renderer } = require('marked');

const PROVIDER_ID = 'web-publishing';
const PROVIDER_VERSION = '0.1.0-scaffold';
const MAX_MARKDOWN_BYTES = 1_000_000;
const MAX_THEME_BYTES = 32_000;
const MAX_SITE_FILES = 1_000;
const MAX_SITE_BYTES = 25 * 1024 * 1024;
const FORBIDDEN_SEGMENTS = new Set(['.git', '.agent-home', 'node_modules', 'secrets']);
const FONT_STACKS = Object.freeze({
  sans: 'Arial, Helvetica, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, Consolas, monospace',
});
const FORBIDDEN_FILE_NAMES = /^(?:\.env(?:\..*)?|\.mcp(?:\..*)?|\.opencode(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i;

const tool = {
  name: 'web-publish',
  description: 'Опубликовать веб-страницу или сайт.',
  requiredBindings: ['web-publish.workspace-view.read', 'web-publish.pages.deploy'],
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['publication_id', 'mode'],
    properties: {
      publication_id: { type: 'string', minLength: 1, maxLength: 200 },
      mode: { type: 'string', enum: ['markdown-html', 'rich-html'] },
      markdown_path: { type: 'string', description: 'Markdown file path relative to the authorized view; required for markdown-html.' },
      theme_path: { type: 'string', description: 'web-theme.json path relative to the same view; optional for markdown-html.' },
      site_path: { type: 'string', description: 'Static site folder path relative to the authorized view; required for rich-html.' },
    },
  },
};

function invalid(message) {
  return Object.assign(new Error(message), { code: 'WEB_PUBLISH_INVALID_INPUT' });
}

function safeRelativePath(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500 || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) {
    throw invalid(`${field} must be a safe relative path`);
  }
  if (value.startsWith('/') || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) throw invalid(`${field} must be relative to the authorized view`);
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || FORBIDDEN_SEGMENTS.has(part.toLowerCase()) || FORBIDDEN_FILE_NAMES.test(part))) {
    throw invalid(`${field} contains a forbidden path segment`);
  }
  return parts.join('/');
}

function assertWithinRoot(value, root, field) {
  const safeRoot = safeRelativePath(root, 'publication source root');
  if (value !== safeRoot && !value.startsWith(`${safeRoot}/`)) throw invalid(`${field} is outside the publication source root`);
  return value;
}

function asBuffer(value, field) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw invalid(`${field} was not returned as bytes`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function hexColor(value, field) {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) throw invalid(`${field} must be a six-digit hex color`);
  return value.toLowerCase();
}

function validateTheme(raw) {
  let value;
  try { value = JSON.parse(raw.toString('utf8')); } catch { throw invalid('web-theme.json is not valid JSON'); }
  const allowed = new Set(['schemaVersion', 'preset', 'colors', 'font', 'layout']);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw invalid('web-theme.json contains unsupported fields');
  }
  if (value.schemaVersion !== 1) throw invalid('web-theme.json schemaVersion must be 1');
  const presets = new Set(['default', 'light', 'dark', 'brand']);
  if (value.preset !== undefined && !presets.has(value.preset)) throw invalid('web-theme.json preset is unsupported');

  const colors = value.colors || {};
  const colorKeys = ['background', 'surface', 'text', 'muted', 'accent', 'border'];
  if (!colors || typeof colors !== 'object' || Array.isArray(colors) || Object.keys(colors).some((key) => !colorKeys.includes(key))) {
    throw invalid('web-theme.json colors contains unsupported fields');
  }
  const defaults = value.preset === 'dark'
    ? { background: '#15171a', surface: '#202328', text: '#f3f4f6', muted: '#a6adb8', accent: '#83b7ff', border: '#373c44' }
    : { background: '#ffffff', surface: '#f6f8fa', text: '#24292f', muted: '#57606a', accent: '#0969da', border: '#d0d7de' };
  const normalizedColors = Object.fromEntries(colorKeys.map((key) => [key, colors[key] === undefined ? defaults[key] : hexColor(colors[key], `colors.${key}`)]));

  const font = value.font || {};
  if (!font || typeof font !== 'object' || Array.isArray(font) || Object.keys(font).some((key) => !['body', 'heading', 'mono'].includes(key))) {
    throw invalid('web-theme.json font contains unsupported fields');
  }
  const normalizeFont = (key, fallback) => {
    const selected = font[key] === undefined ? fallback : font[key];
    if (!Object.hasOwn(FONT_STACKS, selected)) throw invalid(`font.${key} must be sans, serif or mono`);
    return FONT_STACKS[selected];
  };

  const layout = value.layout || {};
  if (!layout || typeof layout !== 'object' || Array.isArray(layout) || Object.keys(layout).some((key) => !['maxWidth', 'density'].includes(key))) {
    throw invalid('web-theme.json layout contains unsupported fields');
  }
  const maxWidth = layout.maxWidth === undefined ? 860 : layout.maxWidth;
  if (!Number.isInteger(maxWidth) || maxWidth < 480 || maxWidth > 1200) throw invalid('layout.maxWidth must be between 480 and 1200');
  const density = layout.density === undefined ? 'comfortable' : layout.density;
  if (!['compact', 'comfortable', 'spacious'].includes(density)) throw invalid('layout.density is unsupported');

  return {
    preset: value.preset || 'default',
    colors: normalizedColors,
    fonts: { body: normalizeFont('body', 'sans'), heading: normalizeFont('heading', 'sans'), mono: normalizeFont('mono', 'mono') },
    maxWidth,
    density,
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function safeUrl(raw, { image = false } = {}) {
  if (typeof raw !== 'string' || raw.length > 2_000 || /[\u0000-\u0020\\]/.test(raw)) return null;
  if (/^(https?:|mailto:)/i.test(raw)) return image && /^mailto:/i.test(raw) ? null : raw;
  if (/^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith('//') || raw.startsWith('/')) return null;
  const pathname = raw.split(/[?#]/, 1)[0];
  if (pathname.split('/').some((part) => part === '..' || part === '.')) return null;
  return raw;
}

function renderInlineTokens(tokens = [], depth = 0) {
  if (!Array.isArray(tokens) || depth > 20) return '';
  return tokens.map((token) => {
    const inner = () => renderInlineTokens(token.tokens || [], depth + 1);
    switch (token.type) {
      case 'text': return Array.isArray(token.tokens) ? inner() : escapeHtml(token.text || '');
      case 'escape': return escapeHtml(token.text || '');
      case 'html': return escapeHtml(token.text || token.raw || '');
      case 'strong': return `<strong>${inner()}</strong>`;
      case 'em': return `<em>${inner()}</em>`;
      case 'del': return `<del>${inner()}</del>`;
      case 'codespan': return `<code>${escapeHtml(token.text || '')}</code>`;
      case 'br': return '<br>\n';
      case 'link': {
        const url = safeUrl(token.href);
        const label = inner();
        if (!url) return label;
        const external = /^https?:/i.test(url);
        return `<a href="${escapeHtml(url)}"${token.title ? ` title="${escapeHtml(token.title)}"` : ''}${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>`;
      }
      case 'image': {
        const url = safeUrl(token.href, { image: true });
        if (!url) return escapeHtml(token.text || '');
        return `<img src="${escapeHtml(url)}" alt="${escapeHtml(token.text || '')}"${token.title ? ` title="${escapeHtml(token.title)}"` : ''}>`;
      }
      default: return escapeHtml(token.text || token.raw || '');
    }
  }).join('');
}

function renderMarkdown(markdown, title, theme) {
  const renderer = new Renderer();
  renderer.html = (token) => escapeHtml(token.text);
  renderer.link = (token) => {
    const url = safeUrl(token.href);
    const label = renderInlineTokens(token.tokens);
    if (!url) return label;
    const external = /^https?:/i.test(url);
    return `<a href="${escapeHtml(url)}"${token.title ? ` title="${escapeHtml(token.title)}"` : ''}${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>`;
  };
  renderer.image = (token) => {
    const url = safeUrl(token.href, { image: true });
    if (!url) return escapeHtml(token.text || '');
    return `<img src="${escapeHtml(url)}" alt="${escapeHtml(token.text || '')}"${token.title ? ` title="${escapeHtml(token.title)}"` : ''}>`;
  };
  const parser = new Marked({ gfm: true, renderer });
  const body = parser.parse(markdown);
  const c = theme.colors;
  const rowGap = { compact: '0.65em', comfortable: '1em', spacious: '1.4em' }[theme.density];
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
:root{color-scheme:${theme.preset === 'dark' ? 'dark' : 'light'};--bg:${c.background};--surface:${c.surface};--text:${c.text};--muted:${c.muted};--accent:${c.accent};--border:${c.border}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.7 ${theme.fonts.body};-webkit-font-smoothing:antialiased}main{max-width:${theme.maxWidth}px;margin:0 auto;padding:48px 28px 80px}h1,h2,h3,h4{font-family:${theme.fonts.heading};line-height:1.3;margin:1.6em 0 .6em}h1{margin-top:0;border-bottom:2px solid var(--border);padding-bottom:.35em}h2{border-bottom:1px solid var(--border);padding-bottom:.25em}p,ul,ol,blockquote,table,pre{margin:0 0 ${rowGap}}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}code{font-family:${theme.fonts.mono};background:var(--surface);padding:.12em .35em;border-radius:4px}pre{overflow:auto;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px}pre code{padding:0;background:transparent}blockquote{border-left:4px solid var(--accent);padding:.25em 1em;color:var(--muted);background:var(--surface)}table{width:100%;border-collapse:collapse}th,td{border:1px solid var(--border);padding:9px 12px;text-align:left;vertical-align:top}th{background:var(--surface)}img{max-width:100%;height:auto}hr{border:0;border-top:1px solid var(--border);margin:2em 0}
@media(max-width:600px){main{padding:28px 18px 56px}}
</style></head><body><main>${body}</main></body></html>`;
  return Buffer.from(html, 'utf8');
}

function validateSiteTree(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_SITE_FILES) throw invalid(`rich-html site must contain 1-${MAX_SITE_FILES} files`);
  const files = [];
  let total = 0;
  for (const entry of entries) {
    const relativePath = safeRelativePath(entry.path, 'site entry path');
    if (entry.type && entry.type !== 'file') throw invalid('rich-html site cannot contain symlinks or non-file entries');
    const bytes = asBuffer(entry.bytes ?? entry.content, `site file ${relativePath}`);
    total += bytes.length;
    if (total > MAX_SITE_BYTES) throw invalid(`rich-html site exceeds ${MAX_SITE_BYTES} bytes`);
    files.push({ path: relativePath, bytes, sha256: sha256(bytes), ...(entry.mime ? { mime: String(entry.mime) } : {}) });
  }
  if (!files.some((entry) => entry.path === 'index.html')) throw invalid('rich-html site folder must contain index.html at its root');
  const seen = new Set();
  for (const file of files) {
    if (seen.has(file.path)) throw invalid(`rich-html site contains duplicate path ${file.path}`);
    seen.add(file.path);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function manifestDigest(files) {
  const canonical = files.map(({ path: filePath, sha256: digest, bytes }) => `${filePath}\0${digest || sha256(bytes)}\0${bytes.length}`).join('\n');
  return sha256(Buffer.from(canonical));
}

function createWebPublishProvider({ workspaceView, pagesAdapter, maxMarkdownBytes = MAX_MARKDOWN_BYTES } = {}) {
  if (!workspaceView || typeof workspaceView.resolve !== 'function' || typeof workspaceView.readFile !== 'function' || typeof workspaceView.readTree !== 'function') {
    throw new TypeError('web-publish requires a scoped Workspace View adapter');
  }
  if (!pagesAdapter || typeof pagesAdapter.deploy !== 'function') throw new TypeError('web-publish requires a scoped Pages publication adapter');

  return {
    id: PROVIDER_ID,
    version: PROVIDER_VERSION,
    tools: [{
      ...tool,
      handler: async (args, context) => {
        const mode = args?.mode;
        if (!['markdown-html', 'rich-html'].includes(mode)) throw invalid('mode must be markdown-html or rich-html');
        if (typeof args.publication_id !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(args.publication_id)) throw invalid('publication_id is invalid');
        if (mode === 'markdown-html') {
          if (!args.markdown_path || args.site_path) throw invalid('markdown-html requires markdown_path and does not accept site_path');
        } else if (!args.site_path || args.markdown_path || args.theme_path) {
          throw invalid('rich-html requires site_path and does not accept markdown_path/theme_path');
        }

        const target = await workspaceView.resolve({ context, publicationId: args.publication_id });
        if (!target || typeof target.viewId !== 'string' || !/^[0-9a-f]{40,64}$/i.test(String(target.revision || '')) || typeof target.sourceRoot !== 'string') {
          throw Object.assign(new Error('No pinned Workspace View is available for this publication'), { code: 'WEB_PUBLISH_VIEW_UNAVAILABLE' });
        }
        const sourceRoot = safeRelativePath(target.sourceRoot, 'publication source root');

        let files;
        let sourcePaths;
        let themeVersion = null;
        if (mode === 'markdown-html') {
          const markdownPath = assertWithinRoot(safeRelativePath(args.markdown_path, 'markdown_path'), sourceRoot, 'markdown_path');
          if (!/\.md$/i.test(markdownPath)) throw invalid('markdown_path must point to a .md file');
          const markdown = asBuffer(await workspaceView.readFile({ viewId: target.viewId, revision: target.revision, path: markdownPath }), markdownPath);
          if (markdown.length > maxMarkdownBytes) throw invalid(`Markdown exceeds ${maxMarkdownBytes} bytes`);
          let theme = validateTheme(Buffer.from('{"schemaVersion":1}', 'utf8'));
          let themePath = null;
          if (args.theme_path) {
            themePath = assertWithinRoot(safeRelativePath(args.theme_path, 'theme_path'), sourceRoot, 'theme_path');
            if (!/web-theme\.json$/i.test(themePath)) throw invalid('theme_path must point to web-theme.json');
            const themeBytes = asBuffer(await workspaceView.readFile({ viewId: target.viewId, revision: target.revision, path: themePath }), themePath);
            if (themeBytes.length > MAX_THEME_BYTES) throw invalid(`web-theme.json exceeds ${MAX_THEME_BYTES} bytes`);
            theme = validateTheme(themeBytes);
          }
          const rendered = renderMarkdown(markdown.toString('utf8'), target.title || markdownPath.split('/').pop().replace(/\.md$/i, ''), theme);
          files = [{ path: 'index.html', bytes: rendered, sha256: sha256(rendered), mime: 'text/html; charset=utf-8' }];
          sourcePaths = [markdownPath, ...(themePath ? [themePath] : [])];
          themeVersion = 'web-theme.v1';
        } else {
          const sitePath = assertWithinRoot(safeRelativePath(args.site_path, 'site_path'), sourceRoot, 'site_path');
          const tree = await workspaceView.readTree({ viewId: target.viewId, revision: target.revision, path: sitePath });
          files = validateSiteTree(tree);
          sourcePaths = [sitePath];
        }

        const candidateDigest = manifestDigest(files);
        const receipt = await pagesAdapter.deploy({
          context,
          publicationId: args.publication_id,
          target,
          revision: target.revision,
          mode,
          files,
          sourcePaths,
          candidateDigest,
          themeVersion,
        });
        if (!receipt || receipt.ok === false || (receipt.status && !['preview_ready', 'published'].includes(receipt.status))) {
          throw Object.assign(new Error('Pages adapter did not confirm a deployment'), { code: 'WEB_PUBLISH_DEPLOYMENT_FAILED' });
        }
        return {
          status: receipt?.status || 'preview_ready',
          publication_id: args.publication_id,
          deployment_id: receipt?.deploymentId || null,
          url: receipt?.url || null,
          source_revision: target.revision,
          mode,
          source_paths: sourcePaths,
          renderer_version: 'web-publish-renderer.v1',
          ...(themeVersion ? { theme_schema_version: themeVersion } : {}),
          candidate_digest: candidateDigest,
        };
      },
    }],
  };
}

module.exports = {
  createWebPublishProvider,
  safeRelativePath,
  assertWithinRoot,
  validateTheme,
  renderMarkdown,
  renderInlineTokens,
  validateSiteTree,
  manifestDigest,
  constants: { MAX_MARKDOWN_BYTES, MAX_THEME_BYTES, MAX_SITE_FILES, MAX_SITE_BYTES },
};
