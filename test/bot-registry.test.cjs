// Epic #1342 Phase 0 — bot registry is the single source of truth for bot tokens.
const {test}=require('node:test');const assert=require('node:assert/strict');
const {BOTS,loadRegistry,tokenSecretName,missingBotTokens}=require('../src/bot-registry');
const {deliverySecrets}=require('../src/bot-delivery');
const {alertMissingBotTokens,loadSecrets,REQUIRED,OPTIONAL}=require('../src/secrets');
const fs=require('node:fs');const path=require('node:path');

test('registry has the classic default bot and unique ids/audiences/token names',()=>{
 assert.equal(tokenSecretName('default'),'TELEGRAM_BOT_TOKEN');
 for(const f of ['botId','audience','token_secret_name']) assert.equal(new Set(BOTS.map(b=>b[f])).size,BOTS.length,f);
});
test('every registry token is loaded by secrets.js (else boot never sees it)',()=>{
 const loaded=new Set([...REQUIRED,...OPTIONAL]);
 for(const b of BOTS) assert.ok(loaded.has(b.token_secret_name),b.token_secret_name);
});
test('every registry audience is routable by bot-delivery, and routes to its own token',()=>{
 const secrets={BOT_TOKEN:'classic'};for(const b of BOTS) if(b.audience!=='default') secrets[b.token_secret_name]='tok-'+b.botId;
 for(const b of BOTS) assert.equal(deliverySecrets(secrets,b.audience).BOT_TOKEN,b.audience==='default'?'classic':'tok-'+b.botId);
 assert.throws(()=>deliverySecrets(secrets,'not-in-registry'),/Unsupported/);
});
test('a new bot is one registry entry: delivery + missing-token detection pick it up',()=>{
  const bots=loadRegistry({bots:{registry:[...BOTS,{botId:'x',audience:'x',token_secret_name:'X_BOT_TOKEN',enabled:true}]}});
  assert.equal(tokenSecretName('x',bots),'X_BOT_TOKEN');
  // The fixture deliberately lists every REAL token except the new bot's, so the
  // expected list must follow the registry: a hardcoded trio stopped being true
  // the moment `sales` was registered (its own test below covers the case).
  const allReal={};for(const b of BOTS) allReal[b.token_secret_name]='present';
  delete allReal.X_BOT_TOKEN;
  assert.deepEqual(missingBotTokens(allReal,bots).map(b=>b.botId),['x']);
});
test('the sales audience answers as @cmr_management_bot, never as the classic bot',()=>{
  // Regression: flexi-telegram-deal-bot delegates via POST /run. Without its own
  // audience the agent replied with TELEGRAM_BOT_TOKEN, the classic bot is not in
  // the sales groups, and every answer died on sendMessage 403 AFTER a 202 — the
  // operator saw «⏳ Передаю ассистенту…» and silence.
  assert.equal(tokenSecretName('sales'),'SALES_BOT_TOKEN');
  const secrets={BOT_TOKEN:'classic',TELEGRAM_BOT_TOKEN:'classic',SALES_BOT_TOKEN:'sales-bot'};
  assert.equal(deliverySecrets(secrets,'sales').BOT_TOKEN,'sales-bot');
});
test('disabled bots are never reported missing; empty registry is a hard error',()=>{
 assert.deepEqual(missingBotTokens({},[{botId:'off',audience:'off',token_secret_name:'OFF',enabled:false}]),[]);
 assert.throws(()=>loadRegistry({bots:{registry:[]}}),/bots.registry/);
});
test('boot alert: missing bot → operator message via the classic bot; nothing missing → silent',async()=>{
 const calls=[];const fetchImpl=async(url,o)=>{calls.push({url,body:JSON.parse(o.body)});return {ok:true};};
 assert.equal(await alertMissingBotTokens({BOT_TOKEN:'classic',MISSING_BOTS:[]},{fetchImpl}),false);
 assert.equal(calls.length,0);
 assert.equal(await alertMissingBotTokens({BOT_TOKEN:'classic',OPERATOR_CHAT_ID:'42',MISSING_BOTS:['recruiter']},{fetchImpl}),true);
 assert.equal(calls.length,1);assert.match(calls[0].url,/\/botclassic\/sendMessage$/);
 assert.equal(calls[0].body.chat_id,'42');assert.match(calls[0].body.text,/recruiter/);
});

// 2026-09-28: the RU box printed two false `BOT TOKEN MISSING` lines on EVERY
// ru-edge start — recruiter/freelance tokens are legitimately absent there (the
// edge delivers only via the classic bot), so the audit had to become opt-out.
test('auditBots:false silences the registry audit; the default stays loud', async()=>{
 const saved={...process.env};
 process.env.SECRETS_SOURCE='env';
 process.env.TELEGRAM_BOT_TOKEN='classic';
 process.env.AGENT_SECRET='s3cret';
 delete process.env.RECRUITER_BOT_TOKEN;
 delete process.env.FREELANCE_BOT_TOKEN;
 const errs=[];const orig=console.error;console.error=(...a)=>errs.push(a.join(' '));
 try{
   const edge=await loadSecrets({auditBots:false});
   assert.equal(errs.length,0,'ru-edge boot must not cry about registry bots');
    // The data is unchanged — only the log is suppressed.
    assert.deepEqual(edge.MISSING_BOTS,BOTS.filter(b=>b.audience!=='default').map(b=>b.botId));
    errs.length=0;
    await loadSecrets();
    assert.equal(errs.filter(e=>e.includes('BOT TOKEN MISSING')).length,edge.MISSING_BOTS.length,'agent boot stays loud');
 }finally{
   console.error=orig;
   for(const k of Object.keys(process.env)) if(!(k in saved)) delete process.env[k];
   Object.assign(process.env,saved);
 }
});
test('ru-edge passes auditBots:false (guard against reintroducing the noise)',()=>{
 const src=fs.readFileSync(path.join(__dirname,'..','src','ru-edge.js'),'utf8');
 assert.match(src,/loadSecrets\(\{\s*auditBots:\s*false\s*\}\)/,'ru-edge must opt out of the registry audit');
});
