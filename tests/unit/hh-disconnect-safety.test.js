import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

// Separate process isolates CommonJS caches and credential roots from other suites.
it('disconnect routing mutates only explicitly requested credentials and reports the actual result', () => {
  const result = execFileSync(process.execPath, ['-e', String.raw`
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-disconnect-'));
    os.homedir = () => root;
    process.env.AGENT_TOKENS_ROOT = root;
    delete process.env.OPENROUTER_API_KEY;
    const tokens = require('./src/user-tokens');
    const realRevoke = tokens.revokeService;
    let calls = 0, simulateNull = false;
    tokens.revokeService = (...args) => { calls++; return simulateNull ? null : realRevoke(...args); };
    const { runQuickAnswer } = require('./src/runner/intent-engine');
    const { HH_DISCONNECT_INTENT } = require('./src/domains/hh/lib').hhLib('hh-intents');
    const uid = 'isolated-hh-disconnect-test';
    const file = path.join(root, uid, 'hh');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fixture = 'fixture-not-a-real-token';
    const negatives = [
      'Удалить HH-specific scheduling из core/server.',
      'MCP Skills Extraction + Generic Cron. '.repeat(12) + 'Удалить HH-specific scheduling из core/server.',
      'не отключи hh', 'не надо удалять hh', 'как отключить hh?',
      'покажи /hh_disconnect', '/hh_disconnect_extra',
      '/hh_disconnect\nно сначала объясни',
      '[Сообщение 1]\n/hh_disconnect\n\n[Сообщение 2]\nне отключай',
      '"отключи hh"', 'hh отключить scheduler', 'удали hh_run_cold_search',
    ];
    (async () => {
      try {
        fs.writeFileSync(file, fixture);
        for (const text of negatives) {
          assert.equal(HH_DISCONNECT_INTENT.test(text), false, text);
          const reply = await runQuickAnswer(text, uid, null);
          assert.equal(reply, null, text);
          assert.equal(fs.readFileSync(file, 'utf8'), fixture);
        }
        assert.equal(calls, 0);
        for (const text of ['/hh_disconnect', '[Сообщение 1]\n/hh_disconnect@TestBot', 'отключи hh', 'сброс hh авторизации']) {
          fs.writeFileSync(file, fixture);
          assert.match(await runQuickAnswer(text, uid, null), /токен удалён/);
          assert.equal(fs.existsSync(file), false);
          assert.match(await runQuickAnswer(text, uid, null), /не подключён/);
        }
        simulateNull = true;
        fs.writeFileSync(file, fixture);
        assert.match(await runQuickAnswer('/hh_disconnect', uid, null), /не подтверждено/);
        assert.equal(fs.readFileSync(file, 'utf8'), fixture);
        console.log('PASS');
      } finally { fs.rmSync(root, {recursive:true, force:true}); }
    })().catch(e => { console.error(e); process.exitCode = 1; });
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 20000 });
  expect(result).toContain('PASS');
});
