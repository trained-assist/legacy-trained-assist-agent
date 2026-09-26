// Epic #1470 P1.1 — ratchet guard: HH domain code lives in trained-assist-hh-skill
// (source of truth). The legacy core copies (src/**/hh-*.js) and the core files
// that import them are frozen in test/fixtures/hh-core-baseline.json and may only
// shrink: no NEW hh-*.js in core, no NEW core importer, no NEW module per importer.
// Deleting a copy or an import? remove it from the fixture in the same PR (the
// "tight" test fails otherwise), so the baseline always equals what is left.
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs');const path=require('path');
const ROOT=path.join(__dirname,'..');
const BASE=require('./fixtures/hh-core-baseline.json');
const REQ=/require\(\s*['"]([^'"]+)['"]\s*\)/g;
const isHh=f=>/^hh-/.test(path.basename(f));

function walk(d,o=[]){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);
 if(e.isDirectory()){if(e.name!=='node_modules')walk(p,o);}else if(/\.(c|m)?js$/.test(e.name))o.push(p);}return o;}
function scan(root=ROOT){const files=[],edges={};
 for(const abs of walk(path.join(root,'src'))){const f=path.relative(root,abs).split(path.sep).join('/');
  if(isHh(f)){files.push(f);continue;}
  const mods=new Set();for(const m of fs.readFileSync(abs,'utf8').matchAll(REQ)){
   const name=path.basename(m[1]).replace(/\.(c|m)?js$/,'');if(m[1].startsWith('.')&&isHh(name))mods.add(name);}
  if(mods.size)edges[f]=[...mods].sort();}
 return {files:files.sort(),edges};}

test('no new hh-*.js in core and no new core imports of hh-* modules',()=>{
 const now=scan();const grown=[];
 for(const f of now.files)if(!BASE.files.includes(f))grown.push(`new HH file in core: ${f}`);
 for(const[f,mods]of Object.entries(now.edges))for(const m of mods)
  if(!BASE.edges[f]?.modules.includes(m))grown.push(`new import: ${f} → ${m}`);
 assert.deepEqual(grown,[],'HH logic belongs in trained-assist-hh-skill; core reaches it via the provider (MCP tools / action manifest), not require (epic #1470).');
});
test('baseline is tight: deleted files/imports must be removed from the fixture',()=>{
 const now=scan();const stale=[];
 for(const f of BASE.files)if(!now.files.includes(f))stale.push(`file gone: ${f}`);
 for(const[f,e]of Object.entries(BASE.edges))for(const m of e.modules)
  if(!now.edges[f]?.includes(m))stale.push(`import gone: ${f} → ${m}`);
 assert.deepEqual(stale,[],'Remove these entries from test/fixtures/hh-core-baseline.json');
});
test('every legacy importer names the epic step that removes it',()=>{
 for(const[f,e]of Object.entries(BASE.edges))assert.match(e.removeIn,/^P1\.[34]-[a-z-]+$/,f);
});
test('scanner catches a planted violation (self-check)',()=>{
 const tmp=fs.mkdtempSync(path.join(require('os').tmpdir(),'hh-ratchet-'));
 fs.mkdirSync(path.join(tmp,'src/x'),{recursive:true});
 fs.writeFileSync(path.join(tmp,'src/hh-new.js'),'');
 fs.writeFileSync(path.join(tmp,'src/x/a.js'),"const q=require('../hh-quick');const n=require('node:fs');");
 try{assert.deepEqual(scan(tmp),{files:['src/hh-new.js'],edges:{'src/x/a.js':['hh-quick']}});}
 finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
