// check-skill-schedule — deploy gate for sibling schedule declarations (#1489 S3.3).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const { checkSkillSchedule } = require('../../scripts/check-skill-schedule');

function repo(manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-sched-'));
  fs.mkdirSync(path.join(dir, 'src'));
  if (manifest !== undefined) {
    fs.writeFileSync(path.join(dir, 'src', 'action-manifest.js'),
      typeof manifest === 'string' ? manifest : `module.exports = { buildManifest: () => (${JSON.stringify(manifest)}) };`);
  }
  return dir;
}
const action = (schedule) => ({ name: 'scan', inputSchema: { type: 'object' }, allowedTriggers: ['user', 'cron'],
  effect: 'write', requiresApproval: false, retrySafety: 'idempotent', schedule });
const sched = { defaultCron: '0 */2 * * *', minIntervalMinutes: 30, delivery: 'silent', costClass: 'cheap_llm', label: 'Scan' };

describe('check-skill-schedule', () => {
  it('passes a valid declaration and reports the schedulable defaults', () => {
    const r = checkSkillSchedule(repo({ version: 1, providerId: 'x', actions: [action(sched)] }));
    expect(r).toMatchObject({ ok: true, scheduled: ['scan'] });
  });
  it('blocks a revision whose schedule the core registry rejects', () => {
    const r = checkSkillSchedule(repo({ version: 1, providerId: 'x', actions: [action({ ...sched, defaultCron: '*/5 * * * *' })] }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/minIntervalMinutes/);
  });
  it('passes (with a warning) when there is no manifest or it cannot load in the probe', () => {
    expect(checkSkillSchedule(repo())).toMatchObject({ ok: true });
    const r = checkSkillSchedule(repo("require('missing-dep-for-probe'); module.exports = {};"));
    expect(r.ok).toBe(true);
    expect(r.warnings[0]).toMatch(/not loadable/);
  });
});
