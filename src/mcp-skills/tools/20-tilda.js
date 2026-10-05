'use strict';

// Tilda Site Ops skill
// Interacts with Tilda's internal API using session cookies from a storage state file.
// Storage state is captured via tilda-site-ops-skill scripts (manual browser login).
// Config stored in ~/agent-tokens/{USER_ID}/tilda as JSON.
//
// Workflow: edit on test page first → publish → user reviews → apply to prod → publish prod

const fs = require('fs');
const path = require('path');
const { tokenPath } = require('../../data-paths');
const os = require('os');
const { readCredentialFile, writeCredentialFile } = require('../../credential-store');

const USER_ID = process.env.USER_ID || '';
const TILDA_BASE = 'https://tilda.ru';

// ── Config ────────────────────────────────────────────────────────────────────

function configPath(userId) {
  return tokenPath(String(userId || USER_ID), 'tilda');
}

function readConfig(userId) {
  const file = configPath(userId);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(readCredentialFile(file)); } catch { return null; }
}

function writeConfig(userId, data) {
  writeCredentialFile(configPath(userId), JSON.stringify(data, null, 2));
}

// ── Auth ──────────────────────────────────────────────────────────────────────

// tilda-session file: raw cookie string saved by Chrome extension from tilda.ru
// Format: "userid=12345; hash=abcdef; ..."
function sessionPath(userId) {
  return tokenPath(String(userId || USER_ID), 'tilda-session');
}

function readSessionCookies(userId) {
  const file = sessionPath(userId);
  if (!fs.existsSync(file)) return null;
  const val = readCredentialFile(file).trim();
  return val || null;
}

function cookieStringHasAuth(cookieStr) {
  // Tilda cookie names vary — just check the string is non-trivially populated.
  // Real auth validation happens via API call (getprojects returns login page on failure).
  return cookieStr && cookieStr.length > 20;
}

// Fallback: Playwright storage-state JSON (local dev / manual capture)
function loadStorageState(stateFile) {
  if (!stateFile) return null;
  const expanded = stateFile.startsWith('~/')
    ? path.join(os.homedir(), stateFile.slice(2))
    : stateFile;
  if (!fs.existsSync(expanded)) return null;
  try { return JSON.parse(fs.readFileSync(expanded, 'utf8')); } catch { return null; }
}

function extractCookieHeaderFromState(storageState) {
  const cookies = (storageState?.cookies || []).filter(c =>
    c.domain && c.domain.includes('tilda')
  );
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

function storageStateHasAuth(storageState) {
  const cookies = (storageState?.cookies || []);
  const names = new Set(cookies.filter(c => c.domain?.includes('tilda')).map(c => c.name));
  return names.has('userid') && names.has('hash');
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

async function tildaPost(urlPath, data, cookieHeader) {
  const res = await fetch(`${TILDA_BASE}${urlPath}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      'cookie': cookieHeader,
      'referer': `${TILDA_BASE}/`,
      'origin': TILDA_BASE,
    },
    body: new URLSearchParams(data).toString(),
  });
  const text = await res.text();
  return { status: res.status, text: text.replace(/^<!--tlp-->/, '') };
}

async function getProjectData(projectId, cookieHeader) {
  const res = await tildaPost('/projects/get/getprojects/', {
    comm: 'getprojectslist',
    projectid: projectId,
  }, cookieHeader);
  if (/login|not authorized|sign in/i.test(res.text) || res.status >= 400) {
    throw new Error(`Auth failed: status=${res.status} preview="${res.text.slice(0, 200)}"`);
  }
  try {
    const data = JSON.parse(res.text);
    if (!data.csrf) throw new Error('No csrf in project response');
    return data;
  } catch (e) {
    throw new Error(`getprojects failed: ${e.message} — preview: ${res.text.slice(0, 200)}`);
  }
}

// ── HTTP: projects list without known project_id ───────────────────────────────

async function listAllProjects(cookieHeader) {
  // Tilda returns project list when projectid is omitted
  const res = await tildaPost('/projects/get/getprojects/', { comm: 'getprojectslist' }, cookieHeader);
  if (res.status >= 400 || /login|not authorized|sign in/i.test(res.text)) {
    throw new Error(`Auth failed: ${res.text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error(`getprojects did not return JSON: ${res.text.slice(0, 200)}`);
  }
}

// ── Context helper ────────────────────────────────────────────────────────────

// When session expires, guide user to re-connect via ZeroCreds form
const REAUTH_INSTRUCTIONS = 'Сессия Tilda истекла. Скажи «подключи тильду» — получишь ссылку для повторного входа (email + пароль через защищённую форму).';

async function withAuth(userId, fn) {
  const config = readConfig(userId);
  if (!config) return { error: 'No Tilda config. Run tilda_set_config first.' };
  if (!config.project_id) return { error: 'No project_id in config. Run tilda_set_config.' };

  // Priority 1: tilda-session file from Chrome extension (userid; hash cookie string)
  let cookieHeader = readSessionCookies(userId);
  if (cookieHeader && !cookieStringHasAuth(cookieHeader)) {
    cookieHeader = null; // stale/empty file
  }

  // Priority 2: Playwright storage-state file (local dev / manual capture)
  if (!cookieHeader && config.storage_state) {
    const state = loadStorageState(config.storage_state);
    if (state && storageStateHasAuth(state)) {
      cookieHeader = extractCookieHeaderFromState(state);
    }
  }

  if (!cookieHeader) {
    return {
      error: 'session_expired',
      requires_reauth: true,
      instructions: REAUTH_INSTRUCTIONS,
    };
  }

  return fn(config, cookieHeader);
}

// ── Tools ─────────────────────────────────────────────────────────────────────

module.exports = {
  isReady: () => {
    const cookies = readSessionCookies(USER_ID);
    return cookieStringHasAuth(cookies);
  },
  setupTools: ['tilda_set_config', 'tilda_status'],

  tools: {

    tilda_list_all_projects: {
      description: 'List all Tilda projects for the current user. Use this during onboarding to let the user pick a project by name instead of guessing the project ID.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const cookieHeader = readSessionCookies(USER_ID);
        if (!cookieHeader || !cookieStringHasAuth(cookieHeader)) {
          return {
            error: 'session_expired',
            requires_reauth: true,
            instructions: REAUTH_INSTRUCTIONS,
          };
        }
        try {
          const data = await listAllProjects(cookieHeader);
          const projects = (data.projects || data.pages || []).map(p => ({
            id: p.id,
            title: p.title || p.name,
            pages_count: p.pagescount || p.pages_count,
            domain: p.domain,
          }));
          return { projects_count: projects.length, projects };
        } catch (e) {
          if (e.message.includes('Auth failed')) {
            return { error: 'session_expired', requires_reauth: true, instructions: REAUTH_INSTRUCTIONS };
          }
          return { error: e.message };
        }
      },
    },

    tilda_set_config: {
      description: 'Save Tilda project config: project ID, test/production page IDs and URLs. Call after tilda_list_all_projects to configure which project and pages to use.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id:    { type: 'string', description: 'Tilda project ID (from tilda_list_all_projects)' },
          test_page_id:  { type: 'string', description: 'Test/staging page ID — changes go here first' },
          prod_page_id:  { type: 'string', description: 'Production page ID — changes go here after approval' },
          test_url:      { type: 'string', description: 'Public URL of the test page (for QA verification)' },
          prod_url:      { type: 'string', description: 'Public URL of the production page (for QA verification)' },
          storage_state: { type: 'string', description: 'Optional: path to Playwright storage state JSON (fallback auth if extension session expires)' },
        },
        required: ['project_id'],
      },
      handler: async ({ project_id, test_page_id, prod_page_id, test_url, prod_url, storage_state }) => {
        const config = readConfig(USER_ID) || {};
        const updated = { ...config, project_id };
        if (storage_state !== undefined) updated.storage_state = storage_state;
        if (test_page_id !== undefined) updated.test_page_id = test_page_id;
        if (prod_page_id !== undefined) updated.prod_page_id = prod_page_id;
        if (test_url !== undefined) updated.test_url = test_url;
        if (prod_url !== undefined) updated.prod_url = prod_url;
        writeConfig(USER_ID, updated);
        return { ok: true, config: updated };
      },
    },

    tilda_status: {
      description: 'Check Tilda auth status and show current config. Call before any Tilda work to confirm session is valid.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const config = readConfig(USER_ID);
        if (!config) return {
          ok: false,
          reason: 'not_configured',
          instructions: 'Run tilda_set_config with storage_state path and project_id.',
        };

        // Check which session source is available
        const sessionCookies = readSessionCookies(USER_ID);
        const hasSession = sessionCookies && cookieStringHasAuth(sessionCookies);
        const hasStorageState = config.storage_state && (() => {
          const s = loadStorageState(config.storage_state);
          return s && storageStateHasAuth(s);
        })();

        if (!hasSession && !hasStorageState) {
          return {
            ok: false,
            reason: 'session_expired',
            requires_reauth: true,
            instructions: REAUTH_INSTRUCTIONS,
          };
        }

        const cookieHeader = hasSession
          ? sessionCookies
          : extractCookieHeaderFromState(loadStorageState(config.storage_state));

        try {
          const project = await getProjectData(config.project_id, cookieHeader);
          return {
            ok: true,
            session_source: hasSession ? 'chrome_extension' : 'storage_state_file',
            project_id: config.project_id,
            test_page_id: config.test_page_id || '(not set)',
            prod_page_id: config.prod_page_id || '(not set)',
            test_url: config.test_url || '(not set)',
            prod_url: config.prod_url || '(not set)',
            pages_count: Array.isArray(project.pages) ? project.pages.length : '?',
          };
        } catch (e) {
          return {
            ok: false,
            reason: e.message,
            requires_reauth: e.message.includes('Auth failed'),
            instructions: e.message.includes('Auth failed') ? REAUTH_INSTRUCTIONS : undefined,
          };
        }
      },
    },

    tilda_list_pages: {
      description: 'List all pages in the configured TILDA project (id, title, alias, published state). For pages the agent published itself via publish_page, use list_published_pages.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => withAuth(USER_ID, async (config, cookieHeader) => {
        const project = await getProjectData(config.project_id, cookieHeader);
        const pages = (project.pages || []).map(p => ({
          id: p.id,
          title: p.title,
          alias: p.alias,
          published: p.published,
          sort: p.sort,
          date: p.date,
        }));
        return { project_id: config.project_id, pages_count: pages.length, pages };
      }),
    },

    tilda_get_page: {
      description: 'Get page data and block list. Use page_id param to specify a page, or leave empty to use the configured test_page_id.',
      inputSchema: {
        type: 'object',
        properties: {
          page_id: { type: 'string', description: 'Page ID. Defaults to test_page_id from config.' },
        },
      },
      handler: async ({ page_id } = {}) => withAuth(USER_ID, async (config, cookieHeader) => {
        const pid = page_id || config.test_page_id;
        if (!pid) return { error: 'No page_id provided and test_page_id not configured.' };

        const res = await tildaPost('/page/get/getpage/', { pageid: pid }, cookieHeader);
        if (res.status >= 400 || /login|not authorized/i.test(res.text)) {
          return { error: `Failed to get page ${pid}: ${res.text.slice(0, 300)}` };
        }
        const data = JSON.parse(res.text);
        const page = data.page || {};
        const blocks = (data.records || []).map(r => ({
          id: r.id,
          tplid: r.tplid,
          title: r.title || r.tag || '',
          sort: r.sort,
          hn: r.hn,
        }));
        return {
          page_id: pid,
          title: page.title,
          alias: page.alias,
          published: page.published,
          nosearch: page.nosearch,
          meta_nofollow: page.meta_nofollow,
          blocks_count: blocks.length,
          blocks,
        };
      }),
    },

    tilda_backup_page: {
      description: 'Backup a page JSON to ~/agent-backups/tilda/ before making changes. Always call before editing.',
      inputSchema: {
        type: 'object',
        properties: {
          page_id: { type: 'string', description: 'Page ID to backup. Defaults to test_page_id from config.' },
        },
      },
      handler: async ({ page_id } = {}) => withAuth(USER_ID, async (config, cookieHeader) => {
        const pid = page_id || config.test_page_id;
        if (!pid) return { error: 'No page_id provided and test_page_id not configured.' };

        const res = await tildaPost('/page/get/getpage/', { pageid: pid }, cookieHeader);
        const data = JSON.parse(res.text);
        const page = data.page || {};

        const backupDir = path.join(os.homedir(), 'agent-backups', 'tilda');
        fs.mkdirSync(backupDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
        const label = (page.alias || page.title || pid).replace(/[^a-z0-9а-яё._-]+/giu, '-').slice(0, 60);
        const backupPath = path.join(backupDir, `page-${pid}-${label}-${ts}.json`);
        fs.writeFileSync(backupPath, JSON.stringify(data, null, 2));

        return { ok: true, page_id: pid, title: page.title, backup_path: backupPath };
      }),
    },

    tilda_create_staging: {
      description: 'Duplicate a production page to create a staging/test copy. Sets nosearch=yes and meta_nofollow=yes. Use when you need a fresh staging page from production.',
      inputSchema: {
        type: 'object',
        properties: {
          source_page_id: { type: 'string', description: 'Page to duplicate. Defaults to prod_page_id from config.' },
          staging_alias:  { type: 'string', description: 'URL alias for the staging page (e.g. "staging-festival-test")' },
          staging_title:  { type: 'string', description: 'Title for the staging page' },
        },
        required: ['staging_alias'],
      },
      handler: async ({ source_page_id, staging_alias, staging_title } = {}) => withAuth(USER_ID, async (config, cookieHeader) => {
        const srcId = source_page_id || config.prod_page_id;
        if (!srcId) return { error: 'No source_page_id and prod_page_id not configured.' };

        const project = await getProjectData(config.project_id, cookieHeader);
        const { csrf } = project;

        // 1. Duplicate
        const dupRes = await tildaPost('/projects/submit/', {
          comm: 'dublicatepage',
          pageid: srcId,
          csrf,
        }, cookieHeader);
        const match = dupRes.text.match(/(\d{5,})/);
        if (!match) return { error: `Duplicate failed: ${dupRes.text.slice(0, 300)}` };
        const newPageId = match[1];

        // 2. Get new page data for existing fields
        const pageRes = await tildaPost('/page/get/getpage/', { pageid: newPageId }, cookieHeader);
        const existing = JSON.parse(pageRes.text).page || {};

        // 3. Save staging settings
        const title = staging_title || `Staging of page ${srcId}`;
        const settingsRes = await tildaPost('/projects/submit/', {
          comm: 'savepagesettings',
          test: 'test4.0',
          projectid: config.project_id,
          pageid: newPageId,
          title,
          alias: staging_alias,
          descr: existing.descr || '',
          meta_title: title,
          meta_descr: existing.meta_descr || '',
          fbtitle: title,
          fbdescr: existing.fb_descr || '',
          fb_title: title,
          fb_descr: existing.fb_descr || '',
          link_canonical: '',
          imgfile: existing.imgfile || '',
          'img-tuinfo-uuid': '',
          'img-tuinfo-cdnurl': '',
          'img-tuinfo-name': '',
          'img-tuinfo-width': '',
          'img-tuinfo-size': '',
          fb_img: '',
          fb_imgfile: existing.fb_imgfile || '',
          'fb_img-tuinfo-uuid': '',
          'fb_img-tuinfo-cdnurl': '',
          'fb_img-tuinfo-name': '',
          'fb_img-tuinfo-width': '',
          'fb_img-tuinfo-size': '',
          fb_url: `/${staging_alias}`,
          fb_appid: existing.fb_appid || '',
          twitter_site: existing.twitter_site || '',
          meta_keywords: existing.meta_keywords || '',
          noheader: existing.noheader || '',
          nofooter: existing.nofooter || '',
          nosearch: 'yes',
          meta_nofollow: 'yes',
          isindex: existing.isindex || '',
          sort: existing.sort || '',
          label: existing.label || '',
          comment: existing.comment || '',
          folderid: existing.folderid || '',
          writing_direction: existing.writing_direction || '',
          date: existing.date || '',
          tag: existing.tag || '',
          shorttitle: existing.shorttitle || '',
          customlink: existing.customlink || '',
          featureimgfile: existing.featureimgfile || '',
          'featureimg-tuinfo-uuid': '',
          'featureimg-tuinfo-cdnurl': '',
          'featureimg-tuinfo-name': '',
          'featureimg-tuinfo-width': '',
          'featureimg-tuinfo-size': '',
          viewpassword: existing.viewpassword || '',
          csrf,
        }, cookieHeader);

        if (settingsRes.text.trim() !== 'OK') {
          return { error: `savepagesettings failed: ${settingsRes.text.slice(0, 300)}`, staging_page_id: newPageId };
        }

        return {
          ok: true,
          source_page_id: srcId,
          staging_page_id: newPageId,
          staging_alias,
          staging_title: title,
          nosearch: 'yes',
          meta_nofollow: 'yes',
          note: `Staging page created. To publish it: call tilda_publish_page with page_id="${newPageId}". To view: open https://[your-domain]/${staging_alias}`,
        };
      }),
    },

    tilda_publish_page: {
      description: 'Publish a Tilda page. IMPORTANT: always publish test page first, get user approval, then publish production.',
      inputSchema: {
        type: 'object',
        properties: {
          page_id: { type: 'string', description: 'Page ID to publish. Defaults to test_page_id from config.' },
          verify_url: { type: 'string', description: 'Optional public URL to verify after publish (checks for 200 OK).' },
          verify_text: { type: 'string', description: 'Optional text that must appear on the published page.' },
        },
      },
      handler: async ({ page_id, verify_url, verify_text } = {}) => withAuth(USER_ID, async (config, cookieHeader) => {
        const pid = page_id || config.test_page_id;
        if (!pid) return { error: 'No page_id provided and test_page_id not configured.' };

        // Auth preflight
        const project = await getProjectData(config.project_id, cookieHeader);
        if (!project.csrf) return { error: 'Auth check failed: no csrf token.' };

        const res = await tildaPost('/page/publish/', {
          projectid: config.project_id,
          pageid: pid,
        }, cookieHeader);

        if (/login|not authorized|sign in/i.test(res.text) || res.status >= 400) {
          return { error: `Publish failed: status=${res.status} preview="${res.text.slice(0, 300)}"` };
        }

        const result = {
          ok: true,
          page_id: pid,
          publish_status: res.status,
          publish_response: res.text.replace(/\s+/g, ' ').slice(0, 300),
        };

        if (verify_url) {
          const checkRes = await fetch(verify_url, { redirect: 'follow' });
          const checkText = await checkRes.text();
          result.verify_url = verify_url;
          result.verify_status = checkRes.status;
          result.verify_ok = checkRes.ok;
          if (verify_text) {
            result.verify_text_found = checkText.includes(verify_text);
          }
        }

        return result;
      }),
    },

    tilda_get_blocks: {
      description: 'Get detailed block content for a page. Returns each block with its template ID and editable content fields.',
      inputSchema: {
        type: 'object',
        properties: {
          page_id: { type: 'string', description: 'Page ID. Defaults to test_page_id from config.' },
        },
      },
      handler: async ({ page_id } = {}) => withAuth(USER_ID, async (config, cookieHeader) => {
        const pid = page_id || config.test_page_id;
        if (!pid) return { error: 'No page_id provided.' };

        const res = await tildaPost('/page/get/getpage/', { pageid: pid }, cookieHeader);
        const data = JSON.parse(res.text);
        const blocks = (data.records || []).map(r => ({
          id: r.id,
          tplid: r.tplid,
          title: r.title || r.tag || '',
          sort: r.sort,
          content: r.jdata || r.ht || {},
        }));
        return { page_id: pid, blocks_count: blocks.length, blocks };
      }),
    },

    tilda_save_block: {
      description: `Save/update a block's content on a Tilda page.
Always work on test_page_id first. Use tilda_get_blocks to see current block IDs and tplids.
content_fields should be the key-value pairs from the block's jdata.
Example: { "ht": "<p>New text</p>", "title": "New title" }`,
      inputSchema: {
        type: 'object',
        properties: {
          page_id:        { type: 'string', description: 'Page ID. Defaults to test_page_id — DO NOT use prod_page_id without user approval.' },
          block_id:       { type: 'string', description: 'Block ID (from tilda_get_blocks)' },
          tplid:          { type: 'string', description: 'Block template ID (from tilda_get_blocks)' },
          content_fields: { type: 'object', description: 'Block content fields as key-value pairs (from block jdata)' },
        },
        required: ['block_id', 'tplid', 'content_fields'],
      },
      handler: async ({ page_id, block_id, tplid, content_fields } = {}) => withAuth(USER_ID, async (config, cookieHeader) => {
        const pid = page_id || config.test_page_id;
        if (!pid) return { error: 'No page_id provided.' };

        const project = await getProjectData(config.project_id, cookieHeader);

        const payload = {
          comm: 'saverecord',
          pageid: pid,
          recordid: block_id,
          tplid,
          csrf: project.csrf,
          ...content_fields,
        };

        const res = await tildaPost('/page/submit/', payload, cookieHeader);

        if (/login|not authorized/i.test(res.text) || res.status >= 400) {
          return { error: `saverecord failed: ${res.text.slice(0, 300)}` };
        }

        return {
          ok: true,
          page_id: pid,
          block_id,
          tplid,
          response: res.text.replace(/\s+/g, ' ').slice(0, 300),
          next_step: `After saving, publish the test page with tilda_publish_page to preview changes.`,
        };
      }),
    },

  },
};
