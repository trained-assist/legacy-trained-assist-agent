// #1489 P2.1 — external alarm for the cron engine is wired on the prod host only.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

describe('cron tick deployment', () => {
  it('prod unit is the scheduler primary', () => {
    expect(read('systemd/assist-agent.service')).toMatch(/^Environment=CRON_SCHEDULER_ROLE=primary$/m);
  });
  it('timer fires every minute and posts to the internal tick with the agent secret, loopback only', () => {
    expect(read('systemd/assist-cron-tick.timer')).toMatch(/^OnUnitActiveSec=1min$/m);
    const svc = read('systemd/assist-cron-tick.service');
    expect(svc).toContain('http://127.0.0.1:8080/internal/cron/tick');
    expect(svc).toContain('Authorization: Bearer $AGENT_SECRET');
    expect(svc).toContain('%%{http_code}'); // systemd escapes % — a bare %{ would be eaten
  });
  it('deploy.sh installs and enables the timer only for DEPLOY_ENV=gcp', () => {
    const sh = read('scripts/deploy.sh');
    // Each statement must sit inside an `if [ "$DEPLOY_ENV" = "gcp" ]` block (no `fi` in between).
    const guarded = stmt => new RegExp(`if \\[ "\\$DEPLOY_ENV" = "gcp" \\][^\\n]*\\n(?:(?!\\nfi\\n)[\\s\\S])*?${stmt}`).test(sh);
    expect(guarded('for UNIT in assist-cron-tick\\.service assist-cron-tick\\.timer')).toBe(true);
    expect(guarded('systemctl enable --now assist-cron-tick\\.timer')).toBe(true);
  });
});
