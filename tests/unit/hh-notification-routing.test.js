import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
it('routes standalone stop without credentials or vacancy, and delegates complaints/quotes/negations',()=>{
 const out=execFileSync(process.execPath,['-e',String.raw`
 const fs=require('fs'), os=require('os'),path=require('path'),assert=require('assert/strict');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'notify-route-'));os.homedir=()=>root;
 process.env.AGENT_DATA_DIR=path.join(root,'data');process.env.AGENT_TOKENS_DIR=path.join(root,'tokens');process.env.AGENT_TOKENS_ROOT=process.env.AGENT_TOKENS_DIR;
 const {runQuickAnswer}=require('./src/runner/intent-engine');const api=require('./src/hh-proactive-search');
 (async()=>{try{
 for(const text of ['/hh_notify_off','[Сообщение 1]\n/hh_notify_off@TestBot','выключи уведомления о новых кандидатах','отключи уведомления холодного поиска']){
 api.saveSchedule('alice',{enabled:true});assert.match(await runQuickAnswer(text,'alice',root),/выключены/);assert.equal(api.loadSchedule('alice').enabled,true);assert.equal(api.loadSchedule('alice').notifications_enabled,undefined);
 }
 for(const text of ['не выключай уведомления о новых кандидатах','как выключить уведомления холодного поиска?','"/hh_notify_off"','/hh_notify_off\nно сначала объясни','Слушай, мне нужно, чтобы уведомления о холодном поиске новых кандидатов можно было выключать. Сейчас это не выключается. Настрой, пожалуйста, чтобы выключалось.']){
 api.saveSchedule('alice',{enabled:true});assert.equal(await runQuickAnswer(text,'alice',root),null,text);assert.equal(api.loadSchedule('alice').enabled,true);
 }
 for(const text of ['/hh_notify_on','включи уведомления о новых кандидатах']){
 api.saveSchedule('alice',{enabled:false,notifications_enabled:false});assert.match(await runQuickAnswer(text,'alice',root),/функция удалена/);assert.equal(api.loadSchedule('alice').enabled,false);assert.equal(api.loadSchedule('alice').notifications_enabled,false);
 }
 // Stopping the schedule goes through the provider (cron jobs, #1489 S7.1) — asserted in
 // tests/hh-cold-search-cron-core.test.js; here only that the quick path owns the command.
 assert.match(await runQuickAnswer('выключи автопоиск','alice',root),/Автопоиск выключен|Не удалось остановить автопоиск/);
 console.log('PASS');}finally{fs.rmSync(root,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
 `],{encoding:'utf8',timeout:20000});expect(out).toContain('PASS');
});
