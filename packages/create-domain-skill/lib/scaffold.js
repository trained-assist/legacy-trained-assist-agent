'use strict';

// create-domain-skill — scaffold a trained-assist-<domain>-skill repo that already
// follows docs/domain-skill-repo-test-rules.md: 3-layer CI, testkit wired,
// mandatory suites.json and a user-scenario stub.

const fs = require('fs');
const { join, dirname, relative, sep } = require('path');
const { artifactDigest } = require('../../mcp-skill-testkit/lib/artifact-digest');

const TEMPLATES = join(__dirname, '..', 'templates');
const DOMAIN_RE = /^[a-z][a-z0-9-]*$/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function render(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

function createDomainSkill({ domain, domainName, repository, targetDir, overwrite = false } = {}) {
  if (!domain || !DOMAIN_RE.test(domain)) {
    throw new Error(`createDomainSkill: "domain" must match ${DOMAIN_RE} (got ${JSON.stringify(domain)})`);
  }
  const name = domainName || domain;
  const repo = repository || `trained-assist/trained-assist-${domain}-skill`;
  const dest = targetDir || `trained-assist-${domain}-skill`;
  const vars = { domain, domainName: name, repository: repo, year: new Date().getFullYear() };

  const written = [];
  const writeFile = (rel, content) => {
    const full = join(dest, rel);
    if (fs.existsSync(full) && !overwrite) throw new Error(`createDomainSkill: refusing to overwrite ${full} (pass overwrite:true)`);
    fs.mkdirSync(dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    written.push(rel);
  };

  // Pass 1: every template except the manifest. The manifest is rendered after,
  // so artifactDigest can be computed from the real files on disk.
  for (const file of walk(TEMPLATES).sort()) {
    const rel = render(relative(TEMPLATES, file).split(sep).join('/'), vars);
    if (rel === 'mcp.manifest.json') continue;
    writeFile(rel, render(fs.readFileSync(file, 'utf8'), vars));
  }

  const revision = '0'.repeat(40); // replaced by `npm run manifest:sync` on release
  const digest = artifactDigest(join(dest, 'src', 'mcp-skills'));
  writeFile('mcp.manifest.json', render(fs.readFileSync(join(TEMPLATES, 'mcp.manifest.json'), 'utf8'), {
    ...vars, revision, artifactDigest: digest,
  }));

  return { targetDir: dest, domain, domainName: name, repository: repo, artifactDigest: digest, files: written.sort() };
}

module.exports = { createDomainSkill, DOMAIN_RE };
