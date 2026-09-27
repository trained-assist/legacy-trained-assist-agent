const fs = require('fs');
const path = require('path');

// Per-user profile: about, preferences, etc.
// Stored in user's workDir as profile.json

function load(workDir) {
  try { return JSON.parse(fs.readFileSync(path.join(workDir, 'profile.json'), 'utf8')); }
  catch { return {}; }
}

function save(workDir, data) {
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, 'profile.json'), JSON.stringify(data, null, 2));
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
  // Default is OpenCode on the Go subscription (owner 2026-09-27: "все чаты на opencode go") — an
  // unset engine used to mean Claude, so every chat nobody had explicitly switched ran on Claude.
  return 'opencode';
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

// Which OpenCode model profile (max|value|free|russian — each a ladder of models per role, see
// src/opencode-ladder.js, issue #1061) this profile's opencode tasks use. Profile-scoped only
// (no per-chat level, unlike getEngine) — simplest fix that still satisfies "never shared across
// users": each profile already maps 1:1 to a VM user, so this alone stops the old behaviour of
// overwriting one machine-wide ~/.config/opencode/opencode.json for every profile on the box.
// See writeOpencodeMcpConfig in claude-runner.js for how this gets applied per-invocation
// instead of via a shared file.
function getOcProfile(workDir) {
  const p = load(workDir);
  // Default: the logical "deepseek" profile → opencode-go/deepseek-v4.1-flash (owner 2026-09-27:
  // "стандартный опенкод на дипсик 4.1 флеш"). `max` was the old default; its paid OpenRouter
  // last rung is what burned the OpenRouter balance.
  return p.ocProfile || 'deepseek';
}

function setOcProfile(workDir, ocProfile) {
  const current = load(workDir);
  save(workDir, { ...current, ocProfile });
  return ocProfile;
}

module.exports = { load, save, toContext, getEngine, setEngine, getOcProfile, setOcProfile };
