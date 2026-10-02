// Every enabled bots.registry entry's token must survive the loader: fetch it (the
// loader does), audit it (it does), and then PUT IT ON THE RETURNED OBJECT (this is
// what broke for `sales` on 02.10.2026 — SALES_BOT_TOKEN resolved fine, yet the
// returned secrets object had no such key, so deliverySecrets threw "sales Telegram
// delivery is not configured" → 503 on every sales run for the flexi-consult profile).
// The loader's key list must therefore be derived from the registry, never hand-kept.
const {test}=require('node:test');const assert=require('node:assert/strict');
const {BOTS}=require('../src/bot-registry');
const {loadSecrets,REQUIRED,OPTIONAL}=require('../src/secrets');
const {deliverySecrets}=require('../src/bot-delivery');
const {buildAgentEnv}=require('../src/agent-isolation');

function withEnv(values,fn){
  const saved=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));
  Object.assign(process.env,values);
  try{return fn();}finally{for(const[k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
}

const enabled=BOTS.filter(b=>b.enabled!==false);
const fixtures=Object.fromEntries(enabled.map(b=>[b.token_secret_name,`tok-${b.botId}`]));
const env={SECRETS_SOURCE:'env',...Object.fromEntries(REQUIRED.map(n=>[n,`req-${n}`])),...fixtures};

test('loader fetches every enabled bot token from the registry, not just some of them',()=>{
  for(const b of enabled){
    assert.ok([...REQUIRED,...OPTIONAL].includes(b.token_secret_name),
      `${b.token_secret_name} is not in the loader's REQUIRED/OPTIONAL — it can never be fetched`);
  }
});

test('every registry bot token reaches the object delivery reads (02.10.2026 sales 503)',async()=>{
  const secrets=await withEnv(env,()=>loadSecrets());
  for(const b of enabled){
    assert.ok(Object.hasOwn(secrets,b.token_secret_name),
      `loadSecrets() drops ${b.token_secret_name}: delivery for bot "${b.botId}" would 503`);
    assert.equal(secrets[b.token_secret_name],fixtures[b.token_secret_name]);
  }
});

test('delivery resolves each enabled audience to its own token, none missing',async()=>{
  const secrets=await withEnv(env,()=>loadSecrets());
  assert.deepEqual(secrets.MISSING_BOTS,[]);
  for(const b of enabled){
    const routed=deliverySecrets(secrets,b.audience);
    const expected=b.audience==='default'?secrets.BOT_TOKEN:fixtures[b.token_secret_name];
    assert.equal(routed.BOT_TOKEN,expected,`audience "${b.audience}" is routed to the wrong token`);
    assert.equal(routed.TELEGRAM_BOT_TOKEN,expected);
  }
});

// The other half of the same class: a bot token must never reach the engine (model) env.
// SERVER_ONLY_ENV used to be a hand-kept list that lost the race with the registry —
// SALES_BOT_TOKEN was absent until 2026-10-02, so the sales token leaked into the model
// env by construction. buildAgentEnv is the choke point, so assert there, not on the list.
test('no registry bot token can leak into the engine env (buildAgentEnv drops them all)',()=>{
  for(const b of BOTS){
    const fullEnv={};for(const x of BOTS)fullEnv[x.token_secret_name]=fixtures[x.token_secret_name]||`tok-${x.botId}`;
    const envOut=buildAgentEnv(fullEnv,{userTokenNames:BOTS.map(x=>x.token_secret_name)});
    const extraOut=buildAgentEnv({},{extra:fullEnv,userTokenNames:BOTS.map(x=>x.token_secret_name)});
    assert.ok(!Object.hasOwn(envOut,b.token_secret_name),`${b.token_secret_name} leaked from fullEnv into the engine env`);
    assert.ok(!Object.hasOwn(extraOut,b.token_secret_name),`${b.token_secret_name} leaked from extra into the engine env`);
  }
});
