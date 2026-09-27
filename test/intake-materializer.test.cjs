const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { materializeFileRefs, buildFileNote } = require('../src/intake-materializer');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'shared-media-'));
  const workDir = path.join(root,'alice');
  fs.mkdirSync(workDir,{recursive:true});
  return { root, workDir };
}

test('shared materializer copies local refs, fsyncs, and creates the canonical note', async t => {
  const f=fixture();t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
  const id='a'.repeat(64),store=path.join(f.workDir,'media','intake-store',id);
  fs.mkdirSync(store,{recursive:true});
  fs.writeFileSync(path.join(store,'data'),'bytes');
  fs.writeFileSync(path.join(store,'meta.json'),JSON.stringify({name:'CV.pdf',mime:'application/pdf'}));
  const out=await materializeFileRefs({workDir:f.workDir,username:'alice',fileRefs:[{id}],task:'analyse',engine:'claude'});
  assert.match(out.task,/Файл сохранён:/);assert.match(out.task,/analyse/);
  assert.equal(out.fileRefs[0].name,'CV.pdf');assert.equal(out.fileRefs[0].mime,'application/pdf');
  assert.equal(fs.readFileSync(path.join(f.workDir,'media','intake',id+'-CV.pdf'),'utf8'),'bytes');
});

test('shared image note performs OCR only for opencode', async t => {
  const f=fixture();t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
  const file=path.join(f.workDir,'x.png');fs.writeFileSync(file,'img');
  let calls=0;
  const vision={extractImageText:async()=>{calls++;return{ok:true,text:'TEXT FROM IMAGE'}}};
  const opencode=await buildFileNote({filePath:file,mimeType:'image/png',engine:'opencode',openrouterKey:'k',vision});
  assert.match(opencode,/TEXT FROM IMAGE/);assert.equal(calls,1);
  const claude=await buildFileNote({filePath:file,mimeType:'image/png',engine:'claude',openrouterKey:'k',vision});
  assert.doesNotMatch(claude,/TEXT FROM IMAGE/);assert.equal(calls,1);
});

test('a ref marked note:false is materialized without a file note', async t => {
  const f=fixture();t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
  const id='c'.repeat(64),store=path.join(f.workDir,'media','intake-store',id);
  fs.mkdirSync(store,{recursive:true});
  fs.writeFileSync(path.join(store,'data'),'voice');
  fs.writeFileSync(path.join(store,'meta.json'),JSON.stringify({name:'voice.ogg',mime:'audio/ogg'}));
  const out=await materializeFileRefs({workDir:f.workDir,username:'alice',fileRefs:[{id,note:false}],task:'transcribe',engine:'claude'});
  assert.equal(out.task,'transcribe');
  assert.equal(fs.readFileSync(path.join(f.workDir,'media','intake',id+'-voice.ogg'),'utf8'),'voice');
});

test('web and /run source both delegate fileRefs to intake-materializer', () => {
  const web=fs.readFileSync(path.join(__dirname,'../src/web-routes.js'),'utf8');
  const server=fs.readFileSync(path.join(__dirname,'../src/server.js'),'utf8');
  assert.match(web,/intake-materializer/);
  assert.match(server,/materializeFileRefs\(\{/);
  assert.doesNotMatch(web,/copyFileSync\(src, filePath\)/,'web must not keep a parallel copy pipeline');
});
