'use strict';

const fs = require('fs');
const path = require('path');
const { userWorkDir, writeMode } = require('./data-paths');

function sitesRoot(username) {
  // Connected-site config lives in the profile workspace (USERS_ROOT/<u>/sites).
  return path.join(userWorkDir(username), 'sites');
}

function slugFor(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').toLowerCase().replace(/^-|-$/g, '');
  } catch {
    return 'site-' + Date.now();
  }
}

function listSites(username) {
  const root = sitesRoot(username);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter(f => {
      try { return fs.statSync(path.join(root, f)).isDirectory(); } catch { return false; }
    })
    .map(slug => {
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(root, slug, 'config.json'), 'utf8'));
        return { slug, ...cfg };
      } catch { return { slug, status: 'unknown' }; }
    });
}

function getSite(username, slug) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sitesRoot(username), slug, 'config.json'), 'utf8'));
  } catch { return null; }
}

function saveSiteConfig(username, slug, config) {
  const dir = path.join(sitesRoot(username), slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

function saveSiteCreds(username, slug, creds) {
  const dir = path.join(sitesRoot(username), slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify(creds), writeMode(0o600));
}

function readSiteCreds(username, slug) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sitesRoot(username), slug, 'creds.json'), 'utf8'));
  } catch { return null; }
}

function saveCrawlReport(username, slug, report) {
  fs.writeFileSync(
    path.join(sitesRoot(username), slug, 'crawl.json'),
    JSON.stringify(report, null, 2)
  );
}

function readCrawlReport(username, slug) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sitesRoot(username), slug, 'crawl.json'), 'utf8'));
  } catch { return null; }
}

function saveIntents(username, slug, intents) {
  fs.writeFileSync(
    path.join(sitesRoot(username), slug, 'intents.json'),
    JSON.stringify(intents, null, 2)
  );
}

function readIntents(username, slug) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sitesRoot(username), slug, 'intents.json'), 'utf8'));
  } catch { return []; }
}

function saveStorageState(username, slug, state) {
  const dir = path.join(sitesRoot(username), slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'storage-state.json'), JSON.stringify(state), writeMode(0o600));
}

function readStorageState(username, slug) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sitesRoot(username), slug, 'storage-state.json'), 'utf8'));
  } catch { return null; }
}

// Returns all site intents for a user, merged across all connected sites
function loadUserSiteIntents(username) {
  const sites = listSites(username);
  const result = [];
  for (const site of sites) {
    if (site.status !== 'connected') continue;
    const intents = readIntents(username, site.slug);
    for (const intent of intents) {
      result.push({ ...intent, siteName: site.name || site.slug, siteUrl: site.url, slug: site.slug });
    }
  }
  return result;
}

module.exports = {
  slugFor,
  listSites,
  getSite,
  saveSiteConfig,
  saveSiteCreds,
  readSiteCreds,
  saveCrawlReport,
  readCrawlReport,
  saveIntents,
  readIntents,
  saveStorageState,
  readStorageState,
  loadUserSiteIntents,
};
