// The shared web//run intake materializer (src/intake-materializer.js). Vitest so it
// rides the existing `vitest run` suite without a package.json test:cjs union-line edit
// (that line is a rebase conflict hotspot).
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { materializeFileRefs, buildFileNote } = require('../../src/intake-materializer');
const here = dirname(fileURLToPath(import.meta.url));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'shared-media-'));
  const workDir = join(root, 'alice');
  mkdirSync(workDir, { recursive: true });
  return { root, workDir };
}

describe('shared intake materializer', () => {
  it('copies local refs, fsyncs, and creates the canonical note', async () => {
    const f = fixture();
    try {
      const id = 'a'.repeat(64), store = join(f.workDir, 'media', 'intake-store', id);
      mkdirSync(store, { recursive: true });
      writeFileSync(join(store, 'data'), 'bytes');
      writeFileSync(join(store, 'meta.json'), JSON.stringify({ name: 'CV.pdf', mime: 'application/pdf' }));
      const out = await materializeFileRefs({ workDir: f.workDir, username: 'alice', fileRefs: [{ id }], task: 'analyse', engine: 'claude' });
      expect(out.task).toMatch(/Файл сохранён:/);
      expect(out.task).toMatch(/analyse/);
      expect(out.fileRefs[0].name).toBe('CV.pdf');
      expect(out.fileRefs[0].mime).toBe('application/pdf');
      expect(readFileSync(join(f.workDir, 'media', 'intake', `${id}-CV.pdf`), 'utf8')).toBe('bytes');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('performs OCR for an opencode image note but not for claude', async () => {
    const f = fixture();
    try {
      const file = join(f.workDir, 'x.png'); writeFileSync(file, 'img');
      let calls = 0;
      const vision = { extractImageText: async () => { calls++; return { ok: true, text: 'TEXT FROM IMAGE' }; } };
      const opencode = await buildFileNote({ filePath: file, mimeType: 'image/png', engine: 'opencode', openrouterKey: 'k', vision });
      expect(opencode).toMatch(/TEXT FROM IMAGE/);
      expect(calls).toBe(1);
      const claude = await buildFileNote({ filePath: file, mimeType: 'image/png', engine: 'claude', openrouterKey: 'k', vision });
      expect(claude).not.toMatch(/TEXT FROM IMAGE/);
      expect(calls).toBe(1);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('materializes a ref marked note:false without a file note', async () => {
    const f = fixture();
    try {
      const id = 'c'.repeat(64), store = join(f.workDir, 'media', 'intake-store', id);
      mkdirSync(store, { recursive: true });
      writeFileSync(join(store, 'data'), 'voice');
      writeFileSync(join(store, 'meta.json'), JSON.stringify({ name: 'voice.ogg', mime: 'audio/ogg' }));
      const out = await materializeFileRefs({ workDir: f.workDir, username: 'alice', fileRefs: [{ id, note: false }], task: 'transcribe', engine: 'claude' });
      expect(out.task).toBe('transcribe');
      expect(readFileSync(join(f.workDir, 'media', 'intake', `${id}-voice.ogg`), 'utf8')).toBe('voice');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('web and /run source both delegate fileRefs to intake-materializer', () => {
    const web = readFileSync(join(here, '../../src/web-routes.js'), 'utf8');
    const server = readFileSync(join(here, '../../src/server.js'), 'utf8');
    expect(web).toMatch(/intake-materializer/);
    expect(server).toMatch(/materializeFileRefs\(\{/);
    expect(web).not.toMatch(/copyFileSync\(src, filePath\)/);
  });
});
