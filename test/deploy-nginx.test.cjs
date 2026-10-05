const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// scripts/deploy-nginx.sh runs on the Linux VMs and uses GNU coreutils (`mv -T`).
// On macOS (BSD mv) it can't run — skip there instead of failing (CI is Linux).
const GNU_MV = /GNU/.test(spawnSync('mv', ['--version'], { encoding: 'utf8' }).stdout || '');
const test = GNU_MV ? require('node:test') : (name, fn) => require('node:test')(name, { skip: 'needs GNU coreutils (mv -T) — Linux only' }, fn);
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nginx-deploy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const d of ['bin', 'nginx/sites-enabled', 'repo/infra/nginx']) fs.mkdirSync(path.join(dir,d),{recursive:true});
  for (const [name,body] of Object.entries({sudo:'exec "$@"',nginx:'echo test >> "$CALLS"; ! grep -q BAD "$NGINX_ROOT"/sites-enabled/* 2>/dev/null',systemctl:'echo "$*" >> "$CALLS"; test "${FAIL_RELOAD:-}" != 1 || test "$1" != reload'})) {
    fs.writeFileSync(path.join(dir,'bin',name),'#!/bin/bash\n'+body+'\n',{mode:0o755});
  }
  const dst=path.join(dir,'nginx/sites-enabled/relay');
  const src=path.join(dir,'repo/infra/nginx/relay.conf');
  fs.writeFileSync(dst,'GOOD old');fs.writeFileSync(src,'GOOD new');
  fs.writeFileSync(path.join(dir,'nginx/sites-enabled/agent-trainedassist-store'),'GOOD stable old');
  fs.writeFileSync(path.join(dir,'repo/infra/nginx/agent-trainedassist-store.conf'),'GOOD stable new');
  return {dir,dst,src,run:(extra={})=>spawnSync('bash',[path.resolve(__dirname,'../scripts/deploy-nginx.sh')],{env:{...process.env,PATH:path.join(dir,'bin')+':'+process.env.PATH,NGINX_ROOT:path.join(dir,'nginx'),REPO_DIR:path.join(dir,'repo'),CALLS:path.join(dir,'calls'),DEPLOY_ENV:'gcp',...extra},encoding:'utf8'})};
}
test('RU never installs GCP relay but always validates',t=>{const f=fixture(t);assert.equal(f.run({DEPLOY_ENV:'ru'}).status,0);assert.equal(fs.readFileSync(f.dst,'utf8'),'GOOD old');assert.match(fs.readFileSync(path.join(f.dir,'calls'),'utf8'),/test/);});
test('unknown environment fails before mutation',t=>{const f=fixture(t);assert.equal(f.run({DEPLOY_ENV:'wat'}).status,1);assert.equal(fs.readFileSync(f.dst,'utf8'),'GOOD old');});
test('invalid GCP candidate restores previous config and fails',t=>{const f=fixture(t);fs.writeFileSync(f.src,'BAD');assert.equal(f.run().status,1);assert.equal(fs.readFileSync(f.dst,'utf8'),'GOOD old');});
test('invalid candidate with no previous file is removed',t=>{const f=fixture(t);fs.unlinkSync(f.dst);fs.writeFileSync(f.src,'BAD');assert.equal(f.run().status,1);assert.equal(fs.existsSync(f.dst),false);});
test('unchanged bad config fails rather than silently succeeding',t=>{const f=fixture(t);fs.writeFileSync(f.dst,'BAD');fs.writeFileSync(f.src,'BAD');assert.equal(f.run().status,1);});
test('reload failure restores symlink without modifying target',t=>{const f=fixture(t);const target=path.join(f.dir,'original');fs.renameSync(f.dst,target);fs.symlinkSync(target,f.dst);assert.equal(f.run({FAIL_RELOAD:'1'}).status,1);assert.equal(fs.readlinkSync(f.dst),target);assert.equal(fs.readFileSync(target,'utf8'),'GOOD old');});
test('valid GCP config installs and reloads',t=>{const f=fixture(t);assert.equal(f.run().status,0);assert.equal(fs.readFileSync(f.dst,'utf8'),'GOOD new');});

test('GCP installs the stable hostname as well as relay',t=>{const f=fixture(t);assert.equal(f.run().status,0);assert.equal(fs.readFileSync(path.join(f.dir,'nginx/sites-enabled/agent-trainedassist-store'),'utf8'),'GOOD stable new');});
test('invalid stable candidate restores both sites',t=>{const f=fixture(t);fs.writeFileSync(path.join(f.dir,'repo/infra/nginx/agent-trainedassist-store.conf'),'BAD');assert.equal(f.run().status,1);assert.equal(fs.readFileSync(f.dst,'utf8'),'GOOD old');assert.equal(fs.readFileSync(path.join(f.dir,'nginx/sites-enabled/agent-trainedassist-store'),'utf8'),'GOOD stable old');});
test('RU does not install stable GCP hostname',t=>{const f=fixture(t);assert.equal(f.run({DEPLOY_ENV:'ru'}).status,0);assert.equal(fs.readFileSync(path.join(f.dir,'nginx/sites-enabled/agent-trainedassist-store'),'utf8'),'GOOD stable old');});
test('reload failure restores both hostname configurations',t=>{const f=fixture(t);assert.equal(f.run({FAIL_RELOAD:'1'}).status,1);assert.equal(fs.readFileSync(f.dst,'utf8'),'GOOD old');assert.equal(fs.readFileSync(path.join(f.dir,'nginx/sites-enabled/agent-trainedassist-store'),'utf8'),'GOOD stable old');});

test('both public agent routes retain the 20 MiB upload limit',()=>{
  for(const name of ['relay','agent-trainedassist-store']) {
   const config=fs.readFileSync(path.resolve(__dirname,`../infra/nginx/${name}.conf`),'utf8');
   const agentLocation=config.match(/location \/agent\/\s*\{([^}]+)\}/);
   assert.ok(agentLocation, name);
   assert.match(agentLocation[1],/client_max_body_size\s+20m\s*;/,name);
  }
});

// ── vm2: the second agent host (issue #2114 P0.1) ─────────────────────────────
function vm2Fixture(t){
  const f=fixture(t);
  fs.writeFileSync(path.join(f.dir,'repo/infra/nginx/agent-vm2.conf'),'GOOD vm2');
  return f;
}
test('vm2 installs its own door site and nothing from GCP',t=>{
  const f=vm2Fixture(t);
  assert.equal(f.run({DEPLOY_ENV:'vm2'}).status,0);
  assert.equal(fs.readFileSync(path.join(f.dir,'nginx/sites-enabled/agent-vm2'),'utf8'),'GOOD vm2');
  assert.equal(fs.readFileSync(f.dst,'utf8'),'GOOD old','vm2 must not install GCP relay');
  assert.equal(fs.readFileSync(path.join(f.dir,'nginx/sites-enabled/agent-trainedassist-store'),'utf8'),'GOOD stable old','vm2 must not install the branded hostname — moving it is the P2 cutover');
});
test('an invalid vm2 site is rolled back and the service keeps its old door',t=>{
  const f=vm2Fixture(t);fs.writeFileSync(path.join(f.dir,'repo/infra/nginx/agent-vm2.conf'),'BAD');
  assert.equal(f.run({DEPLOY_ENV:'vm2'}).status,1);
  assert.equal(fs.existsSync(path.join(f.dir,'nginx/sites-enabled/agent-vm2')),false);
});
test('the vm2 door answers /mcp and /agent/ with the long-tool timeout',()=>{
  const config=fs.readFileSync(path.resolve(__dirname,'../infra/nginx/agent-vm2.conf'),'utf8');
  for(const loc of ['/agent/','= /mcp']) {
    const body=config.match(new RegExp(`location ${loc.replace(/[/=]/g,m=>'\\'+m)}\\s*\\{([^}]+)\\}`))[1];
    assert.match(body,/proxy_read_timeout\s+300s/,`${loc} must outlast a slow tools/call — nginx's 60 s default is how a remote engine gets an empty 504`);
    assert.match(body,/proxy_buffering\s+off/,loc);
  }
  assert.match(config,/location = \/mcp\/token/,'the minting route needs its own block');
  const served=[...new Set([...config.matchAll(/^\s*server_name\s+([^;]+);/gm)].flatMap(m=>m[1].split(/\s+/)))];
  assert.deepEqual(served,['169-58-15-230.sslip.io'],'this site serves only this box\'s own origin — installing the branded hostname here IS the P2 cutover');
});
test('GCP relay keeps long-running agent requests alive through the review progress window',()=>{
 const config=fs.readFileSync(path.resolve(__dirname,'../infra/nginx/relay.conf'),'utf8');
 const agentLocation=config.match(/location \/agent\/\s*\{([^}]+)\}/);
 assert.ok(agentLocation, 'relay /agent/ location');
 assert.match(agentLocation[1],/proxy_read_timeout\s+240s\s*;/);
 assert.match(agentLocation[1],/proxy_send_timeout\s+240s\s*;/);
});

function apex(f) {
 const src=path.join(f.dir,'repo/infra/nginx/recruiter-assistant.conf');
 const dst=path.join(f.dir,'nginx/sites-enabled/recruiter-assistant');
 fs.writeFileSync(src,'GOOD apex');
 return {src,dst};
}
test('RU apex is opt-in until certificate and DNS preparation',t=>{
 const f=fixture(t),a=apex(f);assert.equal(f.run({DEPLOY_ENV:'ru'}).status,0);assert.equal(fs.existsSync(a.dst),false);
});
test('RU installs apex explicitly and maintains it on later deployments',t=>{
 const f=fixture(t),a=apex(f);assert.equal(f.run({DEPLOY_ENV:'ru',DEPLOY_RECRUITER_APEX:'1'}).status,0);
 assert.equal(fs.readFileSync(a.dst,'utf8'),'GOOD apex');fs.writeFileSync(a.src,'GOOD updated');
 assert.equal(f.run({DEPLOY_ENV:'ru'}).status,0);assert.equal(fs.readFileSync(a.dst,'utf8'),'GOOD updated');
 assert.equal(fs.readFileSync(f.dst,'utf8'),'GOOD old');
});
test('invalid RU apex is rolled back without touching platform',t=>{
 const f=fixture(t),a=apex(f);fs.writeFileSync(a.src,'BAD');
 const platform=path.join(f.dir,'nginx/sites-enabled/platform');fs.writeFileSync(platform,'GOOD platform');
 assert.equal(f.run({DEPLOY_ENV:'ru',DEPLOY_RECRUITER_APEX:'1'}).status,1);
 assert.equal(fs.existsSync(a.dst),false);assert.equal(fs.readFileSync(platform,'utf8'),'GOOD platform');
});
test('GCP cannot install the RU apex even when flag is set',t=>{
 const f=fixture(t),a=apex(f);assert.equal(f.run({DEPLOY_RECRUITER_APEX:'1'}).status,0);assert.equal(fs.existsSync(a.dst),false);
});
