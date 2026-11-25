import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,readFile,rm,lstat} from 'node:fs/promises';import {join,dirname} from 'node:path';import {tmpdir} from 'node:os';
import {prepareWatchdogPackage,installWatchdogPackage,rollbackWatchdogPackage} from '../scripts/watchdog-package-install.mjs';
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'wd-install-'));t.after(()=>rm(root,{recursive:true,force:true}));const sourceRoot=join(root,'source'),homeRoot=join(root,'home'),agentSkillRoot=join(root,'agents/skills'),packageRoot=join(root,'package');for(const dir of ['src','test','docs','skills/watchdog','scripts'])await mkdir(join(sourceRoot,dir),{recursive:true});for(const path of [join(homeRoot,'skills/watchdog'),join(agentSkillRoot,'watchdog')]){await mkdir(path,{recursive:true});await writeFile(join(path,'SKILL.md'),'prior skill preserved');}
 await writeFile(join(sourceRoot,'src/cli.mjs'),'export const offline=true;\n');await writeFile(join(sourceRoot,'package.json'),'{"type":"module"}');await writeFile(join(sourceRoot,'test/watchdog-fixture.test.mjs'),"import test from 'node:test';test('offline fixture',()=>{});\n");await writeFile(join(sourceRoot,'docs/watchdog-fixture.md'),'fixture only');await writeFile(join(sourceRoot,'skills/watchdog/SKILL.md'),'---\nname: watchdog\ndescription: Use when testing.\n---\n');await writeFile(join(sourceRoot,'scripts/watchdog-package-install.mjs'),await readFile(new URL('../scripts/watchdog-package-install.mjs',import.meta.url)));const state=join(root,'business-state-sentinel.json');await writeFile(state,'never include or restore business state');return {root,sourceRoot,homeRoot,agentSkillRoot,packageRoot,state};}
test('independent version install verifies payload and offline tests, backs up both Skill entries; rollback does not restore monitoring/data',async t=>{
 const f=await fixture(t),prepared=await prepareWatchdogPackage(f),before=await readFile(f.state);const installed=await installWatchdogPackage(prepared.packageRoot,prepared.manifestSha256);assert.equal(installed.tests.passed,1);assert.equal(installed.serviceStarted,false);assert.equal(installed.teamRegistered,false);assert.deepEqual(await readFile(f.state),before);const undone=await rollbackWatchdogPackage(prepared.packageRoot,prepared.manifestSha256);assert.equal(undone.monitoringRestored,false);assert.equal(undone.newSidecarsRetained,true);for(const path of [join(f.homeRoot,'skills/watchdog/SKILL.md'),join(f.agentSkillRoot,'watchdog/SKILL.md')])assert.equal(await readFile(path,'utf8'),'prior skill preserved');assert.equal((await lstat(prepared.runtimeRoot)).isDirectory(),true);
});
test('parallel Skill drift stops before installing a bundle; pinned manifest is mandatory',async t=>{
 const f=await fixture(t),p=await prepareWatchdogPackage(f);await writeFile(join(f.homeRoot,'skills/watchdog/SKILL.md'),'parallel user edit');await assert.rejects(installWatchdogPackage(p.packageRoot,p.manifestSha256),/drift/);await assert.rejects(lstat(p.runtimeRoot),{code:'ENOENT'});await assert.rejects(installWatchdogPackage(p.packageRoot,'0'.repeat(64)),/manifest/);
});
test('code rollback refuses an owned service lease and never deletes it or kills Node',async t=>{
 const f=await fixture(t),p=await prepareWatchdogPackage(f);await installWatchdogPackage(p.packageRoot,p.manifestSha256);await mkdir(p.controlRoot,{recursive:true});await writeFile(join(p.controlRoot,'service.lock'),'owned-or-unknown service');await assert.rejects(rollbackWatchdogPackage(p.packageRoot,p.manifestSha256),/Stop this background/);assert.equal(await readFile(join(p.controlRoot,'service.lock'),'utf8'),'owned-or-unknown service');
});

test('package includes transitive test helpers but never recursively runs installer tests',async t=>{
 const f=await fixture(t);
 await mkdir(join(f.sourceRoot,'test/helpers'),{recursive:true});
 await writeFile(join(f.sourceRoot,'test/helpers/nested.mjs'),'export const value=42;\n');
 await writeFile(join(f.sourceRoot,'test/manager-operations-helper.mjs'),"export {value} from './helpers/nested.mjs';\n");
 await writeFile(join(f.sourceRoot,'test/watchdog-desktop-execution.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';import {value} from './manager-operations-helper.mjs';test('helper available',()=>assert.equal(value,42));\n");
 await writeFile(join(f.sourceRoot,'test/watchdog-install.test.mjs'),"throw Error('installer suite must not recurse');\n");
 const p=await prepareWatchdogPackage(f),manifest=JSON.parse(await readFile(join(p.packageRoot,'manifest.json'),'utf8'));
 for(const path of ['test/manager-operations-helper.mjs','test/helpers/nested.mjs','test/watchdog-install.test.mjs'])assert.ok(manifest.runtimeFiles.some(f=>f.path===path),path);
 assert.deepEqual(manifest.tests,['test/watchdog-desktop-execution.test.mjs','test/watchdog-fixture.test.mjs']);
 const receipt=await installWatchdogPackage(p.packageRoot,p.manifestSha256);
 assert.equal(receipt.status,'installed-offline-verified');assert.equal(receipt.tests.passed,2);
});

test('login recovery helpers and PowerShell guard test ship in independent runtime',async t=>{
 const f=await fixture(t);
 for(const name of ['watchdog-login-recover.mjs','watchdog-login-transaction-guard.ps1','watchdog-login-task.ps1'])await writeFile(join(f.sourceRoot,'scripts',name),'fixture helper');
 await writeFile(join(f.sourceRoot,'test/watchdog-login-transaction-guard.test.ps1'),'fixture isolated test');
 const p=await prepareWatchdogPackage(f),manifest=JSON.parse(await readFile(join(p.packageRoot,'manifest.json'),'utf8'));
 for(const path of ['scripts/watchdog-login-recover.mjs','scripts/watchdog-login-transaction-guard.ps1','scripts/watchdog-login-task.ps1','test/watchdog-login-transaction-guard.test.ps1'])assert.ok(manifest.runtimeFiles.some(f=>f.path===path),path);
 assert.equal(manifest.autostartIncluded,false);
});
