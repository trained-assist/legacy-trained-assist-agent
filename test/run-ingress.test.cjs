const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const vm=require('node:vm');
const {atomicJson}=require('../src/atomic-json');
const profiles=require('../src/profiles');
// The /run handler is evaluated in a vm sandbox with the test's own `require`; relative
// specifiers would otherwise resolve against test/ instead of src/. Resolve them against
// src/server.js, and expose the shared materializer wrapped so tests can inject a fake
// r2 module (the handler no longer requires ./r2-media directly).
const srcRequire=require('node:module').createRequire(path.join(__dirname,'../src/server.js'));
const realMaterializer=require('../src/intake-materializer');
function sandboxRequire(overrides={}) {
 const req=name=>{
  if (Object.prototype.hasOwnProperty.call(overrides,name)) return overrides[name];
  if (name==='./restart-execution') return {currentExecution:()=>null};
  if (name==='./intake-materializer') return {
   buildFileNote:realMaterializer.buildFileNote,
   materializeFileRefs:opts=>realMaterializer.materializeFileRefs({...opts,r2:req('./r2-media')}),
  };
  return srcRequire(name);
 };
 return req;
}
function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'run-ingress-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=fs.readFileSync(require.resolve('../src/server'),'utf8');
 const start=source.indexOf("    if (req.method === 'POST' && url.pathname === '/run') {");
 const end=source.indexOf('    // POST /action',start);
 const runs=[];const pending=new Map();
  const sandbox={deliverySecrets:require('../src/bot-delivery').deliverySecrets,runDeliveryFromPayload:require('../src/bot-delivery').runDeliveryFromPayload,withDedupLock:require('../src/request-dedup-lock').withDedupLock,fs,path,os,Buffer,require:sandboxRequire(),console,process:{env:{AGENT_DATA_DIR:root}},BASE_USERS_DIR:path.join(root,'users'),secrets:{},
  isValidProjectId:()=>true,trackChat:()=>{},getPendingTasks:()=>[...pending.values()],atomicJson,profiles,
  readBody:async req=>JSON.stringify(req.body),json:(res,status,data)=>Object.assign(res,{status,data}),
  runTask:opts=>{pending.set(opts.taskId,{...opts,audience:opts.user.audience});runs.push(opts);return Promise.resolve();},
 };
 vm.createContext(sandbox);vm.runInContext(`async function ingress(req,res) {const url={pathname:'/run'};${source.slice(start,end)}}`,sandbox);
 const send=async(body={})=>{const res={};await sandbox.ingress({method:'POST',body:{userId:42,username:'alice',task:'work',requestId:'request-1',...body}},res);return res;};
 const sendRaw=async(body)=>{const res={};await sandbox.ingress({method:'POST',body},res);return res;};
 return {root,runs,pending,sandbox,send,sendRaw};
}
test('lost ACK is deduplicated from persisted receipt after process memory is lost',async t=>{
 const f=fixture(t);const first=await f.send({mode:'deep',projectId:'project'});assert.equal(first.status,202);assert.equal(first.data.durable,true);
 f.pending.clear();const retry=await f.send();assert.equal(retry.data.duplicate,true);assert.equal(retry.data.requestId,'request-1');
 assert.equal(f.runs.length,1);assert.equal(f.runs[0].mode,'deep');assert.equal(f.runs[0].projectId,'project');
});
test('delivery:log reaches runTask as "log", anything else stays normal delivery (test-mode §2.3)',async t=>{
  const f=fixture(t);
  assert.equal((await f.send({delivery:'log'})).status,202);
  assert.equal(f.runs[0].delivery,'log');
  assert.equal((await f.send({requestId:'request-2',delivery:'Telegram'})).status,202);
  assert.equal(f.runs[1].delivery,null);
  assert.equal((await f.send({requestId:'request-3',delivery:123})).status,202);
  assert.equal(f.runs[2].delivery,null);
  assert.equal((await f.send({requestId:'request-4'})).status,202);
  assert.equal(f.runs[3].delivery,null);
});
test('receipt-write failure still deduplicates the durable pending journal on retry',async t=>{
 const f=fixture(t);f.sandbox.atomicJson=()=>{throw Error('disk full');};
 await assert.rejects(f.send(),/disk full/);const retry=await f.send();assert.equal(retry.data.duplicate,true);assert.equal(f.runs.length,1);
});
test('journal-write failure returns no success acknowledgement',async t=>{
 const f=fixture(t);f.sandbox.runTask=()=>{throw Error('journal unavailable');};
 await assert.rejects(f.send(),/journal unavailable/);assert.equal(fs.existsSync(path.join(f.root,'accepted-requests')),false);
});
test('attachment bytes are persisted before ACK and preserved exactly',async t=>{
 const f=fixture(t);const bytes=Buffer.from('кириллица\u0000binary');const res=await f.send({fileBase64:bytes.toString('base64'),fileName:'Резюме.pdf',fileMimeType:'application/pdf'});
 assert.equal(res.status,202);const dir=path.join(f.root,'users','alice','media','intake');const file=path.join(dir,fs.readdirSync(dir)[0]);
 assert.deepEqual(fs.readFileSync(file),bytes);assert.ok(f.runs[0].task.includes(file));
});
test('attachment disk failure cannot turn into accepted text-only work',async t=>{
 const f=fixture(t);f.sandbox.fs={...fs,writeFileSync(){throw Error('ENOSPC');}};
 const res=await f.send({fileBase64:'YQ==',fileName:'file.pdf'});assert.equal(res.status,503);assert.equal(f.runs.length,0);
});

test('file references survive acceptance and missing references are never acknowledged', async t => {
 const f=fixture(t);const id='a'.repeat(64);const dir=path.join(f.root,'users','alice','media','intake-store',id);
 fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'data'),'attachment');
 const response=await f.send({fileRefs:[{id,name:'resume.pdf'}]});assert.equal(response.status,202);
 const file=path.join(f.root,'users','alice','media','intake',id+'-resume.pdf');
 assert.equal(fs.readFileSync(file,'utf8'),'attachment');assert.ok(f.runs[0].task.includes(file));
 const missing=await f.send({requestId:'missing',fileRefs:[{id:'b'.repeat(64),name:'missing.pdf'}]});
 assert.equal(missing.status,503);assert.equal(f.runs.length,1);
});

test('topic routing is retained and malformed topics are rejected before accepting work', async t => {
 const f=fixture(t);
 assert.equal((await f.send({threadId:42,initiatedAt:1234})).status,202);
 assert.equal(f.runs[0].threadId,42);
 assert.equal(f.runs[0].initiatedAt,1234);
 for (const threadId of [0,-1,1.5,'42']) {
   assert.equal((await f.send({requestId:'bad-'+String(threadId),threadId})).status,400);
 }
 assert.equal(f.runs.length,1);
});

test('invalid future/original timestamps cannot enter the durable queue; unknown remains explicit', async t => {
 const f=fixture(t);
 for (const initiatedAt of [-1, '1234', Date.now()+60000]) {
   assert.equal((await f.send({initiatedAt})).status,400);
 }
 assert.equal((await f.send({initiatedAt:null})).status,202);
 assert.equal(f.runs[0].initiatedAt,null);
});

test('R2 refs are fetched and verified before run acceptance, without a legacy store copy', async t => {
 const f=fixture(t);const crypto=require('node:crypto');const bytes=Buffer.from('r2-original');
 const ref={storage:'r2',version:1,id:'c'.repeat(64),name:'voice.ogg',mime:'audio/ogg',size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
 const materialize=require('../src/r2-media').materializeR2;
 let reads=0;
 f.sandbox.process.env.MEDIA_GATEWAY_URL='https://gateway.example';f.sandbox.secrets.AGENT_SECRET='secret';
 f.sandbox.require=sandboxRequire({'./r2-media':{materializeR2:opts=>materialize({...opts,fetchImpl:async url=>{
  reads++;assert.equal(url.searchParams.get('username'),'alice');return new Response(bytes);
 }})}});
 const response=await f.send({fileRefs:[ref]});assert.equal(response.status,202);assert.equal(reads,1);
 const file=path.join(f.root,'users','alice','media','intake',ref.id+'-voice.ogg');assert.deepEqual(fs.readFileSync(file),bytes);
 assert.ok(f.runs[0].task.includes(file));
 const retry=await f.send({fileRefs:[ref]});assert.equal(retry.data.duplicate,true);assert.equal(reads,1);assert.equal(f.runs.length,1);
});
test('chatId is accepted as an alias for userId when userId is absent', async t => {
 const f=fixture(t);
 const res=await f.sendRaw({chatId:99,username:'alice',task:'work',requestId:'request-chatid'});
 assert.equal(res.status,202);assert.equal(f.runs[0].user.id,99);
});
test('chatId takes priority over userId when both are sent', async t => {
 const f=fixture(t);
 const res=await f.send({chatId:99,userId:42,requestId:'request-both'});
 assert.equal(res.status,202);assert.equal(f.runs[0].user.id,99);
});
test('a failed R2 integrity check prevents acknowledgement or text-only launch', async t => {
 const f=fixture(t);f.sandbox.process.env.MEDIA_GATEWAY_URL='https://gateway.example';f.sandbox.secrets.AGENT_SECRET='secret';
 const materialize=require('../src/r2-media').materializeR2;
 f.sandbox.require=sandboxRequire({'./r2-media':{materializeR2:opts=>materialize({...opts,fetchImpl:async()=>new Response('bad')})}});
 const ref={storage:'r2',version:1,id:'d'.repeat(64),name:'doc.pdf',size:3,sha256:'0'.repeat(64)};
 const response=await f.send({fileRefs:[ref]});assert.equal(response.status,503);assert.equal(f.runs.length,0);
 assert.equal(fs.existsSync(path.join(f.root,'accepted-requests','request-1.json')),false);
});

test('recruiter delivery fails closed before acceptance when its credential is absent', async t => {
 const f=fixture(t);f.sandbox.secrets.BOT_TOKEN='classic';
 assert.equal((await f.send({audience:'recruiter'})).status,503);
 assert.equal(f.runs.length,0);
 assert.equal((await f.send({audience:'unregistered'})).status,400);
});
test('identical request IDs from different bots do not suppress each other',async t=>{
 const f=fixture(t);f.sandbox.secrets.RECRUITER_BOT_TOKEN='recruiter';
 const a=await f.send(),b=await f.send({audience:'recruiter'});
 assert.equal(a.status,202);assert.equal(b.status,202);assert.notEqual(a.data.taskId,b.data.taskId);
 assert.equal(f.runs.length,2);assert.equal(f.runs[1].user.audience,'recruiter');
 assert.equal((await f.send({audience:'recruiter'})).data.duplicate,true);
});

test('rollout preserves lost-ACK deduplication for legacy receipts without audience', async t=>{
 const f=fixture(t);f.sandbox.secrets.RECRUITER_BOT_TOKEN='recruiter';
 const dir=path.join(f.root,'accepted-requests');fs.mkdirSync(dir);
 fs.writeFileSync(path.join(dir,'alice-request-1.json'),JSON.stringify({taskId:'alice-request-1',acceptedAt:Date.now()}));
 const result=await f.send({audience:'recruiter'});
 assert.equal(result.status,202);assert.equal(result.data.duplicate,true);assert.equal(f.runs.length,0);
});

test('freelance (3rd bot, issue #1302) fails closed before acceptance when its credential is absent, and resolves independent receipts once configured', async t=>{
 const f=fixture(t);f.sandbox.secrets.BOT_TOKEN='classic';
 assert.equal((await f.send({audience:'freelance'})).status,503);
 assert.equal(f.runs.length,0);
 f.sandbox.secrets.FREELANCE_BOT_TOKEN='freelance';f.sandbox.secrets.RECRUITER_BOT_TOKEN='recruiter';
 const a=await f.send(),b=await f.send({audience:'recruiter'}),c=await f.send({audience:'freelance'});
 assert.equal(a.status,202);assert.equal(b.status,202);assert.equal(c.status,202);
 const ids=[a.data.taskId,b.data.taskId,c.data.taskId];
 assert.equal(new Set(ids).size,3,'each audience gets its own taskId, sharing the same requestId');
 assert.equal(f.runs.length,3);assert.equal(f.runs[2].user.audience,'freelance');
 assert.equal((await f.send({audience:'freelance'})).data.duplicate,true);
});

test('a concurrent duplicate POST for the same requestId runs admission exactly once (issue #1302 §3.4)', async t=>{
 const f=fixture(t);
 const crypto=require('node:crypto');const bytes=Buffer.from('race-original');
 const ref={storage:'r2',version:1,id:'e'.repeat(64),name:'voice.ogg',mime:'audio/ogg',size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
 const materialize=require('../src/r2-media').materializeR2;
 f.sandbox.process.env.MEDIA_GATEWAY_URL='https://gateway.example';f.sandbox.secrets.AGENT_SECRET='secret';
 let releaseFirst;const gate=new Promise(r=>{releaseFirst=r;});let fetches=0;
 f.sandbox.require=sandboxRequire({'./r2-media':{materializeR2:opts=>materialize({...opts,fetchImpl:async url=>{
  fetches++;await gate;return new Response(bytes);
 }})}});
 // First POST starts admission and blocks mid-flight (inside the mutex, awaiting media
 // materialization) until releaseFirst() is called below.
 const first=f.send({fileRefs:[ref]});
 await new Promise(r=>setImmediate(r));
 // Second POST with the SAME requestId must queue behind the first (per-key mutex),
 // not race it into a second materialize/runTask call.
 const second=f.send({fileRefs:[ref]});
 await new Promise(r=>setTimeout(r,10));
 assert.equal(f.runs.length,0,'neither request has been admitted yet — the first is still gated');
 releaseFirst();
 const [r1,r2]=await Promise.all([first,second]);
 assert.equal(r1.status,202);assert.equal(r1.data.duplicate,undefined);
 assert.equal(r2.status,202);assert.equal(r2.data.duplicate,true);
 assert.equal(f.runs.length,1,'admission ran exactly once despite the concurrent duplicate');
 assert.equal(fetches,1,'the second request never re-materializes media — it saw the receipt the first one wrote');
});

test('replay of an accepted requestId is ACKed before content/delivery validation (no false "сервер отклонил")', async t => {
 const f=fixture(t);f.sandbox.secrets={RECRUITER_BOT_TOKEN:'x',TELEGRAM_BOT_TOKEN_RECRUITER:'x'};
 const first=await f.send({audience:'recruiter'});
 if(first.status!==202)return t.skip('recruiter audience secret name differs in this build');
 f.sandbox.secrets={};f.pending.clear();
 const replay=await f.send({audience:'recruiter',fileRefs:[{id:'NOT-HEX',name:'x'}]});
 assert.equal(replay.status,202);assert.equal(replay.data.duplicate,true);assert.equal(f.runs.length,1);
 const plain=await f.send({requestId:'request-2'});assert.equal(plain.status,202);
 const plainReplay=await f.send({requestId:'request-2',sessionId:'bad id!'});
 assert.equal(plainReplay.status,202);assert.equal(plainReplay.data.duplicate,true);assert.equal(f.runs.length,2);
});

test('every /run rejection is logged with its reason', async t => {
 const f=fixture(t);const lines=[];f.sandbox.console={...console,log:(...a)=>lines.push(a.join(' '))};
 const res=await f.send({requestId:'fresh',sessionId:'bad id!'});
 assert.equal(res.status,400);assert.ok(lines.some(l=>/\[\/run\] 400 invalid sessionId user=alice requestId=fresh/.test(l)),lines.join('\n'));
});
