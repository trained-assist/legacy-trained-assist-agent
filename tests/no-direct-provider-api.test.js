/**
 * The agent holds no provider keys and no direct provider calls (owner 2026-10-03).
 *
 * Every LLM call goes through the llm-ladder (src/service-llm.js → serviceChat / serviceJson),
 * which owns the OpenCode Go / OpenRouter / Zen key pools, rung failover, per-model health and
 * the D1 attribution log (x-ladder-app carries the caller's own name, llm-ladder#18/#33).
 *
 * Two halves, because a tool can hold no key and still reach a provider:
 *   1. no MCP tool calls a provider API directly (endpoint literal or provider env read);
 *   2. no src/ file reads or sets an OpenCode Go / Zen credential at all — the engine used to
 *      draw one OPENCODE_GO_API_KEY(S) per run (goApiKey) and rewrite the staged opencode
 *      auth.json (syncOpencodeGoAuth); those pools now live ONLY in the llm-ladder, so a
 *      leftover read would silently resurrect a path whose keys are no longer on the box.
 *
 * Patterns match CODE (process.env reads, object-key assignments), not comments — a comment
 * that names the removed thing is documentation, not a call.
 *
 * Deliberately out of scope:
 *   - image generation (95-illustrate.js → OpenAI DALL-E / fal / Ideogram / Recraft). Those
 *     are image APIs; the providers named here are the chat/completion ones the llm-ladder
 *     routes.
 *   - HH/recruiter tools, which call OpenRouter directly BY DESIGN (README "Recruiter/
 *     quick-action MCP tools must use cheap LLMs, never Claude Code") — they live in the
 *     trained-assist-hh-skill sibling repo, not in this one.
 *
 * A new exemption must be written down in EXEMPT below with the reason, never silently
 * deleted from the patterns.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOTS = ['src/mcp-skills'];

// Direct-call indicators in a tool: a provider endpoint, a provider env read, or a provider
// model prefix.
const TOOL_DIRECT_CALL_PATTERNS = [
  { re: /https?:\/\/(?:[a-z0-9-]+\.)*openrouter\.ai/, label: 'openrouter.ai endpoint' },
  { re: /https?:\/\/(?:[a-z0-9-]+\.)*opencode\.ai/, label: 'opencode.ai endpoint (Go API / Zen)' },
  { re: /process\.env\.OPENROUTER_API_KEY/, label: 'OPENROUTER_API_KEY env read' },
  { re: /process\.env\.OPENCODE_GO_API_KEYS?/, label: 'OpenCode Go key env read' },
  { re: /process\.env\.OPENCODE_API_KEY\b/, label: 'OpenCode provider key env read' },
  { re: /process\.env\.OPENCODE_GO_BASE_URL/, label: 'OpenCode Go base URL' },
  { re: /process\.env\.OPENCODE_ZEN_(?:BASE_URL|RELAY_TOKEN)/, label: 'Zen relay credential' },
  { re: /['"]z-ai\//, label: 'z-ai/* Zen model id' },
];

// Go/Zen credential handling anywhere in the agent: an env read or an object-key assignment
// (the engine env build, a config file, a test fixture).
const AGENT_KEY_PATTERNS = [
  { re: /process\.env\.OPENCODE_GO_API_KEYS?/, label: 'OpenCode Go key env read' },
  { re: /process\.env\.OPENCODE_API_KEY\b/, label: 'OpenCode provider key env read' },
  { re: /\bOPENCODE_GO_API_KEYS?\s*:/, label: 'OpenCode Go key assignment' },
  { re: /\bOPENCODE_API_KEY\s*:/, label: 'OpenCode provider key assignment' },
  { re: /process\.env\.OPENCODE_GO_BASE_URL/, label: 'OpenCode Go base URL' },
  { re: /process\.env\.OPENCODE_ZEN_(?:BASE_URL|RELAY_TOKEN)/, label: 'Zen relay credential' },
];

const EXEMPT = {
  // 'src/mcp-skills/tools/95-illustrate.js': 'image generation APIs (DALL-E/fal/…),
  //   not the chat providers the llm-ladder routes — never an LLM chat call',
};

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && /\.m?js$/.test(e.name)) yield p;
  }
}

function scan(files, patterns) {
  const hits = [];
  for (const f of files) {
    const rel = relative(ROOT, f);
    if (EXEMPT[rel]) continue;
    const text = readFileSync(f, 'utf8');
    for (const { re, label } of patterns) {
      const m = text.match(re);
      if (m) hits.push(`${rel}: ${label} — ${m[0]}`);
    }
  }
  return hits;
}

describe('the agent holds no provider keys and no direct provider calls', () => {
  it('no MCP tool reaches OpenCode Go / OpenRouter / Zen outside the llm-ladder', () => {
    const files = SCAN_ROOTS.flatMap(d => [...walk(join(ROOT, d))]);
    const hits = scan(files, TOOL_DIRECT_CALL_PATTERNS);
    expect(hits, `direct provider call(s) found; use serviceChat/serviceJson from src/service-llm.js:\n  ${hits.join('\n  ')}`).toEqual([]);
  });

  it('no src/ file reads or sets an OpenCode Go / Zen credential (pools live in the llm-ladder)', () => {
    const hits = scan([...walk(join(ROOT, 'src'))], AGENT_KEY_PATTERNS);
    expect(hits, `Go/Zen credential reference(s) found in src/; the llm-ladder owns those pools:\n  ${hits.join('\n  ')}`).toEqual([]);
  });

  it('the sanctioned client is the only provider route in the tools layer', () => {
    // A tool that needs an LLM answer must reach it through service-llm; the ladder
    // name it sends is `service` (renamed from `deepseek`, llm-ladder #49/#101).
    const svc = readFileSync(join(ROOT, 'src/service-llm.js'), 'utf8');
    expect(svc).toMatch(/const LADDER = 'service'/);
    expect(svc).toContain('https://llm-ladder.trainedassist.store');
    const label = readFileSync(join(ROOT, 'src/mcp-skills/tools/96-label.js'), 'utf8');
    expect(label).toMatch(/require\('\.\.\/\.\.\/service-llm'\)/);
  });
});