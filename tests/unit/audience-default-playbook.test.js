// P5 (issue #1462): audience→default playbook resolver + the migrated playbooks.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  resolveAudienceDefaultPlaybookId, suggestPlaybookForAudience, loadAudiencePlaybookMap,
} = require('../../src/audience-default-playbook');
const { PlaybookStore, validatePlaybook } = require('../../src/playbook-store');
const { compilePlaybook } = require('../../src/playbook-compiler');

describe('audience default playbook resolver', () => {
  it('built-in map resolves known audiences', () => {
    expect(resolveAudienceDefaultPlaybookId('freelance', { env: {} })).toBe('freelance-project-spec');
    expect(resolveAudienceDefaultPlaybookId('exhibition', { env: {} })).toBe('exhibition-catalog-to-sales-site');
    expect(resolveAudienceDefaultPlaybookId('development', { env: {} })).toBe('feature');
  });

  it('unknown audience falls back to the default entry, then to development', () => {
    expect(resolveAudienceDefaultPlaybookId('nope', { env: {} })).toBe('feature');
    expect(resolveAudienceDefaultPlaybookId(null, { env: {} })).toBe('feature');
  });

  it('env AUDIENCE_DEFAULT_PLAYBOOK wins over the built-in map', () => {
    const env = { AUDIENCE_DEFAULT_PLAYBOOK: JSON.stringify({ freelance: 'development' }) };
    expect(resolveAudienceDefaultPlaybookId('freelance', { env })).toBe('development');
  });

  it('a malformed env value is ignored (never becomes a suggestion)', () => {
    const env = { AUDIENCE_DEFAULT_PLAYBOOK: '{not json' };
    expect(resolveAudienceDefaultPlaybookId('freelance', { env })).toBe('freelance-project-spec');
  });

  it('suggest reports availability against the registry and marks fallbacks', () => {
    const store = { resolve: id => (id === 'freelance-project-spec' ? { id, version: 1, scope: 'system', source: 'system' } : null) };
    const hit = suggestPlaybookForAudience('freelance', { store, env: {} });
    expect(hit).toMatchObject({ audience: 'freelance', playbook_id: 'freelance-project-spec', fallback: false, available: true });
    const miss = suggestPlaybookForAudience('mystery', { store, env: {} });
    expect(miss).toMatchObject({ playbook_id: 'feature', fallback: true, available: false });
  });

  it('loadAudiencePlaybookMap tags entries with their source', () => {
    const { entries } = loadAudiencePlaybookMap({
      env: { AUDIENCE_DEFAULT_PLAYBOOK: JSON.stringify({ freelance: 'development' }) },
      configPath: '/nonexistent/audience-default-playbooks.json',
    });
    expect(entries.freelance).toEqual({ id: 'development', source: 'env' });
    expect(entries.exhibition).toEqual({ id: 'exhibition-catalog-to-sales-site', source: 'builtin' });
  });
});

describe('migrated system playbooks', () => {
  const store = new PlaybookStore({ profileId: null });
  for (const id of ['freelance-project-spec', 'exhibition-catalog-to-sales-site']) {
    it(`${id} validates and compiles to a draft plan`, () => {
      const pb = store.get(id);
      expect(pb).toBeTruthy();
      expect(pb.scope).toBe('system');
      const compiled = compilePlaybook(pb, { goal: 'smoke goal' });
      expect(compiled.items.length).toBeGreaterThan(0);
      expect(compiled.acceptance_criteria.length).toBeGreaterThan(0);
      for (const item of compiled.items) expect(item.validation && Object.keys(item.validation).length).toBeGreaterThan(0);
    });
  }
});
