#!/usr/bin/env node
'use strict';
// The OpenCode-side noise filter (issue #2082): same guarantee as
// test/stream-noise-filter.test.cjs, but asserted through the plugin's own hooks — the ones
// opencode 1.18.31 actually calls (`experimental.text.complete` at text-end BEFORE the part
// is persisted, `experimental.chat.messages.transform` right before the messages go to the
// model). A regression here would put the markup back into the engine store and into the
// model's own context, which the runner-side filter can no longer reach.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('url');

const PLUGIN = path.join(__dirname, '..', 'src', 'runner', 'opencode-plugins', 'strip-leaked-tool.mjs');
const ZWSP = '';

async function loadHooks() {
  const mod = await import(pathToFileURL(PLUGIN).href);
  // Exactly one named export, and it must be the plugin factory: OpenCode's legacy loader
  // iterates every export and throws on a non-function one.
  const names = Object.keys(mod);
  assert.deepStrictEqual(names, ['StripLeakedToolPlugin']);
  assert.strictEqual(typeof mod.StripLeakedToolPlugin, 'function');
  return mod.StripLeakedToolPlugin({});
}

function block(body = 'repo_map', tag = 'tool_call') {
  return `<${ZWSP}${tag}><function=${body}><parameter=repo>/home/vova</parameter></function></${ZWSP}${tag}>`;
}

test('text.complete removes the leaked markup the model emitted as prose', async () => {
  const hooks = await loadHooks();
  const output = { text: 'Проверю карту.\n' + block() + '\nДальше по плану.' };
  await hooks['experimental.text.complete']({}, output);
  assert.strictEqual(output.text, 'Проверю карту.\n\nДальше по плану.');
});

test('text.complete leaves ordinary text byte-for-byte', async () => {
  const hooks = await loadHooks();
  for (const text of [
    'a < b && c > d',
    'см. https://example.com/a?x=1&y=2',
    '{"a":1,"b":[2,3]}',
    'Код: if (a <= b) { return c >= d; }',
    'тег <b>жирный</b> и <parameter в описании',
    '',
  ]) {
    const output = { text };
    await hooks['experimental.text.complete']({}, output);
    assert.strictEqual(output.text, text, `mutated: ${JSON.stringify(text)}`);
  }
});

// The bare `<function=…>` without the <tool_call> envelope is the SECOND dialect the model
// double-emits, so it is deliberately stripped even inside prose (see case 8 of
// test/stream-noise-filter.test.cjs). Asserted here so nobody "fixes" that false positive
// by loosening the shared filter.
test('text.complete strips the bare function/parameter dialect too', async () => {
  const hooks = await loadHooks();
  const output = { text: 'Смотрю.\n<function=repo_map><parameter=level>1</parameter></function>\nИтог.' };
  await hooks['experimental.text.complete']({}, output);
  assert.strictEqual(output.text, 'Смотрю.\n\nИтог.');
});

test('text.complete survives a missing output/malformed input (fail-open)', async () => {
  const hooks = await loadHooks();
  for (const output of [undefined, null, {}, { text: null }, { text: 42 }]) {
    await assert.doesNotReject(() => hooks['experimental.text.complete']({}, output));
  }
});

test('messages.transform cleans stored history without mutating the stored parts', async () => {
  const hooks = await loadHooks();
  const stored = { type: 'text', text: 'Ответ.\n' + block('bash') + '\nИтог.' };
  const toolPart = { type: 'tool', state: { output: '<not markup, just a string>' } };
  const messages = [{ info: { id: 'm1' }, parts: [stored, toolPart] }];
  await hooks['experimental.chat.messages.transform']({}, { messages });
  assert.strictEqual(messages[0].parts[0].text, 'Ответ.\n\nИтог.');
  // The object that came from the session store must stay intact — we replace, never mutate.
  assert.strictEqual(stored.text, 'Ответ.\n' + block('bash') + '\nИтог.');
  assert.strictEqual(messages[0].parts[1], toolPart, 'non-text part must be left alone');
});

test('messages.transform ignores anything that is not the expected shape', async () => {
  const hooks = await loadHooks();
  for (const output of [undefined, null, {}, { messages: null }, { messages: [null, {}, { parts: 'no' }] }]) {
    await assert.doesNotReject(() => hooks['experimental.chat.messages.transform']({}, output));
  }
});

test('both hooks are registered under the names opencode 1.18.31 triggers', async () => {
  const hooks = await loadHooks();
  assert.strictEqual(typeof hooks['experimental.text.complete'], 'function');
  assert.strictEqual(typeof hooks['experimental.chat.messages.transform'], 'function');
});

// The wiring: without this the plugin file exists but opencode never loads it, and the
// engine keeps the markup in its store — the exact regression #2082 describes.
test('writeOpencodeMcpConfig points opencode at the plugin by absolute path', () => {
  const { writeOpencodeMcpConfig } = require('../src/runner/claude-runner');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-plugin-'));
  try {
    const configPath = writeOpencodeMcpConfig(workDir, null, { model: 'ladder/service:build' });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(Array.isArray(config.plugin), 'config.plugin must be a list');
    assert.strictEqual(config.plugin.length, 1);
    const spec = config.plugin[0];
    // opencode resolves these with isPathPluginSpec → startsWith('.') / file:// / absolute.
    assert.ok(path.isAbsolute(spec), `plugin spec must be an absolute path, got ${spec}`);
    assert.ok(fs.existsSync(spec), 'plugin file must exist on disk');
    assert.strictEqual(fs.realpathSync(spec), fs.realpathSync(PLUGIN));
    // A config key opencode cannot parse would break every run — assert the shape.
    assert.deepStrictEqual(Object.keys(config).sort(), ['experimental', 'mcp', 'model', 'plugin']);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
