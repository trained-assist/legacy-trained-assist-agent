/**
 * No MCP tool may call a provider API directly (owner 2026-10-03).
 *
 * Every LLM call a tool makes goes through the llm-ladder worker
 * (src/service-llm.js → serviceChat / serviceJson), which owns the OpenCode Go /
 * OpenRouter / Zen key pool, rung failover, per-model health and the D1
 * attribution log (x-ladder-app carries the tool's own name, llm-ladder#18/#33).
 * A direct provider call from a tool means:
 *   - a key the box no longer holds — OPENROUTER_API_KEY was dropped from the VM
 *     (infra/env-manifest.json), so the call fails at runtime with a provider
 *     error the user sees as «vision_failed»;
 *   - no rotation, no health skips, no cost attribution for that call.
 *
 * This is the endpoint twin of test/no-hardcoded-keys.test.js: that one bans the
 * key LITERALS, this one bans the CALL — a tool can hold no key and still reach
 * a provider through an env-var read or a hardcoded URL.
 *
 * Deliberately out of scope:
 *   - image generation (95-illustrate.js → OpenAI DALL-E / fal / Ideogram /
 *     Recraft). Those are image APIs; the three providers named here are the
 *     chat/completion ones the worker routes.
 *   - HH/recruiter tools, which call OpenRouter directly BY DESIGN (README
 *     "Recruiter/quick-action MCP tools must use cheap LLMs, never Claude Code")
 *     — they live in the trained-assist-hh-skill sibling repo, not in this one.
 *
 * A new exemption must be written down in EXEMPT below with the reason, never
 * silently deleted from the patterns.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOTS = ['src/mcp-skills'];

// Direct-call indicators: a provider endpoint, a provider key/base-URL env read,
// or a provider model prefix. Comments are not exempt on purpose — a comment that
// names the old path is a leftover from exactly the change this test forces.
const PATTERNS = [
  { re: /https?:\/\/(?:[a-z0-9-]+\.)*openrouter\.ai/, label: 'openrouter.ai endpoint' },
  { re: /https?:\/\/(?:[a-z0-9-]+\.)*opencode\.ai/, label: 'opencode.ai endpoint (Go API / Zen)' },
  { re: /OPENROUTER_API_KEY/, label: 'OPENROUTER_API_KEY read' },
  { re: /OPENCODE_GO_API_KEYS?/, label: 'OPENCODE_GO_API_KEY(S) read' },
  { re: /OPENCODE_ZEN_(?:BASE_URL|RELAY_TOKEN)/, label: 'OPENCODE_ZEN_* read' },
  { re: /['"]z-ai\//, label: 'z-ai/* Zen model id' },
];

const EXEMPT = {
  // 'src/mcp-skills/tools/95-illustrate.js': 'image generation APIs (DALL-E/fal/…),
  //   not the three chat providers the worker routes — never an LLM chat call',
};

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && /\.m?js$/.test(e.name)) yield p;
  }
}

describe('MCP tools never call provider APIs directly', () => {
  it('no tool reaches OpenCode Go / OpenRouter / Zen outside the ladder worker', () => {
    const files = SCAN_ROOTS.flatMap(d => [...walk(join(ROOT, d))]);
    const hits = [];
    for (const f of files) {
      const rel = relative(ROOT, f);
      if (EXEMPT[rel]) continue;
      const text = readFileSync(f, 'utf8');
      for (const { re, label } of PATTERNS) {
        const m = text.match(re);
        if (m) hits.push(`${rel}: ${label} — ${m[0]}`);
      }
    }
    expect(hits, `direct provider call(s) found; use serviceChat/serviceJson from src/service-llm.js:\n  ${hits.join('\n  ')}`).toEqual([]);
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