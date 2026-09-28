// Per-profile "personality" / role — a couple of paragraphs describing what role the
// assistant plays for this user (recruiter-analyst, software architect, construction
// business analyst, …). Stored per-user in workDir/persona.md and appended to the
// system prompt of EVERY session. Editable from the bot via the /persona command.

const fs = require('fs');
const path = require('path');
const { writeMode } = require('./data-paths');
const { atomicText } = require('./atomic-json');

const FILE = 'persona.md';
const MAX_LEN = 8000; // guard against pasting a whole book into the system prompt

// Built-in persona per bot/audience, used ONLY when the profile has no persona.md
// of its own — an explicit /persona set by the user always wins. Lets a domain bot
// (e.g. the freelance spec bot) have its own voice without configuring every profile
// by hand. Keep the freelance line in sync with the gateway's /start intro
// (trained-assist-tg-bot src/handlers/commands.js cmdStart).
const AUDIENCE_DEFAULT = {
  freelance:
    'Я — ассистент по фриланс-проектам: разбираю входящие заказы и файлы, ' +
    'раскладываю факты, требования и решение по проектам, считаю риск GO/NO-GO и собираю ТЗ. ' +
    'Пиши задачу обычным текстом или присылай файлы — сам разберусь и подскажу, что делать дальше.',
};

function personaPath(workDir) {
  return path.join(workDir, FILE);
}

// Returns the persona text, or null if none set.
function load(workDir) {
  if (!workDir) return null;
  try {
    const t = fs.readFileSync(personaPath(workDir), 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

function save(workDir, text) {
  fs.mkdirSync(workDir, { recursive: true });
  const clean = String(text).trim().slice(0, MAX_LEN);
  atomicText(personaPath(workDir), clean + '\n', writeMode(0o600));
  return clean;
}

function clear(workDir) {
  try {
    fs.unlinkSync(personaPath(workDir));
    return true;
  } catch {
    return false;
  }
}

// Build the system-prompt file to hand to the CLI. Prefers the profile's own persona;
// if none is set, falls back to the audience's built-in default (AUDIENCE_DEFAULT).
// Merges the global base prompt + persona into a per-user file and returns its path;
// otherwise returns the base file unchanged. Never throws — falls back to the base file.
function buildSystemPromptFile(workDir, basePromptFile, audience = 'default') {
  const base = basePromptFile && fs.existsSync(basePromptFile) ? basePromptFile : '';
  if (!workDir) return base;
  const userText = load(workDir);
  const text = userText || AUDIENCE_DEFAULT[audience] || null;
  if (!text) return base;
  const source = userText
    ? 'задано пользователем — соблюдай в каждом ответе'
    : `роль бота (аудитория: ${audience}) — соблюдай в каждом ответе`;
  try {
    const baseContent = base ? fs.readFileSync(base, 'utf8') : '';
    const merged =
      baseContent +
      `\n\n# РОЛЬ И ЛИЧНОСТЬ АССИСТЕНТА (${source})\n` +
      text + '\n';
    const out = path.join(workDir, '.system-prompt.txt');
    atomicText(out, merged, writeMode(0o660)); // group = the run's slot (issue #1649)
    return out;
  } catch (e) {
    console.warn('[persona] merge failed:', e.message);
    return base;
  }
}

module.exports = { load, save, clear, personaPath, buildSystemPromptFile, AUDIENCE_DEFAULT };
