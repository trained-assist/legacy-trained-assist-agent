// #1887 п.1 / #1894 S1 — guide-section metadata in checklist.md: `Mode:`, `Owner-chat:`,
// `Playbook:`, `Started:`, `Closed:` are section metadata (never items, never the goal);
// `Closed:` closes the section like `Cancelled:`; legacy checklists parse as before.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const gtd = require('../../src/gtd-controller.js');

let dir;
function write(md) { dir = mkdtempSync(join(tmpdir(), 'gtd-guide-meta-')); writeFileSync(join(dir, 'checklist.md'), md); return dir; }
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

const GUIDE = [
  'Goal: Гайд', 'Owner-session: tg-1-s', 'Owner-chat: 777', 'Mode: guide',
  'Playbook: development@v3', 'Started: 2026-09-29T16:00:00.000Z',
  '- [ ] 1. Шаг — проверка: x', '- [x] 2. Выключенный — выключен: не нужен', '',
].join('\n');

describe('checklist guide metadata (#1887 п.1)', () => {
  it('metadata lines are section fields, not items or goal', () => {
    const cl = gtd.readChecklist(write(GUIDE));
    expect(cl.goal).toBe('Гайд');
    expect(cl.owner).toBe('tg-1-s');
    expect(cl.mode).toBe('guide');
    expect(cl.ownerChat).toBe('777');
    expect(cl.closed).toBe(false);
    expect(cl.items.map(i => i.text)).toEqual(['1. Шаг — проверка: x', '2. Выключенный — выключен: не нужен']);
  });

  it('Closed: closes the section like Cancelled: — GTD does not schedule it', async () => {
    const d = write(GUIDE + 'Closed: 2026-09-29\n');
    const cl = gtd.readChecklist(d);
    expect(cl.closed).toBe(true);
    expect(cl.cancelled).toBe(true);
    const r = await gtd.scheduleFromChecklist({ workDir: d, sessionId: 'tg-1-s', chatId: 777, projectDir: d });
    expect(r).toBeNull();
  });

  it('legacy checklist (no guide metadata) parses as before', () => {
    const cl = gtd.readChecklist(write('Goal: Старое\n- [ ] a\n- [x] b\n'));
    expect(cl).toMatchObject({ goal: 'Старое', owner: null, cancelled: false, closed: false, mode: null, ownerChat: null });
    expect(cl.items).toHaveLength(2);
  });

  it('_parseChecklistSections is exported and metadata belongs to its own section', () => {
    const { sections } = gtd._parseChecklistSections('Goal: A\nMode: guide\nOwner-chat: 1\n- [ ] a\nGoal: B\n- [ ] b\n');
    expect(sections.map(s => [s.goal, s.mode, s.ownerChat])).toEqual([[null, null, null], ['A', 'guide', '1'], ['B', null, null]]);
    expect(gtd._activeSection(sections).goal).toBe('B');
  });
});
