// Explicit offline probe, not auto-discovered by node --test. No real Registry.
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join,sep,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import * as candidate from '../src/session.mjs';
import {demoState} from '../src/demo.mjs';
import {prepareSubmissionNotice} from '../src/submission-notice.mjs';

const installedRoot=process.env.MANAGER_OPS_INSTALLED_ROOT;
assert.ok(installedRoot,'explicit verified installed runtime root is required');
const installed=await import(pathToFileURL(join(installedRoot,'src/session.mjs')));
const installedNotices=await import(pathToFileURL(join(installedRoot,'src/submission-notice.mjs')));
const root=await realpath(await mkdtemp(join(tmpdir(),'manager-operations-compat-'))),statePath=join(root,'state.json');
const source={kind:'fixture',ref:'offline installed baseline comparison'},at='2026-10-01T00:00:00.000Z';
try {
  const caller={hostId:'fixture',threadId:'manager'},liaison={hostId:'fixture',threadId:'liaison'},worker={hostId:'fixture',threadId:'worker'};
  await installed.start(statePath,{teamId:'offline',name:'Offline',caller,source},at);
  await installed.attach(statePath,{mode:'invite',id:'invite',caller,target:liaison,at,expiresAt:'2026-10-01T00:01:00.000Z',source},0);
  await installed.attach(statePath,{mode:'confirm',id:'confirm',caller:liaison,invitationId:'invite',invitationVersion:1,at,source},1);
  await installed.registerWorker(statePath,{id:'register',caller,memberId:'worker',name:'Worker',binding:worker,at,source},2);
  const rows=[];
  const loaderPath=join(root,'forbid-manager-loader.mjs');
  await writeFile(loaderPath,'export async function resolve(specifier,context,next){const name=specifier.replaceAll("\\\\","/").split("/").at(-1).split("?")[0];if(name.startsWith("manager-operations")||name.startsWith("manager-inbox"))throw Error("Manager module imported on Worker/Liaison path");return next(specifier,context);}');
  for(const [role,identity] of [['Worker',worker],['Liaison',liaison]]) {
    for(const phase of ['onboarding','recovery']) {
      const input={statePath,caller:identity,asOf:at},old=await installed.resume(statePath,identity,at),now=await candidate.resume(statePath,identity,at);
      assert.deepEqual(now,old);
      const callerPath=join(root,'caller.json');await writeFile(callerPath,JSON.stringify(identity));
      const readCli=async runtime=>JSON.parse((await promisify(execFile)(process.execPath,['--no-warnings','--experimental-loader',pathToFileURL(loaderPath).href,join(runtime,'src/cli.mjs'),'resume',statePath,callerPath,at],{encoding:'utf8',windowsHide:true})).stdout);
      const oldCli=await readCli(installedRoot),candidateCli=await readCli(fileURLToPath(new URL('..',import.meta.url)));
      assert.deepEqual(candidateCli,oldCli);
      rows.push({role,phase,inputBytes:Buffer.byteLength(JSON.stringify(input)),installedResponseBytes:Buffer.byteLength(JSON.stringify(old)),candidateResponseBytes:Buffer.byteLength(JSON.stringify(now)),requiredCallsInstalled:1,requiredCallsCandidate:1,equal:true,cliEqual:true,managerModuleImported:false});
    }
  }
  const demo=demoState(),noticeCaller={hostId:'fixture-host',threadId:'fixture-worker-02'};
  const {createState,evolve}=await import('../src/runtime.mjs');
  let submitted=createState({teamId:demo.team.id,name:demo.team.name,source:demo.team.source,members:demo.members},'2026-09-05T00:00:00.000Z');
  for(const event of [{id:'open',type:'openRound',roundId:'round-demo',title:'Fixture'},
    {id:'assign',type:'assign',roundId:'round-demo',taskId:'T-2',title:'Fixture task',workerId:'worker-02',required:true,assignedAt:at},
    {id:'submit',type:'submit',roundId:'round-demo',taskId:'T-2',actor:'worker-02',summary:'原文 fixture only'}])
    submitted=evolve(submitted,{actor:'manager',at,source:demo.team.source,...event},submitted.version);
  const old=installedNotices.prepareSubmissionNotice(submitted,noticeCaller,'T-2'),now=prepareSubmissionNotice(submitted,noticeCaller,'T-2');
  assert.deepEqual(now,old);
  // Exact source equality preserves the old E03 hostRequest recovery comparator.
  const oldSource=await readFile(join(installedRoot,'src/submission-notice.mjs'));
  const currentSource=await readFile(new URL('../src/submission-notice.mjs',import.meta.url));assert.deepEqual(currentSource,oldSource);
  console.log(JSON.stringify({installedRoot:resolve(installedRoot),rows,notificationPromptAndHostRequestEqual:true,oldNoticeSourceBytes:oldSource.length,workerAddedCalls:0,workerAddedFields:0,workerAddedRequiredFiles:0,liaisonAddedCalls:0,nativeDelivery:'not tested; no native sender called'},null,2));
} finally {
  assert.ok(root.startsWith(await realpath(tmpdir())+sep));await rm(root,{recursive:true,force:true,maxRetries:3});
}
