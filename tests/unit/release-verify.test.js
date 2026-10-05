// The release-pointer invariant (prod incident 2026-10-04).
//
// A pointer may only ever be flipped at a release that VERIFIES — a whole,
// immutable snapshot. `.release-complete` alone was not enough: it is one file, so
// a snapshot whose other contents were removed still passed the "already built"
// check, the deploy reported success, ~/agent-master was repointed at a directory
// that did not exist, and the service restarted onto it — alive on already-loaded
// modules while every lazy require() failed and /readiness answered 500.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const LIB = path.resolve(__dirname, '../../scripts/release-lib.sh');
const sha = (c) => c.repeat(40);

/** A release snapshot that passes release_verify. */
function makeRelease(dir, rev, { deps = true } = {}) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'server.js'), '// entry');
  fs.writeFileSync(path.join(dir, '.release-complete'), '');
  fs.writeFileSync(path.join(dir, '.release-sha'), `${rev}\n`);
  if (deps) fs.mkdirSync(path.join(dir, 'node_modules'));
}

function sh(script) {
  return execFileSync('bash', ['-c', `set -euo pipefail; SUDO=""; . "${LIB}"\n${script}`], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function shFails(script) {
  try {
    sh(script);
    return false;
  } catch {
    return true;
  }
}

describe('release_verify — релиз это релиз, а не один маркер', () => {
  it('принимает целый снимок с правильной ревизией', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relok-'));
    makeRelease(dir, sha('a'));
    expect(sh(`release_verify "${dir}" "${sha('a')}" && echo OK`)).toContain('OK');
  });

  it('отвергает каталог, потерявший файлы, НО сохранивший .release-complete', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relbroken-'));
    makeRelease(dir, sha('a'));
    // Ровно сценарий инцидента: маркер цел, содержимое вырезано.
    fs.rmSync(path.join(dir, 'src'), { recursive: true });
    fs.rmSync(path.join(dir, 'node_modules'), { recursive: true });
    expect(shFails(`release_verify "${dir}" "${sha('a')}"`)).toBe(true);
  });

  it('отвергает отсутствующий каталог и битую ссылку', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relmissing-'));
    expect(shFails(`release_verify "${path.join(root, 'nope')}"`)).toBe(true);
    const dangling = path.join(root, 'dangling');
    fs.symlinkSync(path.join(root, 'gone'), dangling);
    expect(shFails(`release_verify "${dangling}"`)).toBe(true);
  });

  it('отвергает снимок, собранный из другой ревизии', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relrev-'));
    makeRelease(dir, sha('a'));
    expect(shFails(`release_verify "${dir}" "${sha('b')}"`)).toBe(true);
  });

  it('требует node_modules, если зависимости не пропущены', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reldeps-'));
    makeRelease(dir, sha('a'), { deps: false });
    expect(shFails(`release_verify "${dir}" "${sha('a')}"`)).toBe(true);
  });
});

describe('release_set_link — указатель не может уйти в пустоту', () => {
  it('переключается на верифицированный релиз', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rellink-'));
    const releases = path.join(root, 'agent-releases');
    fs.mkdirSync(releases);
    const old = path.join(releases, sha('a'));
    const next = path.join(releases, sha('b'));
    makeRelease(old, sha('a'));
    makeRelease(next, sha('b'));
    const link = path.join(root, 'agent-master');
    sh(`release_set_link "${link}" "${old}"`);
    sh(`release_set_link "${link}" "${next}"`);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(next));
  });

  it('отказывается указывать на несуществующий каталог и НЕ трогает прежний', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relgone-'));
    const good = path.join(root, sha('a'));
    makeRelease(good, sha('a'));
    const link = path.join(root, 'agent-master');
    sh(`release_set_link "${link}" "${good}"`);
    // Цель исчезла между сборкой и переключением — сценарий инцидента.
    expect(shFails(`release_set_link "${link}" "${path.join(root, sha('b'))}"`)).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(good));
  });

  it('отказывается указывать на снимок с маркером, но без файлов', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relhalf-'));
    const good = path.join(root, sha('a'));
    makeRelease(good, sha('a'));
    const link = path.join(root, 'agent-master');
    sh(`release_set_link "${link}" "${good}"`);
    const half = path.join(root, sha('c'));
    fs.mkdirSync(half);
    fs.writeFileSync(path.join(half, '.release-complete'), '');
    expect(shFails(`release_set_link "${link}" "${half}"`)).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(good));
  });
});

describe('release_gc — живой релиз не удаляется даже после отката', () => {
  it('не трогает защищённый релиз, даже если он старше трёх новых', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relprot-'));
    const releases = path.join(root, 'agent-releases');
    fs.mkdirSync(releases);
    const shas = ['a', 'b', 'c', 'd', 'e'].map(sha);
    shas.forEach((s, i) => {
      const d = path.join(releases, s);
      fs.mkdirSync(d);
      fs.utimesSync(d, 1000 + i, 1000 + i); // a — старейший (это откат)
    });
    // Откат: живёт a, а три новых — b/c/d.
    sh(`release_gc "${releases}" 3 "${path.join(releases, sha('a'))}"`);
    expect(fs.existsSync(path.join(releases, sha('a')))).toBe(true);
  });

  it('без защиты удаляет старые как раньше (поведение не сломано)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relgc2-'));
    const releases = path.join(root, 'agent-releases');
    fs.mkdirSync(releases);
    const shas = ['a', 'b', 'c', 'd', 'e'].map(sha);
    shas.forEach((s, i) => {
      const d = path.join(releases, s);
      fs.mkdirSync(d);
      fs.utimesSync(d, 1000 + i, 1000 + i);
    });
    sh(`release_gc "${releases}" 3`);
    expect(fs.existsSync(path.join(releases, sha('e')))).toBe(true);
    expect(fs.existsSync(path.join(releases, sha('a')))).toBe(false);
  });
});
