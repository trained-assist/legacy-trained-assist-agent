'use strict';

// S4b (issue #1851, D2): make a profile's PERSONAL playbooks reachable from a
// plain request. Before this, playbook_health for scope:profile always failed
// the dispatch gate (a profile has no prompt-domain A1 and no launcher F), so
// the only route was the agent remembering the id.
//
// This module is pure and read-only — it returns a prompt section to inject.
// The runner folds it into the profile's system prompt (one injection, gated by
// !internalGtd, like playbookSuggestionSection), so the agent recognises a plain
// request whose meaning matches `when_to_use` and calls playbook_run(<id>)
// without being told the id.
//
// Opt-in-safe by construction:
//   • profile has no playbook with a non-empty when_to_use → '' (byte-identical prompt)
//   • kill-switch PROFILE_PLAYBOOK_MENU=off            → ''
//   • any error (unreadable store, etc.)               → '' (never breaks a run)

const { PlaybookStore } = require('./playbook-store');

const MENU_HEADER = '[ТВОИ ПЛЕЙБУКИ]';
const MENU_LIMIT = 10;
const WHEN_TO_USE_MAX = 160;

function isDisabled(env) {
  const raw = (env || process.env).PROFILE_PLAYBOOK_MENU;
  return typeof raw === 'string' && /^(off|0|false|no|disabled)$/i.test(raw.trim());
}

function truncate(text, max) {
  const s = String(text || '').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

// Build the prompt section, or '' when nothing should change. `store` is
// injectable for tests; production builds a profile-scoped store.
function buildProfilePlaybookMenu({ profileId = null, store = null, env = process.env } = {}) {
  try {
    if (isDisabled(env)) return '';
    const playbookStore = store || new PlaybookStore({ profileId });
    const mine = (playbookStore.list().playbooks || [])
      .filter(p => p.source === 'profile' && typeof p.when_to_use === 'string' && p.when_to_use.trim());
    if (!mine.length) return '';

    const shown = mine.slice(0, MENU_LIMIT);
    const lines = [
      MENU_HEADER,
      'Личные плейбуки профиля. КОГДА просьба совпадает по смыслу со строкой «когда использовать»',
      'ТОГДА предложи/запусти `playbook_run(playbook_id: "<id>", goal: "<цель>")` — id помнить не нужно.',
      ...shown.map(p => `- \`${p.id}\` — ${truncate(p.when_to_use, WHEN_TO_USE_MAX)}`),
    ];
    const extra = mine.length - shown.length;
    if (extra > 0) lines.push(`… ещё ${extra} — см. playbook_list`);
    return lines.join('\n');
  } catch {
    return '';
  }
}

module.exports = { buildProfilePlaybookMenu, MENU_HEADER, MENU_LIMIT, WHEN_TO_USE_MAX };
