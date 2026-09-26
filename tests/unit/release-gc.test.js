// release_gc must only ever delete real release dirs (#1509): a sibling-skill
// symlink in agent-releases/ was treated as an old release and `rm -rf link/`
// wiped the real freelance checkout behind it.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const LIB = path.resolve(__dirname, '../../scripts/release-lib.sh');
const sha = (c) => c.repeat(40);

describe('release_gc (#1509)', () => {
  it('keeps the newest N sha releases and never touches sibling symlinks or their targets', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relgc-'));
    const releases = path.join(root, 'agent-releases');
    fs.mkdirSync(releases);
    const shas = ['a', 'b', 'c', 'd', 'e'].map(sha);
    shas.forEach((s, i) => {
      const d = path.join(releases, s);
      fs.mkdirSync(d);
      fs.utimesSync(d, 1000 + i, 1000 + i);          // e newest, a oldest
    });
    const siblings = ['trained-assist-hh-skill', 'trained-assist-freelance-skill', 'trained-assist-engineering', 'trained-assist-future-skill'];
    for (const s of siblings) {
      const target = path.join(root, s);
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'index.js'), 'x');
      fs.symlinkSync(target, path.join(releases, s));
    }
    // An oldest-mtime real dir that is not a sha must survive too (not ours to GC).
    fs.mkdirSync(path.join(releases, 'manual-backup'));
    fs.utimesSync(path.join(releases, 'manual-backup'), 1, 1);

    execFileSync('bash', ['-c', `SUDO=; . "${LIB}"; release_gc "${releases}" 3`], { stdio: 'pipe' });

    const left = fs.readdirSync(releases).sort();
    expect(left).toEqual([...shas.slice(2), 'manual-backup', ...siblings].sort());
    for (const s of siblings) expect(fs.existsSync(path.join(root, s, 'index.js'))).toBe(true);
  });
});
