# `web-publish` provider scaffold

This is an offline, dependency-injected provider scaffold for the future shared MCP publication capability. It is deliberately not registered in the legacy `trained-skills` process and is not deployed. It does not read profile directories, resolve GitHub repositories, hold Cloudflare credentials, or change live routes.

## MCP surface

The exported provider declares one tool with a short discovery description:

```js
{
  name: 'web-publish',
  description: 'Опубликовать веб-страницу или сайт.',
  inputSchema: {
    required: ['publication_id', 'mode'],
    properties: {
      publication_id: 'host-bound publication target ID',
      mode: ['markdown-html', 'rich-html'],
      markdown_path: 'relative Git-tree path for markdown-html',
      theme_path: 'relative Git-tree path to web-theme.json (optional)',
      site_path: 'relative Git-tree folder path for rich-html',
    },
  },
}
```

Example inputs use Git-tree paths, never file contents or a caller-supplied repository/branch:

```json
{"publication_id":"pub_luda_processes","mode":"markdown-html","markdown_path":"projects/processes/index.md","theme_path":"projects/processes/web-theme.json"}
```

```json
{"publication_id":"pub_luda_processes","mode":"rich-html","site_path":"projects/processes/site"}
```

## Adapter ports

```js
const provider = createWebPublishProvider({
  workspaceView: {
    resolve: async ({ context, publicationId }) => ({
      viewId,             // host-authorized view
      revision,           // pinned Git commit
      sourceRoot,          // publication-specific root in that tree
      title,
    }),
    readFile: async ({ viewId, revision, path }) => Buffer,
    readTree: async ({ viewId, revision, path }) => [
      { path: 'index.html', bytes: Buffer, type: 'file', mime: 'text/html' },
    ],
  },
  pagesAdapter: {
    deploy: async ({ context, publicationId, target, revision, mode, files, sourcePaths, candidateDigest }) => ({
      status: 'preview_ready', // or 'published', according to host policy
      deploymentId,
      url,
    }),
  },
});
```

The host must derive identity, repository, branch/revision, publication target, authorization, and allowed source root from trusted bindings. `workspaceView.resolve` must return one pinned commit and a publication-specific `sourceRoot`; all paths are checked against it. `readFile` and `readTree` must enforce the same View and revision. `pagesAdapter.deploy` receives only the validated candidate file list, never a repository URL or the whole profile tree. It owns preview/production policy, idempotency, Cloudflare receipt, and last-good/rollback behavior.

The provider schema declares required bindings `web-publish.workspace-view.read` and `web-publish.pages.deploy`; an integrating host must bind these refs to its own authorized adapters before exposing the tool. Without those adapters the provider cannot be instantiated.

## Implemented in this scaffold

- Markdown + optional `web-theme.json` rendered to a single `index.html` with a small allowlisted theme schema and fixed font stack choices.
- Raw Markdown HTML is escaped; unsafe URL schemes are removed; theme CSS/HTML/JS and unknown keys are rejected.
- `rich-html` copies the full validated static subtree, requiring root `index.html`; symlinks, path traversal, selected private config files, excessive file count, and excessive total bytes fail closed.
- Candidate SHA-256 digest and pinned source revision appear in the sanitized receipt; Markdown contents do not.
- Synthetic tests exercise renderer, both modes, subtree boundaries, unsafe theme/input, and controlled failure before the Pages adapter.

Markdown mode currently renders one page and does not copy local asset files; documents that need a complete set of images/styles/scripts should use `rich-html` until asset resolution is added. Neither mode executes arbitrary build commands or supports a backend/Pages Functions in this pilot contract.

## Not implemented here

There is no GitHub/Workspace View adapter, shared Cloudflare Pages adapter, MCP Host composition, live binding, route mapping, or deployment. The scaffold is ready for those owners to compose and test with synthetic fixtures; production exposure requires their integration and publication safety gates.
