'use strict';

// api-from-website — DRAFT skill
//
// Goal: if we have a login for a site, we can treat it as an API.
// Phase 1 (this file): store credentials, list sites, make authenticated requests.
// Phase 2 (TODO): auto-discover endpoints via Playwright/browser-session — crawl
//   the site while logged in, capture XHR/fetch calls, build an endpoint catalog.
//
// Credentials are encrypted at rest through src/credential-store.js (#1789 P0 C4).
// Still designed for internal/partner sites, not high-security accounts.
//
// Storage layout:
//   ~/agent-tokens/{userId}/sites/{slug}.json  — { url, login, password, notes, saved_at }

const fs = require('fs');
const path = require('path');
const { tokensRoot } = require('../../data-paths');
const { readCredentialFile, writeCredentialFile } = require('../../credential-store');

const USER_ID = process.env.USER_ID || '';

function sitesDir(userId) {
  const base = tokensRoot();
  return path.join(base, String(userId || USER_ID), 'sites');
}

function slugify(url) {
  return url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
}

function listSites(userId) {
  const dir = sitesDir(userId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(readCredentialFile(path.join(dir, f))); }
      catch { return null; }
    })
    .filter(Boolean);
}

function readSite(slug, userId) {
  const file = path.join(sitesDir(userId), `${slug}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(readCredentialFile(file)); }
  catch { return null; }
}

function saveSite(slug, data, userId) {
  const dir = sitesDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  writeCredentialFile(
    path.join(dir, `${slug}.json`),
    JSON.stringify({ ...data, saved_at: new Date().toISOString() }, null, 2)
  );
}

module.exports = {
  // Always available — no external token needed
  isReady: () => true,
  setupTools: ['website_credentials_save'],

  tools: {

    website_credentials_save: {
      description: 'Save login credentials for a website so future tools can use them to make authenticated requests or explore the site. Credentials are stored locally (plain text, mode 0o600).',
      inputSchema: {
        type: 'object',
        properties: {
          url:      { type: 'string',  description: 'Base URL of the site, e.g. "https://partner-crm.example.com"' },
          login:    { type: 'string',  description: 'Username or email' },
          password: { type: 'string',  description: 'Password (stored plain text — use only for internal/non-critical sites)' },
          notes:    { type: 'string',  description: 'Optional notes, e.g. "admin panel for Acme Corp; login page at /admin/login"' },
        },
        required: ['url', 'login', 'password'],
      },
      handler: async ({ url, login, password, notes = '' }) => {
        const slug = slugify(url);
        saveSite(slug, { slug, url, login, password, notes });
        return {
          saved: true,
          slug,
          url,
          note: 'Credentials saved. Use website_discover to explore what\'s available on this site, or website_request to call specific endpoints.',
        };
      },
    },

    website_credentials_list: {
      description: 'List all sites we have credentials for.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const sites = listSites(USER_ID);
        if (sites.length === 0) {
          return { sites: [], hint: 'No sites yet. Use website_credentials_save to add one.' };
        }
        return {
          sites: sites.map(s => ({
            slug: s.slug,
            url: s.url,
            login: s.login,
            notes: s.notes || '',
            saved_at: s.saved_at,
          })),
        };
      },
    },

    website_request: {
      description: 'Make an HTTP request to a saved website, injecting stored credentials. Supports Basic Auth, Bearer token, or form-based cookie sessions. For form-based login the first call logs in and caches the session cookie for the process lifetime.',
      inputSchema: {
        type: 'object',
        properties: {
          slug:        { type: 'string',  description: 'Site slug from website_credentials_list' },
          path:        { type: 'string',  description: 'URL path or full URL, e.g. "/api/orders" or "https://site.com/api/orders"' },
          method:      { type: 'string',  enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], description: 'HTTP method (default GET)' },
          body:        { type: 'object',  description: 'Request body for POST/PUT/PATCH (sent as JSON)' },
          auth_type:   { type: 'string',  enum: ['basic', 'bearer', 'none'], description: 'Auth strategy: basic = Basic Auth header, bearer = Authorization: Bearer <password>, none = no auth (default basic)' },
          headers:     { type: 'object',  description: 'Extra headers to include' },
        },
        required: ['slug', 'path'],
      },
      handler: async ({ slug, path: urlPath, method = 'GET', body, auth_type = 'basic', headers: extraHeaders = {} }) => {
        const site = readSite(slug, USER_ID);
        if (!site) return { error: `Site "${slug}" not found. Check website_credentials_list.` };

        const url = urlPath.startsWith('http') ? urlPath : `${site.url.replace(/\/$/, '')}${urlPath}`;

        const authHeaders = {};
        if (auth_type === 'basic') {
          const b64 = Buffer.from(`${site.login}:${site.password}`).toString('base64');
          authHeaders['Authorization'] = `Basic ${b64}`;
        } else if (auth_type === 'bearer') {
          authHeaders['Authorization'] = `Bearer ${site.password}`;
        }

        const res = await fetch(url, {
          method,
          headers: {
            'User-Agent': 'trained-assist-agent/1.0',
            'Content-Type': body ? 'application/json' : undefined,
            ...authHeaders,
            ...extraHeaders,
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(20_000),
        });

        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = text.slice(0, 2000); }

        return {
          status: res.status,
          ok: res.ok,
          url,
          headers: Object.fromEntries([...res.headers.entries()].slice(0, 10)),
          body: data,
        };
      },
    },

    website_discover: {
      description: 'DRAFT: discover what API endpoints / pages a saved site exposes. Currently returns a guide for manual exploration. Full auto-discovery via Playwright is planned (Phase 2).',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Site slug from website_credentials_list' },
        },
        required: ['slug'],
      },
      handler: async ({ slug }) => {
        const site = readSite(slug, USER_ID);
        if (!site) return { error: `Site "${slug}" not found.` };

        // Phase 1: try a few common API discovery endpoints
        const probes = ['/api', '/api/v1', '/api/v2', '/swagger.json', '/openapi.json', '/api-docs', '/sitemap.xml'];
        const results = [];

        for (const p of probes) {
          try {
            const url = `${site.url.replace(/\/$/, '')}${p}`;
            const b64 = Buffer.from(`${site.login}:${site.password}`).toString('base64');
            const res = await fetch(url, {
              headers: {
                'Authorization': `Basic ${b64}`,
                'User-Agent': 'trained-assist-agent/1.0',
                'Accept': 'application/json, text/html',
              },
              signal: AbortSignal.timeout(5_000),
              redirect: 'manual',
            });
            if (res.status < 400 && res.status !== 302) {
              const ct = res.headers.get('content-type') || '';
              results.push({ path: p, status: res.status, content_type: ct });
            }
          } catch { /* probe failed — skip */ }
        }

        return {
          site: { slug: site.slug, url: site.url },
          probed_paths: probes,
          found: results,
          phase2_todo: 'Full Playwright-based discovery: log in via browser, capture XHR/fetch, build endpoint catalog. Use browser_session_remote_url + browser_session_capture_cookies if needed.',
          next_steps: results.length > 0
            ? `Try website_request with slug="${slug}" and the paths found above`
            : `No standard API paths found. Try website_request manually with known paths, or use browser_session to log in and capture real API calls.`,
        };
      },
    },

  },
};
