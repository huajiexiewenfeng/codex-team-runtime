// Installation tests build and mutate only isolated fixtures.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,copyFile,cp,realpath,rm} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {buildPackage} from '../scripts/manager-operations-package.mjs';
import {preflight,install,rollback,verifyInstalled} from '../scripts/manager-operations-install.mjs';

const source=fileURLToPath(new URL('..',import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
const execute=promisify(execFile);
const sharedCore=[
  'delivery-state','dispatch-contract','dispatch-objects','dispatch-runtime','notice-json',
  'progress-summary','registry-projection','runtime','store','submission-notice',
  'submission-recovery','worker-evidence','worker-revocation',
];
let suiteRoot,tempRoot,pythonExecutable;
before(async()=>{
  tempRoot=await realpath(tmpdir());
  suiteRoot=await mkdtemp(join(tempRoot,'manager-operations-install-'));
  // Probe the real exporter from this checkout in a temporary Python environment.
  // The bootstrap interpreter is only used for offline venv creation.
  const windows=process.platform==='win32',venv=join(suiteRoot,'python');
  const bootstrap=process.env.MANAGER_OPS_TEST_PYTHON??(windows?'python.exe':'python3');
  const options={windowsHide:true,timeout:30000,encoding:'utf8'};
  await execute(bootstrap,['-I','-B','-m','venv','--without-pip','--copies',venv],options);
  pythonExecutable=join(venv,windows?'Scripts/python.exe':'bin/python');
  const {stdout}=await execute(pythonExecutable,['-I','-B','-X','utf8','-c',"import sysconfig; print(sysconfig.get_path('purelib'))"],options);
  await writeFile(join(stdout.trim(),'manager-operations-test.pth'),
    'import sys; sys.dont_write_bytecode = True\n'+join(source,'python','src')+'\n');
});
after(async()=>{
  if(!suiteRoot)return;
  const target=await realpath(suiteRoot);
  assert.equal(dirname(target),tempRoot);
  assert.match(basename(target),/^manager-operations-install-/);
  await rm(target,{recursive:true,force:true,maxRetries:3});
});
async function fixture(){
  const evidenceRoot=await mkdtemp(join(suiteRoot,'case-'));
  const companion=join(evidenceRoot,'legacy-companion'),skill=join(evidenceRoot,'legacy-skill');
  await mkdir(join(companion,'src'),{recursive:true});
  await mkdir(join(skill,'references'),{recursive:true});
  await Promise.all(sharedCore.map(name=>copyFile(join(source,'src',name+'.mjs'),join(companion,'src',name+'.mjs'))));
  await writeFile(join(companion,'src','cli.mjs'),
    "export async function run(args,output=console.log) {\n  output(args.join(' '));\n}\n");
  await writeFile(join(skill,'references','manager-supervision.md'),'# Manager supervision\n\nUse the legacy review route.\n');
  const pkg=await buildPackage({output:join(evidenceRoot,'package'),evidenceRoot,companion,skill,
    nodeExecutable:process.execPath,pythonExecutable});
  const sandboxRoot=join(evidenceRoot,'sandboxes','install-target');
  await mkdir(sandboxRoot,{recursive:true});
  await cp(companion,join(sandboxRoot,'companion'),{recursive:true});
  await cp(skill,join(sandboxRoot,'manager-session'),{recursive:true});
  return {...pkg,sandboxRoot,receiptDir:join(evidenceRoot,'receipts','install')};
}
const target=(f,scope,path)=>join(f.sandboxRoot,scope==='companion'?'companion':'manager-session',path);
test('isolated old baseline package preflight, apply and rollback preserve unrelated facts',async()=>{
  const f=await fixture();const before=await readFile(target(f,'companion','src/cli.mjs'));
  assert.equal((await preflight(f)).status,'ready');
  assert.equal((await install(f)).status,'installed');assert.equal((await verifyInstalled(f)).status,'installed');
  const facts=target(f,'companion','retained-task-facts.json');await writeFile(facts,'{"task":"new fact"}\n');
  assert.equal((await rollback(f)).status,'rolled-back');
  assert.deepEqual(await readFile(target(f,'companion','src/cli.mjs')),before);
  assert.equal(await readFile(facts,'utf8'),'{"task":"new fact"}\n');
  await assert.rejects(readFile(target(f,'companion','src/manager-operations.mjs')),e=>e.code==='ENOENT');
});
test('pre-install baseline drift and occupied new paths refuse before writes',async()=>{
  for(const path of ['src/cli.mjs','src/manager-operations.mjs']){
    const f=await fixture(),cli=await readFile(target(f,'companion','src/cli.mjs'));
    await writeFile(target(f,'companion',path),'parallel edit');
    await assert.rejects(install(f),/BASELINE_DRIFT/);
    if(path!=='src/cli.mjs')assert.deepEqual(await readFile(target(f,'companion','src/cli.mjs')),cli);
  }
});
test('package hash drift and missing capability fail closed',async()=>{
  const f=await fixture();await assert.rejects(preflight({...f,manifestSha256:'0'.repeat(64)}),/PACKAGE_HASH/);
  const entry=JSON.parse(await readFile(join(f.packageRoot,'manifest.json'))).files.find(x=>x.scope==='companion'&&x.beforeSha256===null);
  const payload=join(f.packageRoot,'payload',entry.scope,entry.path),original=await readFile(payload);
  await writeFile(payload,'corrupt');await assert.rejects(preflight(f),/PAYLOAD_HASH/);await writeFile(payload,original);
  await assert.rejects(preflight({...f,pythonExecutable:process.execPath}),/CAPABILITY/);
});
test('unsafe target overrides and invalid manifest path refuse before mutation',async()=>{
  const f=await fixture();await assert.rejects(preflight({...f,sandboxRoot:resolve('..')}),/TARGET_PATH/);
  const manifest=JSON.parse(await readFile(join(f.packageRoot,'manifest.json')));manifest.files[0].path='../escape.mjs';
  const bytes=Buffer.from(JSON.stringify(manifest));await writeFile(join(f.packageRoot,'manifest.json'),bytes);
  await assert.rejects(preflight({...f,manifestSha256:hash(bytes)}),/MANIFEST_PATH/);
});
test('ordinary write failure compensates all code writes; durable receipt remains',async()=>{
  const f=await fixture(),before=await readFile(target(f,'companion','src/cli.mjs'));
  await assert.rejects(install({...f,fault:phase=>{if(phase==='after-write:2')throw Error('synthetic interruption');}}),/synthetic interruption/);
  assert.deepEqual(await readFile(target(f,'companion','src/cli.mjs')),before);
  assert.equal(JSON.parse(await readFile(join(f.receiptDir,'receipt.json'))).status,'rolled-back');
});
test('rollback preflights every payload path and refuses concurrent changes without partial restore',async()=>{
  const f=await fixture();await install(f);
  const cli=await readFile(target(f,'companion','src/cli.mjs'));
  await writeFile(target(f,'skill','references/manager-supervision.md'),'parallel supervision edit');
  await assert.rejects(rollback(f),/ROLLBACK_DRIFT/);
  assert.deepEqual(await readFile(target(f,'companion','src/cli.mjs')),cli);
  assert.equal(await readFile(target(f,'skill','references/manager-supervision.md'),'utf8'),'parallel supervision edit');
});
test('backup tampering refuses rollback before restoring files',async()=>{
  const f=await fixture();await install(f);const cli=await readFile(target(f,'companion','src/cli.mjs'));
  await writeFile(join(f.receiptDir,'before','companion','src/cli.mjs'),'bad backup');
  await assert.rejects(rollback(f),/BACKUP_HASH/);assert.deepEqual(await readFile(target(f,'companion','src/cli.mjs')),cli);
});
test('concurrent edit after before-write hook is preserved and reports rollback pending',async()=>{
  const f=await fixture(),m=JSON.parse(await readFile(join(f.packageRoot,'manifest.json'))),i=m.files.findIndex(x=>x.scope==='companion'&&x.path==='src/cli.mjs');
  const cli=target(f,'companion','src/cli.mjs'),parallel=Buffer.concat([await readFile(cli),Buffer.from('\n// concurrent editor\n')]);
  await assert.rejects(install({...f,fault:async phase=>{if(phase==='before-write:'+i)await writeFile(cli,parallel);}}),/ROLLBACK_PENDING.*ROLLBACK_DRIFT/);
  assert.deepEqual(await readFile(cli),parallel);
  assert.equal(JSON.parse(await readFile(join(f.receiptDir,'receipt.json'))).status,'rollback-pending');
});
test('dependency payload precedes CLI activation and Skill routing; interrupted activation compensates',async()=>{
  const f=await fixture(),m=JSON.parse(await readFile(join(f.packageRoot,'manifest.json')));
  assert.equal(m.files.at(-2).path,'src/cli.mjs');assert.equal(m.files.at(-1).scope,'skill');
  const cli=await readFile(target(f,'companion','src/cli.mjs'));
  await assert.rejects(install({...f,fault:async phase=>{if(phase==='before-write:'+(m.files.length-2)){
    for(const p of m.files.slice(0,-2))assert.equal(hash(await readFile(target(f,p.scope,p.path))),p.sha256);
    assert.deepEqual(await readFile(target(f,'companion','src/cli.mjs')),cli);throw Error('activation interrupted');
  }}}),/activation interrupted/);
  assert.deepEqual(await readFile(target(f,'companion','src/cli.mjs')),cli);
  for(const p of m.files.slice(0,-2))await assert.rejects(readFile(target(f,p.scope,p.path)),e=>e.code==='ENOENT');
});
test('abrupt real child exit after code write leaves explicit pending lock; recover restores code only',async()=>{
  const f=await fixture(),before=await readFile(target(f,'companion','src/cli.mjs'));
  const moduleUrl=new URL('../scripts/manager-operations-install.mjs',import.meta.url).href;
  const code=`import {install} from ${JSON.stringify(moduleUrl)};await install({...${JSON.stringify(f)},fault:phase=>{if(phase==='after-write:2')process.exit(97);}});`;
  await assert.rejects(promisify(execFile)(process.execPath,['--input-type=module','-e',code],{windowsHide:true}),e=>e.code===97);
  await assert.rejects(preflight(f),/INSTALL_INCOMPLETE_OR_BUSY/);
  assert.equal(JSON.parse(await readFile(join(f.receiptDir,'receipt.json'))).status,'installing');
  const facts=target(f,'companion','retained-inflight-facts.json');await writeFile(facts,'in-flight facts survive interrupted install');
  assert.equal((await rollback({...f,recover:true})).status,'rolled-back');
  assert.deepEqual(await readFile(target(f,'companion','src/cli.mjs')),before);
  assert.equal(await readFile(facts,'utf8'),'in-flight facts survive interrupted install');
  assert.equal((await preflight(f)).status,'ready');
});
