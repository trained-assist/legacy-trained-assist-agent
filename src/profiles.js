const fs = require('fs');
const path = require('path');
const { atomicJson } = require('./atomic-json');

// Per-user profile: about, preferences, etc.
// Stored in user's workDir as profile.json

function load(workDir) {
  try { return JSON.parse(fs.readFileSync(path.join(workDir, 'profile.json'), 'utf8')); }
  catch { return {}; }
}

function save(workDir, data) {
  fs.mkdirSync(workDir, { recursive: true });
  atomicJson(path.join(workDir, 'profile.json'), data, { space: 2 });
}

function toContext(profile, workDir) {
  const parts = [];
  if (profile.about) parts.push(`О пользователе: ${profile.about}`);
  if (profile.preferences) parts.push(`Предпочтения: ${profile.preferences}`);
  if (workDir) parts.push(`Рабочая директория: ${workDir}`);
  return parts.join('\n') || null;
}

// Which CLI (claude|codex|opencode) runs this profile's tasks. Two levels, same as projects.js's
// active-project-per-chat: a per-chat override (engineByChat[chatId], set via the
// /switch2klod, /switch2codex, /switch2opencode chat command) wins over the profile-wide default
// (`engine`, set via scripts/set-engine.mjs). chatId is optional — omit it to read/write default.
function getEngine(workDir, chatId) {
  const p = load(workDir);
  const override = chatId != null ? p.engineByChat?.[String(chatId)] : null;
  const raw = override || p.engine;
  if (raw === 'codex') return 'codex';
  if (raw === 'claude') return 'claude';
  if (raw === 'opencode') return 'opencode';
  // Default is OpenCode on the Go subscription (owner 2026-09-27: "все чаты на opencode go") — an
  // unset engine used to mean Claude, so every chat nobody had explicitly switched ran on Claude.
  // AGENT_DEFAULT_ENGINE overrides it (the vitest isolation setup pins claude for the fake-claude
  // runner fixtures).
  const fallback = process.env.AGENT_DEFAULT_ENGINE;
  return fallback === 'claude' || fallback === 'codex' ? fallback : 'opencode';
}

function setEngine(workDir, engine, chatId) {
  const clean = engine === 'codex' ? 'codex' : engine === 'opencode' ? 'opencode' : 'claude';
  const current = load(workDir);
  if (chatId != null) {
    save(workDir, { ...current, engineByChat: { ...current.engineByChat, [String(chatId)]: clean } });
  } else {
    save(workDir, { ...current, engine: clean });
  }
  return clean;
}

// Which OpenCode model profile (service|doctor|free|russian|research — each a worker ladder, see
// src/opencode-ladder-provider.js, issue #1687) this profile's opencode tasks use. Profile-scoped
// only (no per-chat level, unlike getEngine) — simplest fix that still satisfies "never shared
// across users": each profile already maps 1:1 to a VM user, so this alone stops the old
// behaviour of overwriting one machine-wide ~/.config/opencode/opencode.json for every profile on
// the box. See writeOpencodeMcpConfig in claude-runner.js for how this gets applied per-invocation
// instead of via a shared file.
function getOcProfile(workDir) {
  const p = load(workDir);
  // Default: the `service` ladder (owner 2026-09-27: "стандартный опенкод на дипсик 4.1 флеш";
  // the ladder was renamed deepseek → service in llm-ladder #49/#101 — profiles are named after
  // the worker ladder, not the model family). A stored legacy name (deepseek/value/max) is left
  // as-is and resolved by ladderFor, so a `max` profile still reaches `doctor`.
  // deepseek-go / deepseek-openrouter were the two halves of the removed VM-wide toggle
  // (2026-09-27) — both now mean the single service ladder (Go first, OpenRouter last rung).
  if (!p.ocProfile || p.ocProfile === 'deepseek-go' || p.ocProfile === 'deepseek-openrouter') return 'service';
  return p.ocProfile;
}

function setOcProfile(workDir, ocProfile) {
  const current = load(workDir);
  save(workDir, { ...current, ocProfile });
  return ocProfile;
}

module.exports = { load, save, toContext, getEngine, setEngine, getOcProfile, setOcProfile };
