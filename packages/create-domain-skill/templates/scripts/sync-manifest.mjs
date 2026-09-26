// Keeps mcp.manifest.json's revision + artifactDigest in sync with the artifact
// on disk. Run before a release: `npm run manifest:sync`.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { artifactDigest } = require('@trained-assist/mcp-skill-testkit');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'mcp.manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

let revision = '0'.repeat(40);
try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { /* not a git checkout */ }

manifest.sources[0].revision = revision;
manifest.sources[0].artifactDigest = artifactDigest(join(root, 'src', 'mcp-skills'));
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest:sync revision=${revision.slice(0, 12)}… digest=${manifest.sources[0].artifactDigest.slice(0, 12)}…`);
