import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const api = require('../src/domains/hh/lib').hhLib('hh-proactive-search');
const schedule = require('../src/domains/hh/lib').hhLib('hh-cold-search-schedule');
let root, work, old;
const user = 'fixture-notify';
const keys = ['AGENT_DATA_DIR', 'AGENT_TOKENS_DIR', 'USER_ID', 'USERS_DIR', 'OPENROUTER_API_KEY'];
function context(key,value){const dir=path.join(work,'contexts/hh');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,key+'.json'),JSON.stringify({value}));}
beforeEach(()=>{
 old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));root=fs.mkdtempSync(path.join(os.tmpdir(),'notify-off-'));
 process.env.AGENT_DATA_DIR=path.join(root,'data');process.env.AGENT_TOKENS_DIR=path.join(root,'tokens');process.env.USERS_DIR=path.join(root,'users');process.env.USER_ID=user;delete process.env.OPENROUTER_API_KEY;
 work=path.join(process.env.USERS_DIR,user);fs.mkdirSync(work,{recursive:true});
});
afterEach(()=>{vi.unstubAllGlobals();for(const k of keys)old[k]===undefined?delete process.env[k]:process.env[k]=old[k];fs.rmSync(root,{recursive:true,force:true});});
it('stops all schedules with no selected vacancy, preserves other users and survives reload',()=>{
 api.saveSchedule(user,{enabled:true,vacancies:{A:{enabled:true,interval_hours:8},B:{enabled:true}}});
 api.saveSchedule('other',{enabled:true});require('../src/domains/hh/lib').hhLib('hh-autoscan').enable(user);
 schedule.disableSearches(user,work);schedule.disableSearches(user,work);
 expect(api.loadSchedule(user)).toMatchObject({enabled:false,vacancies:{A:{enabled:false,interval_hours:8},B:{enabled:false}}});
 expect(api.loadSchedule('other').enabled).toBe(true);expect(require('../src/domains/hh/lib').hhLib('hh-autoscan').readState(user).enabled).toBe(false);
});
it('stops legacy state without an active vacancy and leaves manual search data intact',()=>{
 api.saveSchedule(user,{enabled:true,interval_hours:12});schedule.disableSearches(user,work);
 expect(api.loadSchedule(user)).toMatchObject({enabled:false,interval_hours:12});
});
it('explicit vacancy stop leaves other schedules enabled',()=>{
 api.saveSchedule(user,{enabled:true,vacancies:{A:{enabled:true},B:{enabled:true}}});schedule.disableSearches(user,work,'A');
 expect(schedule.notificationsEnabled(user,work,'A')).toBe(false);expect(schedule.notificationsEnabled(user,work,'B')).toBe(false);
});
it('legacy notification hooks never run while search still persists results',async()=>{
 context('active_vacancy',{id:'A',area:{id:'2'}});context('active_vacancies',[{id:'A',area:{id:'2'}}]);
 const config={vacancy_id:'A',vacancy_title:'Engineer',required:[{name:'Engineer',weight:5}]};context('ats_config:A',config);
 api.saveStoredQueries(user,'A',['Engineer'],api.atsConfigHash(config));
 const dir=path.join(process.env.AGENT_TOKENS_DIR,user);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'hh'),'{"access_token":"fixture"}');
 api.saveSchedule(user,{enabled:true,vacancies:{A:{enabled:true}}});
 vi.stubGlobal('fetch',vi.fn(async()=>{return {ok:true,status:200,headers:new Headers(),json:async()=>({items:[]})};}));
 const notify=vi.fn();await api.runProactiveSearch(user,work,{vacancyId:'A',alwaysNotify:true,notifyChat:notify});await new Promise(r=>setImmediate(r));expect(notify).not.toHaveBeenCalled();
 const result=await api.runProactiveSearch(user,work,{vacancyId:'A'});expect(result.count).toBe(0);
});

it('mute preserves cadence, enabled searches and other profiles',async()=>{
 context('active_vacancies',[{id:'A'},{id:'B'}]);
 api.saveSchedule(user,{enabled:true,vacancies:{A:{enabled:true,interval_hours:8},B:{enabled:true}}});
 api.saveSchedule('other',{enabled:true});
 schedule.setNotifications(user,work,false);
 expect(api.loadSchedule(user)).toMatchObject({enabled:true,vacancies:{A:{enabled:true,interval_hours:8},B:{enabled:true}}});
 expect(schedule.notificationsEnabled(user,work,'A')).toBe(false);
 expect(schedule.deliveryEnabled('other',work,'A')).toBe(false);
 schedule.setNotifications(user,work,true,'A');
 expect(schedule.notificationsEnabled(user,work,'A')).toBe(false);
 expect(schedule.notificationsEnabled(user,work,'B')).toBe(false);
 schedule.setNotifications(user,work,false);expect(schedule.notificationsEnabled(user,work,'A')).toBe(false);
});
it('mute without selected vacancy persists for future searches; unmute never enables a stopped search',()=>{
 api.saveSchedule(user,{enabled:false,interval_hours:12});
 schedule.setNotifications(user,work,false);
 schedule.updateSchedule(user,work,'NEW',{enabled:true});
 expect(schedule.notificationsEnabled(user,work,'NEW')).toBe(false);
 schedule.disableSearches(user,work);schedule.setNotifications(user,work,true);
 expect(api.loadSchedule(user).enabled).toBe(false);
 expect(schedule.notificationsEnabled(user,work,'NEW')).toBe(false);
});

it('muting legacy schedule without a selected vacancy preserves future scheduling',()=>{
 api.saveSchedule(user,{enabled:true,interval_hours:12});schedule.setNotifications(user,work,false);
 context('active_vacancy',{id:'L'});
 expect(schedule.getSchedules(user,work).L).toMatchObject({enabled:true,interval_hours:12});
});

it('retired controls cannot enable delivery or mutate existing schedules',()=>{
 const saved={enabled:true,notifications_enabled:true,vacancies:{A:{enabled:true,interval_hours:8,notifications_enabled:true,notify_threshold:75}}};
 api.saveSchedule(user,saved);
 for(const enabled of [true,false]){
  expect(schedule.setNotifications(user,work,enabled,'A')).toMatchObject({retired:true,notifications_enabled:false});
  expect(schedule.deliveryEnabled(user,work,'A')).toBe(false);
  expect(api.loadSchedule(user)).toEqual(saved);
 }
});
