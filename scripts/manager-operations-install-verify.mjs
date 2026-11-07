// Retained rehearsal only; not copied into the product payload.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp,readdir} from 'node:fs/promises';
import {join,resolve,dirname,sep} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {buildPackage,DEFAULTS,ROUTE_ADDITION} from './manager-operations-package.mjs';
import {linkedShellFixture,realPowerShellTool} from '../test/manager-operations-shell-helper.mjs';

const exec=promisify(execFile),source=fileURLToPath(new URL('..',import.meta.url)),evidence=DEFAULTS.evidenceRoot,sha=b=>createHash('sha256').update(b).digest('hex');
const output=async(name,value)=>writeFile(join(evidence,name),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');
const resumeFile=process.argv[2]==='--resume'?process.argv[3]:null,runIdNew=randomUUID();
let report=resumeFile?JSON.parse(await readFile(resolve(resumeFile))):{runId:runIdNew,sandboxRoot:join(evidence,'sandboxes','final-'+runIdNew),runtimeRoot:join(evidence,'sandboxes','final-'+runIdNew,'companion'),receiptDir:join(evidence,'receipts','final-'+runIdNew),startedAt:new Date().toISOString(),realInstallationTouched:false,nativeSender:'fake'};
const {runId,sandboxRoot,runtimeRoot,receiptDir}=report;
async function command(name,args,{env=process.env,cwd=runtimeRoot,exe=DEFAULTS.nodeExecutable}={}){
  try{const r=await exec(exe,args,{cwd,env,windowsHide:true,encoding:'utf8',timeout:600000,maxBuffer:20*1024*1024});await output(name+'.log',r.stdout+r.stderr);return r.stdout;}
  catch(e){await output(name+'.log',(e.stdout??'')+(e.stderr??'')+'\n'+String(e));throw e;}
}
async function treeFiles(root,path=''){const rows=[];for(const d of await readdir(join(root,path),{withFileTypes:true})){const p=join(path,d.name);if(d.isDirectory())rows.push(...await treeFiles(root,p));else rows.push({path:p.replaceAll('\\','/'),sha256:sha(await readFile(join(root,p)))});}return rows.sort((a,b)=>a.path.localeCompare(b.path));}
try{
  if(!resumeFile){await mkdir(sandboxRoot,{recursive:true});
  report.package=await buildPackage({output:process.argv[2]?resolve(process.argv[2]):join(evidence,'package')});await output('package-info.json',report.package);}
  const {packageRoot,manifestSha256}=report.package,m=JSON.parse(await readFile(join(packageRoot,'manifest.json')));
  const common=['--manifest-sha256',manifestSha256,'--sandbox-root',sandboxRoot],installer=join(packageRoot,'install.mjs');
  if(!resumeFile){
  await cp(DEFAULTS.companion,runtimeRoot,{recursive:true});await cp(DEFAULTS.skill,join(sandboxRoot,'manager-session'),{recursive:true});
  console.log('apply package to actual installed-byte copy');
  report.preflight=JSON.parse(await command('copy-preflight',[installer,'preflight',...common]));
  report.install=JSON.parse(await command('copy-install',[installer,'install',...common,'--receipt',receiptDir]));
  report.verify=JSON.parse(await command('copy-installed-verify',[installer,'verify',...common]));
  report.unchangedBaseline=[];
  for(const f of m.baseline){if(m.files.some(p=>p.scope===f.scope&&p.path===f.path))continue;const root=f.scope==='companion'?runtimeRoot:join(sandboxRoot,'manager-session');assert.equal(sha(await readFile(join(root,f.path))),f.sha256);report.unchangedBaseline.push({scope:f.scope,path:f.path,sha256:f.sha256});}
  const originalSkill=await readFile(join(DEFAULTS.skill,'references/manager-supervision.md')),newSkill=await readFile(join(sandboxRoot,'manager-session/references/manager-supervision.md'));
  assert.deepEqual(newSkill,Buffer.concat([originalSkill,Buffer.from(ROUTE_ADDITION)]));
  report.skillOriginalPrefixPreserved={bytes:originalSkill.length,sha256:sha(originalSkill),addedBytes:Buffer.byteLength(ROUTE_ADDITION)};
  // Test facilities are added ONLY AFTER package application and are not payload.
  const testFiles=['manager-operations.test.mjs','manager-operations-helper.mjs','manager-operations-functions-exec.test.mjs','manager-operations-shell-helper.mjs','manager-operations-shell.test.mjs','manager-inbox.test.mjs'];
  for(const file of testFiles)await cp(join(source,'test',file),join(runtimeRoot,'test',file),{errorOnExist:true,force:false});
  await cp(join(source,'scripts/manager-operations-compatibility.mjs'),join(runtimeRoot,'scripts/manager-operations-compatibility.mjs'),{errorOnExist:true,force:false});
  report.testFacilities={files:testFiles,scope:'copy only; not required product dependencies'};
  console.log('run G01-G15 and affected legacy tests against installed copy');
  const tests=['manager-operations.test.mjs','manager-operations-functions-exec.test.mjs','manager-operations-shell.test.mjs','scheduling.test.mjs','submission-notice.test.mjs','manager-inbox.test.mjs','dispatch-runtime.test.mjs','submission-recovery.test.mjs','supervision.test.mjs','supervision-cli.test.mjs'];
  const log=await command('copy-targeted-tests',['--experimental-test-isolation=none','--test',...tests.map(p=>'test/'+p)],{env:{...process.env,MANAGER_OPS_TEST_PYTHON:DEFAULTS.pythonExecutable}});
  report.tests={files:tests,tests:Number(log.match(/^# tests (\d+)/m)?.[1]),passed:Number(log.match(/^# pass (\d+)/m)?.[1]),failed:Number(log.match(/^# fail (\d+)/m)?.[1]),skipped:Number(log.match(/^# skipped (\d+)/m)?.[1])};assert.equal(report.tests.failed,0);assert.equal(report.tests.skipped,0);
  }else{
    assert.equal(report.tests.failed,0);assert.equal(report.tests.skipped,0);
    // Resume only this task-owned copy; preserve the successful test log.
    assert.ok(sandboxRoot.startsWith(join(evidence,'sandboxes')+sep));
    for(const f of m.files)assert.equal(sha(await readFile(join(f.scope==='companion'?runtimeRoot:join(sandboxRoot,'manager-session'),f.path))),f.sha256);
    await cp(join(source,'scripts/manager-operations-compatibility.mjs'),join(runtimeRoot,'scripts/manager-operations-compatibility.mjs'));
    report.resumedFrom=resolve(resumeFile);delete report.error;
  }
  report.compatibility=JSON.parse(await command('copy-worker-compatibility',['scripts/manager-operations-compatibility.mjs'],{env:{...process.env,MANAGER_OPS_INSTALLED_ROOT:DEFAULTS.companion}}));
  const py=await readFile(join(source,'artifacts/manager-operations-20261029/worker-mcp-compare.py'));const pyPath=join(evidence,'copy-worker-mcp-compare.py');await writeFile(pyPath,py);
  report.mcp=JSON.parse(await command('copy-worker-mcp-compatibility',['-I','-B','-X','utf8',pyPath],{exe:DEFAULTS.pythonExecutable,env:{...process.env,MO_PROBE_RUNTIME_ROOT:DEFAULTS.companion,MO_CANDIDATE_RUNTIME_ROOT:runtimeRoot}}));
  console.log('real shell bridge, then code-only rollback retaining business facts');
  const f=await linkedShellFixture({after:()=>{}},{pythonExecutable:DEFAULTS.pythonExecutable,nodeExecutable:DEFAULTS.nodeExecutable,runtimeRoot});report.retainedFixture={root:f.root,statePath:f.statePath,registryPath:f.registryPath,requestFile:f.requestFile};
  const run=runInNewContext(await readFile(join(runtimeRoot,'scripts/manager-operations-functions-exec.js'),'utf8')+'\nrunManagerOperations;',{});let sends=0,commands=0;
  const tools={exec_command:async a=>{commands++;return realPowerShellTool(a.cmd,{workdir:a.workdir});},mcp__codex_app__send_message_to_thread:async r=>{sends++;return {isError:false,structuredContent:{threadId:r.threadId,hostId:r.hostId}};}};
  const params={...f,tools,hostSendAuthorized:true,authorizationRef:'synthetic fake-only rehearsal'};
  const first=await run(params),replay=await run(params);assert.equal(first.status,'recorded');assert.equal(sends,1);assert.notEqual(replay.status,'recorded');
  report.bridge={first,replay,sends,commands,realPowerShell:true,realNode:true,realInstalledPython:true,exporterEnvironmentRemoved:true};
  const runtime=await import(pathToFileURL(join(runtimeRoot,'src/runtime.mjs'))),notices=await import(pathToFileURL(join(runtimeRoot,'src/submission-notice.mjs'))),recovery=await import(pathToFileURL(join(runtimeRoot,'src/submission-recovery.mjs')));
  let state=JSON.parse(await readFile(f.statePath));state=runtime.evolve(state,{id:'trial-submit',type:'submit',actor:'w',at:new Date().toISOString(),source:state.team.source,roundId:'r',taskId:'shell-task',summary:'synthetic submission retained over code rollback'},state.version);await writeFile(f.statePath,JSON.stringify(state)+'\n');
  const caller={hostId:'offline-shell',threadId:'shell-worker'},notice=notices.prepareSubmissionNotice(state,caller,'shell-task').notice;
  const recoverArgs={statePath:f.statePath,caller,notice,expectedVersion:state.version,expectedLedgerVersion:0,baseline:{outcome:'not-attempted',evidence:{kind:'host-result',ref:'synthetic:none',detail:'fake fixture only'}},options:{python:DEFAULTS.pythonExecutable}};
  const tracked=await recovery.trackSubmissionNotice(recoverArgs),claimed=await recovery.claimNoticeDelivery({...recoverArgs,expectedLedgerVersion:tracked.ledgerVersion});assert.equal(claimed.delivery,'unknown');
  const factsBefore=await treeFiles(f.root);await output('facts-before-rollback.json',factsBefore);
  report.rollback=JSON.parse(await command('copy-rollback',[installer,'rollback',...common,'--receipt',receiptDir]));
  const factsAfter=await treeFiles(f.root);assert.deepEqual(factsAfter,factsBefore);report.factsPreserved={files:factsBefore.length,byteHashesUnchanged:true,submissionPreserved:true,unknownNoticeAttemptPreserved:true};
  const callerPath=join(f.root,'worker-caller.json');await writeFile(callerPath,JSON.stringify(caller));
  const env={...process.env,CODEX_TEAM_CONTEXT_PYTHON:DEFAULTS.pythonExecutable};
  const oldResume=JSON.parse(await command('copy-rollback-old-resume',[join(runtimeRoot,'src/cli.mjs'),'resume',f.statePath,callerPath],{env}));
  const oldNotice=JSON.parse(await command('copy-rollback-old-notice',[join(runtimeRoot,'src/cli.mjs'),'submission-notice',f.statePath,callerPath,'shell-task'],{env}));assert.deepEqual(oldNotice.notice,notice);
  const oldRecovery=await import(pathToFileURL(join(DEFAULTS.companion,'src/submission-recovery.mjs')));
  const plan=await oldRecovery.planNoticeDelivery({...recoverArgs,options:{python:DEFAULTS.pythonExecutable}});assert.notEqual(plan.action,'send');
  report.oldEntryAfterRollback={resumeReturned:true,noticeEqual:true,unknownNotificationPlan:plan,hostSendCount:sends};
  report.finishedAt=new Date().toISOString();report.status='passed';await output('copy-verification.json',report);console.log(JSON.stringify({status:report.status,package:report.package,tests:report.tests,fixture:report.retainedFixture,rollback:report.rollback}));
}catch(e){report.status='failed';report.error=e.stack;await output('copy-verification-failed-'+runId+'.json',report);console.error(e);process.exitCode=1;}
