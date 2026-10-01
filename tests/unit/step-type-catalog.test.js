// loadStepTypeCatalog must read the LIVE library shape of software-engineering-playbooks
// (`types` = object keyed by id). Only the array shapes were read before, so the authoring
// prompt's step-type catalog was empty for every profile.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { loadStepTypeCatalog } = require('../../src/playbook-authoring.js');

const dirs = [];
function lib(content) {
  const root = mkdtempSync(join(tmpdir(), 'steptypes-'));
  dirs.push(root);
  mkdirSync(join(root, 'library'));
  writeFileSync(join(root, 'library', 'step-types.json'), JSON.stringify(content));
  return root;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

describe('loadStepTypeCatalog', () => {
  it('reads the object-keyed `types` library', () => {
    const root = lib({ version: 3, types: { sandbox: { purpose: 'loop', execution_kind: 'agent' }, merged: { purpose: 'wait', execution_kind: 'programmatic' } } });
    expect(loadStepTypeCatalog({ siblingRoots: [root] })).toEqual([
      { id: 'sandbox', purpose: 'loop', execution_kind: 'agent' },
      { id: 'merged', purpose: 'wait', execution_kind: 'programmatic' },
    ]);
  });

  it('still reads the legacy array shapes', () => {
    expect(loadStepTypeCatalog({ siblingRoots: [lib([{ id: 'a', purpose: 'p' }])] })[0].id).toBe('a');
    expect(loadStepTypeCatalog({ siblingRoots: [lib({ step_types: [{ id: 'b' }] })] })[0].id).toBe('b');
  });
});
