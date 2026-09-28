const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const notifyProfile=require('../src/notify-profile');

const secrets={BOT_TOKEN:'classic',RECRUITER_BOT_TOKEN:'recruiter',FREELANCE_BOT_TOKEN:'freelance'};

function mkProfile(t,{sessions=null,full=null}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'notify-profile-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'sessions'));
  if(sessions)fs.writeFileSync(path.join(root,'sessions.json'),JSON.stringify(sessions));
  if(full)for(const[id,rec]of Object.entries(full))fs.writeFileSync(path.join(root,'sessions',`${id}.json`),JSON.stringify(rec));
  return {workDir:()=>root};
}
const readChatIdOf=(chatId)=>()=>chatId;
function recorder(){
  const calls=[];
  const fetchImpl=async(url,opts)=>{calls.push({url,body:JSON.parse(opts.body)});return{ok:true,status:200};};
  return{calls,fetchImpl};
}

// #1754: audience comes from the session whose id embeds .chatid; the token is the
// audience's bot — never another bot's (#1302).
test('routes to the audience bot of the chat that last ran a task',async t=>{
  const p=mkProfile(t,{sessions:[
    {id:'s-777-1',audience:'recruiter',lastAt:2},
    {id:'s-777-2',audience:'recruiter',lastAt:9},
    {id:'s-888-3',audience:'freelance',lastAt:100},
  ],full:{'s-777-2':{messageThreadId:15}}});
  const {calls,fetchImpl}=recorder();
  const res=await notifyProfile('u','▶ запущен',{secrets,readChatId:readChatIdOf('777'),userWorkDir:p.workDir,fetchImpl});
  assert.deepEqual(res,{sent:true,status:200});
  assert.equal(calls.length,1);
  assert.match(calls[0].url,/botrecruiter\/sendMessage/);
  assert.equal(calls[0].body.chat_id,'777');
  assert.equal(calls[0].body.message_thread_id,15);
  assert.equal(calls[0].body.text,'▶ запущен');
});

test('legacy profile without a sessions index falls back to the default bot',async t=>{
  const p=mkProfile(t);
  const {calls,fetchImpl}=recorder();
  const res=await notifyProfile('u','hi',{secrets,readChatId:readChatIdOf('42'),userWorkDir:p.workDir,fetchImpl});
  assert.equal(res.sent,true);
  assert.match(calls[0].url,/botclassic\/sendMessage/);
  assert.equal(calls[0].body.message_thread_id,undefined);
});

test('no .chatid — nothing is sent',async t=>{
  const p=mkProfile(t);
  const {calls,fetchImpl}=recorder();
  const res=await notifyProfile('u','hi',{secrets,readChatId:()=>null,userWorkDir:p.workDir,fetchImpl});
  assert.deepEqual(res,{sent:false,reason:'no_chat_id'});
  assert.equal(calls.length,0);
});

test('an audience without its configured bot never falls back to classic (#1302)',async t=>{
  const p=mkProfile(t,{sessions:[{id:'s-777-1',audience:'recruiter',lastAt:1}]});
  const {calls,fetchImpl}=recorder();
  const res=await notifyProfile('u','hi',{secrets:{BOT_TOKEN:'classic'},readChatId:readChatIdOf('777'),userWorkDir:p.workDir,fetchImpl});
  assert.equal(res.sent,false);
  assert.match(res.reason,/^bot_unavailable:/);
  assert.equal(calls.length,0);
});

test('telegram failure is reported, not thrown',async t=>{
  const p=mkProfile(t);
  const fetchImpl=async()=>({ok:false,status:400});
  const res=await notifyProfile('u','hi',{secrets,readChatId:readChatIdOf('42'),userWorkDir:p.workDir,fetchImpl});
  assert.deepEqual(res,{sent:false,status:400});
});
