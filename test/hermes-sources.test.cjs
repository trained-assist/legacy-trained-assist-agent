// Research must come back grounded (issue #1792, triage 2026-09-28).
//
// Before the fix a research answer carried prose labels instead of links —
// `"source": "Deepgram documentation, pricing page"` — because the prompt promised a
// search tool the engine did not have. Two things now enforce honesty: the prompt tells
// the worker to probe the search first and never invent sources, and the tool injects a
// `sources` array into the caller's schema and reports `grounded` back to the session.
// No network, no engine spawn.
let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

const hermes = require('../src/mcp-skills/tools/100-hermes');
const { buildPrompt } = require('../src/hermes-tools-run');
const { ENGINE_ENV_ALLOW } = require('../src/agent-isolation');
const fs = require('fs');
const path = require('path');

const { withSources, isGrounded } = hermes;

// ── withSources: the schema the model actually sees ───────────────────────────
{
  const inSchema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
  const out = withSources(inSchema);
  ok(out.properties.a === inSchema.properties.a, 'withSources keeps the caller properties');
  ok(!!out.properties.sources && out.properties.sources.type === 'array', 'withSources adds a sources array');
  ok(out.properties.sources.items.required.includes('url'),
    'each source must carry a url (required in the item schema)');
  ok(out.required.includes('a') && out.required.includes('sources'),
    'sources is required so the model cannot silently omit it');
  ok(out !== inSchema, 'withSources does not mutate the caller schema');
}

{
  const own = { type: 'object', properties: { sources: { type: 'array' } } };
  ok(withSources(own).properties.sources === own.properties.sources,
    'a caller that declares its own sources is left alone');
}

{
  ok(withSources({ type: 'array', items: { type: 'string' } }).type === 'array',
    'a non-object root passes through untouched (no crash)');
  ok(withSources(null) === null && withSources(undefined) === undefined,
    'missing schema passes through untouched');
}

// ── isGrounded: prose is not a source ─────────────────────────────────────────
{
  ok(isGrounded({ sources: [{ title: 't', url: 'https://example.com/a' }] }) === true,
    'a real https URL is grounded');
  ok(isGrounded({ sources: [{ title: 't', url: 'http://example.com' }] }) === true,
    'http counts too');
  ok(isGrounded({ sources: [] }) === false, 'an empty sources array is not grounded');
  ok(isGrounded({}) === false, 'no sources field at all is not grounded');
  ok(isGrounded({ sources: [{ title: 'Deepgram documentation, pricing page' }] }) === false,
    'a prose label without a url — the exact pre-fix failure — is not grounded');
  ok(isGrounded({ sources: [{ title: 't', url: 'Deepgram documentation' }] }) === false,
    'a prose label stuffed into url is not grounded');
  ok(isGrounded({ sources: [{ title: 't', url: 'https://ok.example' }, { title: 'x', url: 'nope' }] }) === false,
    'one bad url among good ones makes the whole answer ungrounded');
  ok(isGrounded({ sources: [{ title: 't', url: ' https://spaced.example ' }] }) === true,
    'surrounding whitespace around a url is tolerated');
}

// ── the prompt no longer promises an instrument blindly ───────────────────────
{
  const p = buildPrompt('task', 'ctx', { type: 'object', properties: {} });
  ok(/пробный вызов поиска/.test(p), 'prompt asks the worker to probe the search first');
  ok(/НЕ ВЫДУМЫВАЙ источники/.test(p), 'prompt forbids inventing sources when search fails');
  ok(/sources/.test(p), 'prompt points at the sources field');
  ok((p.match(/инструментам \(/g) || []).length <= 1,
    'the duplicated «инструментам (…)» phrase from the pre-fix prompt is gone');
  ok(p.includes('task') && p.includes('Схема ответа'), 'prompt still carries task + schema');

  const desc = hermes.tools.hermes_research.description;
  ok(!/встроенный веб-поиск/.test(desc),
    'the tool description no longer advertises a built-in web search as a given');
  ok(/grounded/.test(desc), 'the tool description tells the caller to check `grounded`');
}

// ── engine env: opencode runs get the search flag ─────────────────────────────
{
  const runnerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'runner', 'claude-runner.js'), 'utf8');
  ok(/engine === 'opencode' \? \{ OPENCODE_ENABLE_EXA: '1' \}/.test(runnerSrc),
    'runEngineProcess sets OPENCODE_ENABLE_EXA for opencode runs only');
  ok(!/OPENCODE_ENABLE_PARALLEL\s*:/.test(runnerSrc),
    'the parallel provider is never set (opencode prefers it and we hold no key)');
  ok(ENGINE_ENV_ALLOW.has('OPENCODE_ENABLE_EXA'),
    'the flag survives the AGENT_ENV_ALLOWLIST hardening (#1649)');
}

console.log(`\nhermes-sources: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
