import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHmac } from 'node:crypto';
const require = createRequire(import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'response-refresh-'));
const users = path.join(root, 'users'), tokens = path.join(root, 'tokens'), data = path.join(root, 'data');
let mock, server, base, cache, browser;
let version = 1, fail = false, hhCalls = 0;
const secret = 'fixture-secret', username = 'alice', vacancy = 'v1';
const token = createHmac('sha256', secret).update(username).digest('hex').slice(0,16);
const query = `username=${username}&token=${token}&vacancy_id=${vacancy}`;
function write(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj)); }
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const envKeys = ['AGENT_SECRET','AGENT_DATA_DIR','AGENT_TOKENS_DIR','USERS_DIR','HH_API_BASE_URL'];
const previous = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
beforeAll(async () => {
  process.env.AGENT_SECRET=secret; process.env.AGENT_DATA_DIR=data; process.env.AGENT_TOKENS_DIR=tokens; process.env.USERS_DIR=users;
  write(path.join(users,username,'contexts/hh/active_vacancy.json'), {value:{id:vacancy,title:'Финансовый советник'}});
  write(path.join(tokens,username,'hh'), {access_token:'fixture'});
  write(path.join(data,'hh',username,'candidates/n1.json'), {messages:[],ats_result:{score:8,verdict:'ПРОПУСТИТЬ'}});
  mock = http.createServer((req,res) => {
    hhCalls++;
    if(req.headers.authorization === 'Bearer expired'){res.writeHead(401);return res.end(JSON.stringify({errors:[{value:'token-expired'}]}));}
    if (fail) { res.writeHead(503); return res.end('{}'); }
    const items = req.url.startsWith('/negotiations/response?') ? [{id:'n1',_resume_status:'full',resume:{id:'r1',first_name:'Иван'+version},created_at:'2026-09-05T12:00:00Z',updated_at:'2026-09-24T12:00:00Z',counters:{messages:0}}] : [];
    res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({items,pages:1}));
  });
  await listen(mock); process.env.HH_API_BASE_URL=`http://127.0.0.1:${mock.address().port}`;
  cache = require('../../src/domains/hh/lib').hhLib('hh-negotiations').createHhNegotiations({refreshHhToken:async()=>null,readChatId:()=>null,getSecretsCache:()=>({})});
  const {handleHhPublic} = require('../../src/domains/hh/lib').hhLib('hh-routes');
  server = http.createServer(async (req,res) => {
    try { const result=await handleHhPublic(req,new URL(req.url,'http://localhost'),res,{...cache,BASE_USERS_DIR:users,PORT:0,getSecretsCache:()=>({}),secrets:{},readChatId:()=>null}); if(result===false){res.writeHead(404);res.end();} }
    catch(e){res.writeHead(500);res.end(e.message);}
  });
  await listen(server); base=`http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  if(browser) await browser.close(); await close(server); await close(mock);
  for(const k of envKeys) previous[k] === undefined ? delete process.env[k] : process.env[k]=previous[k];
  fs.rmSync(root,{recursive:true,force:true});
});
async function post(route, body) { return fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,token,vacancy_id:vacancy,...body})}); }
describe('HH response refresh and durable triage', () => {
  it('manual refresh replaces the exact cache read by the page, never the undefined vacancy cache', async () => {
    let r=await fetch(base+'/hh/review?'+query); expect(await r.text()).toContain('Иван1');
    version=2; r=await post('/hh/sync-negotiations',{}); expect(r.status).toBe(200);
    r=await fetch(base+'/hh/review?'+query); const html=await r.text(); expect(html).toContain('Иван2');
    expect(html).not.toContain(secret); expect(html).toContain('2026-09-05');
    expect(fs.existsSync(cache.hhCacheFile(data,username,undefined))).toBe(false);
    expect(JSON.parse(fs.readFileSync(cache.hhCacheFile(data,username,vacancy))).negotiations[0].resume.first_name).toBe('Иван2');
  });
  it('rejects unsigned/cross-profile/unknown-vacancy mutations', async()=>{
    expect((await post('/hh/sync-negotiations',{token:'wrong'})).status).toBe(403);
    expect((await post('/hh/response-state',{username:'bob',negotiation_id:'n1',status:'archived'})).status).toBe(403);
    expect((await post('/hh/response-state',{vacancy_id:'v2',negotiation_id:'n1',status:'archived'})).status).toBe(403);
    const html=await (await fetch(base+'/hh/review?'+query.replace('v1','v2'))).text(); expect(html).not.toContain('Иван2');
  });
  it('keeps saved rows and displays failure instead of pretending HH returned zero',async()=>{
    const file=cache.hhCacheFile(data,username,vacancy);const saved=JSON.parse(fs.readFileSync(file));saved.synced_at=1;write(file,saved);fail=true;
    const html=await (await fetch(base+'/hh/review?'+query)).text();expect(html).toContain('role="alert"');expect(html).toContain('Иван2');
    expect((await post('/hh/sync-negotiations',{})).status).toBe(500); fail=false; await post('/hh/sync-negotiations',{});
  });
  it('star/archive/restore survives reload and sync; archive makes no HH call; refusal remains available',async()=>{
    const {chromium}=require('playwright'); browser=await chromium.launch({headless:true});const page=await browser.newPage();
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/hh/review?'+query);
    await Promise.all([page.waitForNavigation(),page.locator('#tab-all [data-testid=response-star]').click()]);
    expect(await page.locator('#tab-all .card').count()).toBe(0);
    await page.getByRole('link',{name:'★ Избранные (1)',exact:true}).click();
    expect(await page.locator('#tab-all .card').count()).toBe(1);
    const before=hhCalls;
    await Promise.all([page.waitForNavigation(),page.locator('#tab-all').getByRole('button',{name:'В архив',exact:true}).click()]);
    expect(hhCalls).toBe(before);
    await page.getByRole('link',{name:'Архив (1)',exact:true}).click();
    expect(await page.locator('#tab-all').getByRole('button',{name:'✗ Отправить отказ',exact:true}).count()).toBe(1);
    expect(await page.locator('#tab-all .card-cb:checked').count()).toBe(0);
    await post('/hh/sync-negotiations',{});await page.evaluate(()=>checkResponseUpdates());await expect.poll(()=>page.locator('#responseUpdates').textContent()).toContain('Данные HH обновились');await page.reload();expect(await page.locator('#tab-all .card').count()).toBe(1);
    await Promise.all([page.waitForNavigation(),page.locator('#tab-all [data-testid=response-restore]').click()]);
    await page.getByRole('link',{name:'Активные (1)',exact:true}).click();expect(await page.locator('#tab-all .card').count()).toBe(1);
    const {readResponseState}=require('../../src/domains/hh/lib').hhLib('hh-response-state');expect(readResponseState(data,username,'v2','n1')).toBe('active');
    expect(errors).toEqual([]);await page.close();
  });
  it('refreshes expired HH tokens once with the real HH API error format',async()=>{
    let refreshes=0;
    const refreshed=require('../../src/domains/hh/lib').hhLib('hh-negotiations').createHhNegotiations({refreshHhToken:async()=>{refreshes++;return 'fixture';},getSecretsCache:()=>({})});
    const result=await refreshed.getHhNegotiationsWithCache(data,username,vacancy,'expired',{force:true});
    expect(result.negotiations).toHaveLength(1);expect(refreshes).toBe(1);
  });
  it('background sync refreshes cache even without ATS configuration',async()=>{
    version=3; await cache.runHhScoringForUser(username);
    const saved=JSON.parse(fs.readFileSync(cache.hhCacheFile(data,username,vacancy)));
    expect(saved.negotiations[0].resume.first_name).toBe('Иван3');
  });
  it('routes the original quoted service complaint to the full agent',async()=>{
    const {runQuickAnswer}=require('../../src/runner/intent-engine');
    expect(await runQuickAnswer('работа с откликами с хх отстала от жизни нужно прокачать. диалог: покажи кандидатов',username,path.join(users,username))).toBeNull();
  });
  it('review links ignore infrastructure URL and complaint cannot qualify for HH quick reply',()=>{
    const {hhReviewUrl}=require('../../src/domains/hh/lib').hhLib('hh-quick');expect(hhReviewUrl(username,vacancy)).toContain('https://recruiter-assistant.ru/hh/review?');
    const {HH_SERVICE_CHANGE_INTENT}=require('../../src/domains/hh/lib').hhLib('hh-intents');
    expect(HH_SERVICE_CHANGE_INTENT.test('работа с откликами с хх отстала от жизни нужно прокачать. диалог: покажи кандидатов')).toBe(true);
    expect(HH_SERVICE_CHANGE_INTENT.test('покажи кандидатов')).toBe(false);
  });
});
