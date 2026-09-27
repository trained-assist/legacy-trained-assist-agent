'use strict';

// GitHub skill — uses GH_TOKEN (Personal Access Token) from agent-tokens/{userId}/github
// runner.js maps label 'github' → GH_TOKEN env var for Claude process.
// MCP process reads from disk directly (env vars are not forwarded to MCP).
//
// Token setup: call connect({ service: "github" }) — universal connect tool handles ZeroCreds form.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readTokenValue } = require('../../token-value');

const GH_API = 'https://api.github.com';
const USER_ID = process.env.USER_ID || '';

function getToken() {
  const tok = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (tok) return tok;
  if (USER_ID) {
    try {
      const p = path.join(os.homedir(), 'agent-tokens', USER_ID, 'github');
      if (fs.existsSync(p)) return readTokenValue(fs.readFileSync(p, 'utf8'));
    } catch {}
  }
  throw new Error(
    'GitHub токен не задан. Вызови github_connect — получишь защищённую ссылку для ввода токена без отправки в чат.'
  );
}

async function ghFetch(path, opts = {}) {
  const token = getToken();
  const url = path.startsWith('http') ? path : `${GH_API}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'trained-assist-agent',
      ...opts.headers,
    },
    signal: opts.signal || AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.message || res.statusText;
    throw new Error(`GitHub API ${res.status}: ${msg}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

module.exports = {
  isReady: () => {
    if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return true;
    if (!USER_ID) return false;
    return fs.existsSync(path.join(os.homedir(), 'agent-tokens', USER_ID, 'github'));
  },
  setupTools: ['github_status'],

  tools: {

    github_status: {
      description: 'Check GitHub token and show authenticated user info.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const user = await ghFetch('/user');
        const scopes = await fetch(`${GH_API}/user`, {
          headers: { 'Authorization': `Bearer ${getToken()}`, 'X-GitHub-Api-Version': '2022-11-28' },
          signal: AbortSignal.timeout(10000),
        }).then(r => r.headers.get('x-oauth-scopes') || '');
        return {
          login: user.login,
          name: user.name,
          email: user.email,
          public_repos: user.public_repos,
          private_repos: user.total_private_repos,
          token_scopes: scopes,
        };
      },
    },

    github_list_repos: {
      description: 'List GitHub repositories accessible with the token.',
      inputSchema: {
        type: 'object',
        properties: {
          org: { type: 'string', description: 'List repos for this org instead of personal account' },
          type: { type: 'string', enum: ['all', 'public', 'private', 'forks', 'sources', 'member'], description: 'Filter by type (default all)' },
          limit: { type: 'number', description: 'Max repos to return (default 30)' },
          sort: { type: 'string', enum: ['created', 'updated', 'pushed', 'full_name'], description: 'Sort by (default updated)' },
        },
      },
      handler: async ({ org, type = 'all', limit = 30, sort = 'updated' } = {}) => {
        const n = Math.min(limit || 30, 100);
        const path = org
          ? `/orgs/${org}/repos?type=${type}&sort=${sort}&per_page=${n}`
          : `/user/repos?type=${type}&sort=${sort}&per_page=${n}`;
        const repos = await ghFetch(path);
        return {
          repos: repos.map(r => ({
            full_name: r.full_name,
            description: r.description,
            private: r.private,
            default_branch: r.default_branch,
            updated_at: r.updated_at,
            language: r.language,
            stars: r.stargazers_count,
            open_issues: r.open_issues_count,
          })),
          count: repos.length,
        };
      },
    },

    github_get_file: {
      description: 'Read a file from a GitHub repository.',
      inputSchema: {
        type: 'object',
        required: ['repo', 'path'],
        properties: {
          repo: { type: 'string', description: 'owner/repo (e.g. trained-assist/trained-assist-agent)' },
          path: { type: 'string', description: 'File path in the repo (e.g. src/server.js)' },
          ref: { type: 'string', description: 'Branch, tag or commit SHA (default: default branch)' },
          max_chars: { type: 'number', description: 'Max chars to return (default 8000)' },
        },
      },
      handler: async ({ repo, path: filePath, ref, max_chars = 8000 }) => {
        let url = `/repos/${repo}/contents/${filePath}`;
        if (ref) url += `?ref=${encodeURIComponent(ref)}`;
        const data = await ghFetch(url);
        if (Array.isArray(data)) {
          return {
            type: 'directory',
            entries: data.map(e => ({ name: e.name, type: e.type, size: e.size })),
          };
        }
        if (data.type !== 'file') throw new Error(`Not a file: type=${data.type}`);
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        const truncated = content.length > max_chars;
        return {
          path: data.path,
          sha: data.sha,
          size: data.size,
          content: truncated ? content.slice(0, max_chars) : content,
          truncated,
          encoding: 'utf8',
        };
      },
    },

    github_list_issues: {
      description: 'List issues or pull requests in a GitHub repository.',
      inputSchema: {
        type: 'object',
        required: ['repo'],
        properties: {
          repo: { type: 'string', description: 'owner/repo' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state (default open)' },
          labels: { type: 'string', description: 'Comma-separated label names to filter by' },
          limit: { type: 'number', description: 'Max issues (default 20)' },
          assignee: { type: 'string', description: 'Filter by assignee username' },
        },
      },
      handler: async ({ repo, state = 'open', labels, limit = 20, assignee } = {}) => {
        const n = Math.min(limit || 20, 100);
        let url = `/repos/${repo}/issues?state=${state}&per_page=${n}&sort=updated`;
        if (labels) url += `&labels=${encodeURIComponent(labels)}`;
        if (assignee) url += `&assignee=${encodeURIComponent(assignee)}`;
        const issues = await ghFetch(url);
        return {
          issues: issues.filter(i => !i.pull_request).map(i => ({
            number: i.number,
            title: i.title,
            state: i.state,
            labels: i.labels.map(l => l.name),
            assignees: i.assignees.map(a => a.login),
            created_at: i.created_at,
            updated_at: i.updated_at,
            comments: i.comments,
            url: i.html_url,
          })),
        };
      },
    },

    github_create_issue: {
      description: 'Create a new GitHub issue.',
      inputSchema: {
        type: 'object',
        required: ['repo', 'title'],
        properties: {
          repo: { type: 'string', description: 'owner/repo' },
          title: { type: 'string', description: 'Issue title' },
          body: { type: 'string', description: 'Issue description (Markdown)' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Label names to add' },
          assignees: { type: 'array', items: { type: 'string' }, description: 'GitHub usernames to assign' },
        },
      },
      handler: async ({ repo, title, body, labels, assignees }) => {
        const issue = await ghFetch(`/repos/${repo}/issues`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, body, labels, assignees }),
        });
        return {
          number: issue.number,
          title: issue.title,
          url: issue.html_url,
          state: issue.state,
        };
      },
    },

    github_update_issue: {
      description: 'Update a GitHub issue: change title, body, state, labels, or assignees.',
      inputSchema: {
        type: 'object',
        required: ['repo', 'issue_number'],
        properties: {
          repo: { type: 'string', description: 'owner/repo' },
          issue_number: { type: 'number', description: 'Issue number' },
          title: { type: 'string', description: 'New title' },
          body: { type: 'string', description: 'New body' },
          state: { type: 'string', enum: ['open', 'closed'], description: 'New state' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Replace labels list' },
        },
      },
      handler: async ({ repo, issue_number, title, body, state, labels }) => {
        const patch = {};
        if (title !== undefined) patch.title = title;
        if (body !== undefined) patch.body = body;
        if (state !== undefined) patch.state = state;
        if (labels !== undefined) patch.labels = labels;
        const issue = await ghFetch(`/repos/${repo}/issues/${issue_number}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        return { number: issue.number, title: issue.title, state: issue.state, url: issue.html_url };
      },
    },

    github_add_comment: {
      description: 'Add a comment to a GitHub issue or pull request.',
      inputSchema: {
        type: 'object',
        required: ['repo', 'issue_number', 'body'],
        properties: {
          repo: { type: 'string', description: 'owner/repo' },
          issue_number: { type: 'number', description: 'Issue or PR number' },
          body: { type: 'string', description: 'Comment text (Markdown)' },
        },
      },
      handler: async ({ repo, issue_number, body }) => {
        const comment = await ghFetch(`/repos/${repo}/issues/${issue_number}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body }),
        });
        return { comment_id: comment.id, url: comment.html_url };
      },
    },

    github_list_prs: {
      description: 'List pull requests in a GitHub repository.',
      inputSchema: {
        type: 'object',
        required: ['repo'],
        properties: {
          repo: { type: 'string', description: 'owner/repo' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'PR state (default open)' },
          limit: { type: 'number', description: 'Max PRs (default 10)' },
        },
      },
      handler: async ({ repo, state = 'open', limit = 10 } = {}) => {
        const n = Math.min(limit || 10, 50);
        const prs = await ghFetch(`/repos/${repo}/pulls?state=${state}&per_page=${n}&sort=updated`);
        return {
          prs: prs.map(p => ({
            number: p.number,
            title: p.title,
            state: p.state,
            author: p.user.login,
            head: p.head.ref,
            base: p.base.ref,
            mergeable: p.mergeable,
            updated_at: p.updated_at,
            url: p.html_url,
          })),
        };
      },
    },

    github_pr_checks: {
      description: 'Get CI/check-runs status for a pull request. Reads the PR, then its head commit check-runs (the same path the GTD controller uses). Use this to answer "did CI pass / what PR status is" without opening the browser.',
      inputSchema: {
        type: 'object',
        required: ['repo', 'pr_number'],
        properties: {
          repo: { type: 'string', description: 'owner/repo' },
          pr_number: { type: 'number', description: 'Pull request number' },
          head_sha: { type: 'string', description: 'Optional: query check-runs of this exact commit instead of the current PR head' },
        },
      },
      handler: async ({ repo, pr_number, head_sha }) => {
        const pr = await ghFetch(`/repos/${repo}/pulls/${pr_number}`);
        const sha = head_sha || pr.head?.sha;
        let runs = [];
        let commitStatus = null;
        if (sha) {
          try {
            const data = await ghFetch(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`);
            runs = data.check_runs || [];
          } catch (e) {
            if (!String(e.message).includes('404')) throw e;
          }
          if (!runs.length) {
            try { commitStatus = await ghFetch(`/repos/${repo}/commits/${sha}/status`); }
            catch (e) { if (!String(e.message).includes('404')) throw e; }
          }
        }
        const summary = { total: runs.length, completed: 0, in_progress: 0, queued: 0, pending: 0 };
        const byConclusion = {};
        for (const r of runs) {
          if (r.status === 'completed') summary.completed++;
          else if (r.status === 'in_progress') { summary.in_progress++; summary.pending++; }
          else if (r.status === 'queued') { summary.queued++; summary.pending++; }
          byConclusion[r.conclusion || r.status] = (byConclusion[r.conclusion || r.status] || 0) + 1;
        }
        const failed = ['failure', 'action_required', 'timed_out', 'cancelled'].some(c => byConclusion[c]);
        const pending = summary.pending > 0;
        const nonBlocking = (byConclusion.skipped || 0) + (byConclusion.neutral || 0);
        const meaningful = runs.length - nonBlocking;
        let status;
        if (!runs.length && commitStatus) {
          if (!commitStatus.total_count || commitStatus.state === 'no-status') {
            status = 'no-checks';
          } else {
            const cs = commitStatus.state;
            status = cs === 'success' ? 'success' : (cs === 'pending' ? 'pending' : 'failure');
          }
        } else if (!runs.length) {
          status = 'no-checks';
        } else if (failed) {
          status = 'failure';
        } else if (pending) {
          status = 'pending';
        } else if (meaningful > 0 && (byConclusion.success || 0) === meaningful) {
          status = 'success';
        } else {
          status = 'neutral';
        }
        return {
          repo,
          pr_number,
          pr: {
            number: pr.number,
            title: pr.title,
            state: pr.state,
            draft: pr.draft,
            merged: pr.merged,
            mergeable: pr.mergeable,
            head_sha: pr.head?.sha,
            url: pr.html_url,
          },
          ci: {
            status,
            check_runs_total: runs.length,
            check_runs_failed: failed ? Object.keys(byConclusion).filter(c => ['failure', 'action_required', 'timed_out', 'cancelled'].includes(c)).map(c => ({ conclusion: c, count: byConclusion[c] })) : [],
            commit_status_state: commitStatus?.state,
          },
          summary,
          check_runs: runs.map(r => ({
            name: r.name,
            workflow_name: r.app?.name,
            status: r.status,
            conclusion: r.conclusion,
            started_at: r.started_at,
            completed_at: r.completed_at,
            details_url: r.html_url,
          })),
        };
      },
    },

    github_create_pr: {
      description: 'Create a pull request in a GitHub repository.',
      inputSchema: {
        type: 'object',
        required: ['repo', 'title', 'head', 'base'],
        properties: {
          repo: { type: 'string', description: 'owner/repo' },
          title: { type: 'string', description: 'PR title' },
          head: { type: 'string', description: 'Source branch (e.g. feature/my-feature)' },
          base: { type: 'string', description: 'Target branch (e.g. main)' },
          body: { type: 'string', description: 'PR description (Markdown)' },
          draft: { type: 'boolean', description: 'Create as draft PR' },
        },
      },
      handler: async ({ repo, title, head, base, body, draft = false }) => {
        const pr = await ghFetch(`/repos/${repo}/pulls`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, head, base, body, draft }),
        });
        return {
          number: pr.number,
          title: pr.title,
          state: pr.state,
          draft: pr.draft,
          url: pr.html_url,
        };
      },
    },

    github_search: {
      description: 'Search GitHub: code, issues, repositories, or users.',
      inputSchema: {
        type: 'object',
        required: ['query', 'type'],
        properties: {
          query: { type: 'string', description: 'Search query (GitHub search syntax supported)' },
          type: { type: 'string', enum: ['code', 'issues', 'repositories', 'users'], description: 'What to search' },
          limit: { type: 'number', description: 'Max results (default 10)' },
        },
      },
      handler: async ({ query, type, limit = 10 }) => {
        const n = Math.min(limit || 10, 30);
        const data = await ghFetch(`/search/${type}?q=${encodeURIComponent(query)}&per_page=${n}`);
        return {
          total_count: data.total_count,
          results: data.items?.map(item => {
            if (type === 'code') return { repo: item.repository.full_name, path: item.path, url: item.html_url };
            if (type === 'issues') return { number: item.number, title: item.title, state: item.state, repo: item.repository_url.split('/').slice(-2).join('/'), url: item.html_url };
            if (type === 'repositories') return { full_name: item.full_name, description: item.description, stars: item.stargazers_count, url: item.html_url };
            if (type === 'users') return { login: item.login, type: item.type, url: item.html_url };
            return item;
          }) ?? [],
        };
      },
    },

    github_create_or_update_file: {
      description: 'Create or update a file in a GitHub repository via the API.',
      inputSchema: {
        type: 'object',
        required: ['repo', 'path', 'content', 'message'],
        properties: {
          repo: { type: 'string', description: 'owner/repo' },
          path: { type: 'string', description: 'File path in repo' },
          content: { type: 'string', description: 'File content (UTF-8 text)' },
          message: { type: 'string', description: 'Commit message' },
          branch: { type: 'string', description: 'Branch (default: default branch)' },
          sha: { type: 'string', description: 'SHA of the file to update (required when updating existing file)' },
        },
      },
      handler: async ({ repo, path: filePath, content, message, branch, sha }) => {
        const body = {
          message,
          content: Buffer.from(content, 'utf8').toString('base64'),
        };
        if (branch) body.branch = branch;
        if (sha) body.sha = sha;

        const data = await ghFetch(`/repos/${repo}/contents/${filePath}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return {
          path: data.content.path,
          sha: data.content.sha,
          url: data.content.html_url,
          commit: data.commit.sha,
        };
      },
    },

  },
};
