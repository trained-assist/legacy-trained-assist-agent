'use strict';

// Persistent context store — key-value per skill, survives session restarts.
// Storage: {workDir}/contexts/{skill}/{key}.json
// workDir = process.cwd() (inherited from Claude Code, which runs in user's workDir)

const fs = require('fs');
const path = require('path');
const { atomicJson } = require('../../atomic-json');

function contextPath(skill, key) {
  return path.join(process.cwd(), 'contexts', skill, `${key}.json`);
}

function readContext(skill, key) {
  const file = contextPath(skill, key);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeContext(skill, key, value) {
  const file = contextPath(skill, key);
  // Atomic write: the context store is keyed by PROFILE (username), so two
  // concurrent sessions of one profile can write it at the same time. The
  // runner only serializes per-CHAT (parallel tasks across sessions/chats of
  // one profile are allowed), so this store is the one genuinely shared
  // per-profile resource. temp + fsync + rename means a reader never observes
  // a torn file, and a crash mid-write leaves the previous value intact rather
  // than corrupt — this is what makes parallel same-profile sessions safe.
  atomicJson(file, { value, updated_at: new Date().toISOString() }, { space: 2 });
}

module.exports = {
  tools: {

    context_get: {
      description:
        'Read a persistent context value saved by context_set. ' +
        'Use to recall state between sessions: active vacancy, ATS config, current project, user preferences.',
      inputSchema: {
        type: 'object',
        required: ['skill', 'key'],
        properties: {
          skill: { type: 'string', description: 'Skill name (e.g. hh, weeek, tilda)' },
          key:   { type: 'string', description: 'Key name (e.g. active_vacancy, ats_config)' },
        },
      },
      handler: async ({ skill, key }) => {
        const data = readContext(skill, key);
        if (!data) return { found: false, value: null };
        return { found: true, value: data.value, updated_at: data.updated_at };
      },
    },

    context_set: {
      description:
        'Save a persistent context value for a skill. Survives restarts and new sessions. ' +
        'Use for: active vacancy, agreed ATS config, in-progress work state, user preferences per skill.',
      inputSchema: {
        type: 'object',
        required: ['skill', 'key', 'value'],
        properties: {
          skill: { type: 'string', description: 'Skill name (e.g. hh, weeek, tilda)' },
          key:   { type: 'string', description: 'Key name (e.g. active_vacancy, ats_config)' },
          value: { description: 'Any JSON-serializable value' },
        },
      },
      handler: async ({ skill, key, value }) => {
        writeContext(skill, key, value);
        return { ok: true, skill, key, updated_at: new Date().toISOString() };
      },
    },

    context_list: {
      description: 'List all saved context entries, optionally filtered by skill.',
      inputSchema: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: 'Filter by skill (optional — omit to list all)' },
        },
      },
      handler: async ({ skill } = {}) => {
        const base = path.join(process.cwd(), 'contexts');
        if (!fs.existsSync(base)) return { entries: [], count: 0 };

        const skills = skill
          ? [skill]
          : fs.readdirSync(base).filter(d => fs.statSync(path.join(base, d)).isDirectory());

        const entries = [];
        for (const s of skills) {
          const dir = path.join(base, s);
          if (!fs.existsSync(dir)) continue;
          for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
            const key = file.replace(/\.json$/, '');
            const data = readContext(s, key);
            if (data) entries.push({
              skill: s,
              key,
              updated_at: data.updated_at,
              preview: JSON.stringify(data.value).slice(0, 120),
            });
          }
        }
        return { entries, count: entries.length };
      },
    },

    context_clear: {
      description: 'Delete a saved context value.',
      inputSchema: {
        type: 'object',
        required: ['skill', 'key'],
        properties: {
          skill: { type: 'string', description: 'Skill name' },
          key:   { type: 'string', description: 'Key to delete' },
        },
      },
      handler: async ({ skill, key }) => {
        const file = contextPath(skill, key);
        if (!fs.existsSync(file)) return { ok: false, message: 'Not found' };
        fs.unlinkSync(file);
        return { ok: true, deleted: `${skill}/${key}` };
      },
    },

  },
};
