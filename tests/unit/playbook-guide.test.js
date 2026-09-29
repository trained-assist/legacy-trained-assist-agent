// #1887 п.1 / #1894 S2 — pure pieces of the playbook «гайд» mode: mode resolution table,
// «is a guide open in this chat» scan, section render.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const g = require('../../src/playbook-guide.js');

const TG = { AGENT_CHAT_ID: '777', AGENT_SESSION_ID: 'tg-777-s' };

describe('resolveMode', () => {
  it.each([
    [{ mode: 'background' }, TG, 'background', 'explicit'],
    [{ mode: 'guide' }, { AGENT_CHAT_ID: '0' }, 'guide', 'explicit'],
    [{}, { AGENT_CHAT_ID: '0', AGENT_SESSION_ID: 'web-1' }, 'background', 'non_interactive'],
    [{}, { AGENT_CHAT_ID: '777', AGENT_SESSION_ID: 's-plan-x' }, 'background', 'non_interactive'],
    [{}, { AGENT_CHAT_ID: '777' }, 'background', 'non_interactive'],
    [{}, {}, 'background', 'non_interactive'],
    [{ openGuide: { goal: 'A' } }, TG, 'background', 'foreground_busy'],
    [{ sessionPlan: { id: 't1' } }, TG, 'background', 'session_has_plan'],
    [{}, { ...TG, PLAYBOOK_GUIDE_DEFAULT: '0' }, 'background', 'guide_default_off'],
    [{}, TG, 'guide', 'default_telegram'],
    [{ activate: true }, TG, 'guide', 'default_telegram'],
    [{}, { AGENT_CHAT_ID: '-100123', AGENT_SESSION_ID: 'tg-g' }, 'guide', 'default_telegram'],
  ])('%j in %j → %s/%s', (args, env, mode, reason) => {
    expect(g.resolveMode({ ...args, env })).toEqual({ mode, reason });
  });

  it('explicit guide + activate → MODE_CONFLICT; unknown mode → MODE_INVALID', () => {
    expect(() => g.resolveMode({ mode: 'guide', activate: true, env: TG })).toThrow(expect.objectContaining({ code: 'MODE_CONFLICT' }));
    expect(() => g.resolveMode({ mode: 'fg', env: TG })).toThrow(expect.objectContaining({ code: 'MODE_INVALID' }));
  });
});

describe('findOpenGuide', () => {
  let root;
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  function put(project, md) {
    const dir = project ? join(root, 'projects', project) : root;
    mkdirSync(dir, { recursive: true });
    const f = join(dir, 'checklist.md');
    writeFileSync(f, md);
    return f;
  }
  const guide = (chat, extra = '') => `Goal: G${chat}\nOwner-session: s\nOwner-chat: ${chat}\nMode: guide\n- [ ] 1. a\n${extra}`;
  function setup() { root = mkdtempSync(join(tmpdir(), 'guide-find-')); }

  it('open guide in project A is found for the same chat, from anywhere in the profile', () => {
    setup();
    const f = put('a', guide(777));
    put('b', 'Goal: other\n- [ ] x\n');
    expect(g.findOpenGuide({ profileRoot: root, chatId: 777 })).toMatchObject({ goal: 'G777', checklist_path: f });
    expect(g.findOpenGuide({ profileRoot: root, chatId: 778 })).toBeNull();
  });

  it('root-level checklist.md counts too', () => {
    setup();
    put(null, guide(5));
    expect(g.findOpenGuide({ profileRoot: root, chatId: '5' })).not.toBeNull();
  });

  it.each([
    ['all done', 'Goal: G1\nOwner-chat: 1\nMode: guide\n- [x] 1. a\n'],
    ['Cancelled', guide(1, 'Cancelled: 2026-09-29\n')],
    ['Closed', guide(1, 'Closed: 2026-09-29\n')],
    ['superseded by a newer section', guide(1, 'Goal: new\n- [ ] b\n')],
    ['background section', 'Goal: G1\nOwner-chat: 1\n- [ ] a\n'],
  ])('%s → not open', (_n, md) => {
    setup();
    put('a', md);
    expect(g.findOpenGuide({ profileRoot: root, chatId: 1 })).toBeNull();
  });

  it('stale (> 24 h since last change) → not open', () => {
    setup();
    const f = put('a', guide(1));
    const old = (Date.now() - 25 * 3600e3) / 1000;
    utimesSync(f, old, old);
    expect(g.findOpenGuide({ profileRoot: root, chatId: 1 })).toBeNull();
  });

  it('no chat / chat 0 → null without scanning', () => {
    setup();
    put('a', guide(0));
    expect(g.findOpenGuide({ profileRoot: root, chatId: 0 })).toBeNull();
    expect(g.findOpenGuide({ profileRoot: root, chatId: null })).toBeNull();
  });
});

describe('renderGuideSection', () => {
  it('writes owner lines, marks gates and switched-off steps', () => {
    const md = g.renderGuideSection({
      goal: 'Цель\nв две строки', sessionId: 'tg-1', chatId: '1', playbook: { id: 'development', version: 3 }, now: 0,
      items: [{ title: 'A', validation: { a_done: true } }, { title: 'CI', validation: { ci_green: true } }, { title: 'C', validation: {} }],
      off: new Map([[2, 'не нужно']]),
      isProtected: it => !!it.validation.ci_green,
    });
    expect(md).toBe([
      'Goal: Цель в две строки', 'Owner-session: tg-1', 'Owner-chat: 1', 'Mode: guide', 'Playbook: development@v3',
      'Started: 1970-01-01T00:00:00.000Z', '- [ ] 1. A — проверка: a_done', '- [ ] 2. CI — проверка: ci_green [ГЕЙТ, не пропускается]',
      '- [x] 3. C — выключен: не нужно', '',
    ].join('\n'));
  });

  it('appendGuideSection keeps the journal and separates sections', () => {
    const root = mkdtempSync(join(tmpdir(), 'guide-append-'));
    const f = join(root, 'checklist.md');
    writeFileSync(f, 'Goal: old\n- [x] a');
    g.appendGuideSection(f, 'Goal: new\n- [ ] b\n');
    expect(require('fs').readFileSync(f, 'utf8')).toBe('Goal: old\n- [x] a\n\nGoal: new\n- [ ] b\n');
    rmSync(root, { recursive: true, force: true });
  });
});
