const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('prepareWebTaskFiles materializes durable refs and prepends a real local file note', async () => {
  const oldHome = process.env.HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'web-bearer-files-'));
  process.env.HOME = tmp;
  process.env.AGENT_DATA_DIR = tmp;
  process.env.USERS_DIR = tmp;
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/src/data-paths.js') || key.includes('/src/web-routes.js')) delete require.cache[key];
  }
  const { userWorkDir } = require('../src/data-paths');
  const workDir = userWorkDir('alice');
  const id = 'a'.repeat(64);
  const store = path.join(workDir,'media','intake-store',id);
  fs.mkdirSync(store,{recursive:true});
  fs.writeFileSync(path.join(store,'data'),'attachment-bytes');
  fs.writeFileSync(path.join(store,'meta.json'),JSON.stringify({name:'CV.pdf',mime:'application/pdf'}));
  const { prepareWebTaskFiles } = require('../src/web-routes');
  const out = await prepareWebTaskFiles('alice','analyse',[{id,name:'CV.pdf'}]);
  assert.match(out.task,/Файл сохранён:/);
  assert.match(out.task,/analyse/);
  assert.equal(out.fileRefs[0].id,id);
  const materialized = path.join(workDir,'media','intake',id+'-CV.pdf');
  assert.equal(fs.readFileSync(materialized,'utf8'),'attachment-bytes');
  process.env.HOME = oldHome;
});

test('session bearer readers expose projectId and summary metadata', () => {
  const src = fs.readFileSync(path.join(__dirname,'../src/web-routes.js'),'utf8');
  assert.match(src,/summary: s\.summary \|\| null/);
  assert.match(src,/projectId: s\.projectId \|\| null/);
  assert.match(src,/projectId: session\.projectId \|\| meta\.projectId \|\| null/);
});

test('bearer run contract validates projectId and carries project/file metadata into streamWebTask', () => {
  const src = fs.readFileSync(path.join(__dirname,'../src/handlers/web.js'),'utf8');
  assert.match(src,/isValidProjectId\(projectId\)/);
  assert.match(src,/await prepareWebTaskFiles\(username, taskText, refs, secrets\)/);
  assert.match(src,/projectId: projectId \|\| null, fileRefs: prepared\.fileRefs/);
  assert.match(src,/\/web\/intake-file-bearer/);
});


test('attachment-only effective task is valid after file materialization', async () => {
  const oldHome = process.env.HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'web-bearer-attachment-only-'));
  process.env.HOME = tmp;
  process.env.AGENT_DATA_DIR = tmp;
  process.env.USERS_DIR = tmp;
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/src/data-paths.js') || key.includes('/src/web-routes.js')) delete require.cache[key];
  }
  const { userWorkDir } = require('../src/data-paths');
  const workDir = userWorkDir('alice');
  const id = 'b'.repeat(64);
  const store = path.join(workDir,'media','intake-store',id);
  fs.mkdirSync(store,{recursive:true});
  fs.writeFileSync(path.join(store,'data'),'only-file');
  fs.writeFileSync(path.join(store,'meta.json'),JSON.stringify({name:'only.pdf',mime:'application/pdf'}));
  const { prepareWebTaskFiles } = require('../src/web-routes');
  const out = await prepareWebTaskFiles('alice','',[{id,name:'only.pdf'}]);
  assert.match(out.task,/Файл сохранён:/);
  assert.ok(out.task.trim().length > 0);
  process.env.HOME = oldHome;
});

test('web mutation receipt is durable and duplicate claim does not re-accept', () => {
  const oldHome = process.env.HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'web-bearer-idempotency-'));
  process.env.HOME = tmp;
  process.env.AGENT_DATA_DIR = tmp;
  process.env.USERS_DIR = tmp;
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/src/data-paths.js') || key.includes('/src/web-routes.js')) delete require.cache[key];
  }
  const wr = require('../src/web-routes');
  const first = wr.claimWebMutation('alice','req-123',{kind:'run'});
  const second = wr.claimWebMutation('alice','req-123',{kind:'run'});
  assert.equal(first.claimed,true);
  assert.equal(second.claimed,false);
  assert.equal(second.receipt.requestId,'req-123');
  wr.completeWebMutation('alice','req-123',{state:'done',sessionId:'s-1'});
  const third = wr.claimWebMutation('alice','req-123',{kind:'run'});
  assert.equal(third.claimed,false);
  assert.equal(third.receipt.state,'done');
  assert.equal(third.receipt.sessionId,'s-1');
  process.env.HOME = oldHome;
});

test('bearer handlers accept attachment-only and expose requestId duplicate contract', () => {
  const src = fs.readFileSync(path.join(__dirname,'../src/handlers/web.js'),'utf8');
  assert.match(src,/task or attachment required/);
  assert.match(src,/message or attachment required/);
  assert.match(src,/duplicate request already accepted/);
  assert.match(src,/requestId: requestId \|\| null/);
});
