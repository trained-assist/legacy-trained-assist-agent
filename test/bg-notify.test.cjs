const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// TOKENS_ROOT is read at require time — point it at a throwaway dir first.
process.env.AGENT_TOKENS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-notify-'));

const { writeBgNotify, readBgNotify, isBgNotifyEnabled } = require('../src/bg-notify');

test('background-notify flag is off by default and round-trips per profile', () => {
  assert.equal(isBgNotifyEnabled('alice'), false);
  assert.equal(readBgNotify('bob'), null);

  writeBgNotify('alice', { enabled: true, chatId: 42, audience: 'default', threadId: 7 });
  assert.equal(isBgNotifyEnabled('alice'), true);
  const flag = readBgNotify('alice');
  assert.equal(flag.chatId, 42);
  assert.equal(flag.threadId, 7);
  assert.ok(flag.updated_at);

  // Turning it off keeps the stored destination but disables the send.
  writeBgNotify('alice', { enabled: false });
  assert.equal(isBgNotifyEnabled('alice'), false);
  assert.equal(readBgNotify('alice').chatId, 42);
});

test('a flag of one profile never leaks to another', () => {
  writeBgNotify('carol', { enabled: true, chatId: 99 });
  assert.equal(isBgNotifyEnabled('carol'), true);
  assert.equal(isBgNotifyEnabled('dave'), false);
});
