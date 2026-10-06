import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createWebPublishProvider,
  safeRelativePath,
  validateTheme,
  validateSiteTree,
} = require('../../src/web-publish/provider.js');

const context = Object.freeze({ profileId: 'profile-fixture', runId: 'run-fixture', bindingRef: 'binding-fixture' });

function fixture({ markdown = '# Pilot\n\nReadable **page**.', theme, tree } = {}) {
  const workspaceView = {
    resolve: vi.fn(async ({ context: received, publicationId }) => {
      expect(received).toBe(context);
      return { viewId: 'view-fixture', revision: 'a'.repeat(40), sourceRoot: 'projects/pilot', title: 'Pilot page', publicationId };
    }),
    readFile: vi.fn(async ({ viewId, revision, path }) => {
      expect(viewId).toBe('view-fixture');
      expect(revision).toBe('a'.repeat(40));
      if (path.endsWith('web-theme.json')) return Buffer.from(theme || '{"schemaVersion":1,"preset":"light","colors":{"accent":"#336699"}}');
      return Buffer.from(markdown);
    }),
    readTree: vi.fn(async ({ viewId, revision, path }) => {
      expect(viewId).toBe('view-fixture');
      expect(revision).toBe('a'.repeat(40));
      expect(path).toBe('projects/pilot/site');
      return tree || [
        { path: 'index.html', bytes: Buffer.from('<!doctype html><h1>fixture</h1>'), type: 'file', mime: 'text/html' },
        { path: 'assets/site.css', bytes: Buffer.from('body { color: navy }'), type: 'file', mime: 'text/css' },
      ];
    }),
  };
  const pagesAdapter = { deploy: vi.fn(async ({ mode, candidateDigest }) => ({ status: 'preview_ready', deploymentId: `deploy-${mode}`, url: 'https://preview.example.test', candidateDigest })) };
  const provider = createWebPublishProvider({ workspaceView, pagesAdapter });
  return { tool: provider.tools[0], workspaceView, pagesAdapter };
}

describe('web-publish scaffold provider', () => {
  it('exposes a short discovery description and both explicit modes', () => {
    const { tool } = fixture();
    expect(tool.name).toBe('web-publish');
    expect(tool.description).toBe('Опубликовать веб-страницу или сайт.');
    expect(tool.inputSchema.properties.mode.enum).toEqual(['markdown-html', 'rich-html']);
  });

  it('renders Markdown with a validated theme from one pinned view and returns a safe receipt', async () => {
    const { tool, workspaceView, pagesAdapter } = fixture();
    const result = await tool.handler({
      publication_id: 'pub-fixture', mode: 'markdown-html',
      markdown_path: 'projects/pilot/page.md', theme_path: 'projects/pilot/web-theme.json',
    }, context);

    expect(workspaceView.readFile).toHaveBeenCalledTimes(2);
    expect(workspaceView.readFile.mock.calls.map(([arg]) => arg.revision)).toEqual(['a'.repeat(40), 'a'.repeat(40)]);
    expect(pagesAdapter.deploy).toHaveBeenCalledOnce();
    const candidate = pagesAdapter.deploy.mock.calls[0][0];
    expect(candidate.revision).toBe('a'.repeat(40));
    expect(candidate.files.map((file) => file.path)).toEqual(['index.html']);
    expect(candidate.files[0].bytes.toString()).toContain('--accent:#336699');
    expect(candidate.files[0].bytes.toString()).toContain('<strong>page</strong>');
    expect(result).toMatchObject({
      status: 'preview_ready', publication_id: 'pub-fixture', deployment_id: 'deploy-markdown-html',
      source_revision: 'a'.repeat(40), mode: 'markdown-html', theme_schema_version: 'web-theme.v1',
    });
    expect(JSON.stringify(result)).not.toContain('Readable');
  });

  it('copies a complete rich-html subtree to the Pages adapter without rendering it', async () => {
    const { tool, pagesAdapter } = fixture();
    const result = await tool.handler({ publication_id: 'pub-fixture', mode: 'rich-html', site_path: 'projects/pilot/site' }, context);
    const candidate = pagesAdapter.deploy.mock.calls[0][0];
    expect(candidate.files.map((file) => file.path)).toEqual(['assets/site.css', 'index.html']);
    expect(candidate.files.find((file) => file.path === 'index.html').bytes.toString()).toContain('<h1>fixture</h1>');
    expect(result.source_paths).toEqual(['projects/pilot/site']);
    expect(result.theme_schema_version).toBeUndefined();
  });

  it('rejects path escapes, secret/config paths, symlinks and sites without a root index', async () => {
    expect(() => safeRelativePath('../private.md', 'markdown_path')).toThrow(/relative|forbidden/);
    expect(() => safeRelativePath('site/.env', 'site_path')).toThrow(/forbidden/);
    expect(() => validateSiteTree([{ path: 'index.html', type: 'symlink', bytes: 'nope' }])).toThrow(/symlinks/);
    expect(() => validateSiteTree([{ path: 'nested/index.html', bytes: '<h1>nested</h1>' }])).toThrow(/index.html/);
  });

  it('does not let source paths read outside the publication-specific root', async () => {
    const { tool, workspaceView, pagesAdapter } = fixture();
    await expect(tool.handler({ publication_id: 'pub-fixture', mode: 'markdown-html', markdown_path: 'projects/other/page.md' }, context))
      .rejects.toThrow(/outside the publication source root/);
    expect(workspaceView.readFile).not.toHaveBeenCalled();
    expect(pagesAdapter.deploy).not.toHaveBeenCalled();
  });

  it('rejects unsafe theme data and never calls the Pages adapter', async () => {
    const { tool, pagesAdapter } = fixture({ theme: '{"schemaVersion":1,"colors":{"accent":"url(javascript:alert(1))"}}' });
    await expect(tool.handler({
      publication_id: 'pub-fixture', mode: 'markdown-html',
      markdown_path: 'projects/pilot/page.md', theme_path: 'projects/pilot/web-theme.json',
    }, context)).rejects.toThrow(/hex color/);
    expect(pagesAdapter.deploy).not.toHaveBeenCalled();
  });

  it('escapes raw HTML and blocks javascript links in Markdown', async () => {
    const { tool, pagesAdapter } = fixture({ markdown: '<script>alert(1)</script>\n\n[x](javascript:alert(1))' });
    await tool.handler({ publication_id: 'pub-fixture', mode: 'markdown-html', markdown_path: 'projects/pilot/page.md' }, context);
    const html = pagesAdapter.deploy.mock.calls[0][0].files[0].bytes.toString();
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('href="javascript:');
  });
});
