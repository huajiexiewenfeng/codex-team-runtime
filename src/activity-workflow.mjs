import {spawn} from 'node:child_process';
import {readFile,lstat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {readState,atomicWrite} from './store.mjs';
import {validateObservationContext} from './observation-context.mjs';
import {validateManifest,check,exact,id,time,hash} from './stats-contract.mjs';
import {beginActivity,endActivity} from './stats-activity.mjs';

const REQUEST=['hostId','threadId','taskId','roundId','stepId','evidenceRef'];
const JOURNAL=['schemaVersion','statePath','manifestPath','sourceId','sourceHash','requestHash','commandHash','context','activityReceiptPath','phase','endAt','outcome'];
const pathKey=p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p);
async function readJournal(path){
  try{const info=await lstat(path);check(info.isFile()&&!info.isSymbolicLink()&&info.size<=65536,'activity_step_receipt_invalid');return JSON.parse(await readFile(path,'utf8'));}
  catch(e){if(e.code==='ENOENT')return null;throw e;}
}
async function scope(statePath,manifestPath,sourceId,request,at,read=readState){
  exact(request,REQUEST);for(const k of REQUEST.filter(k=>k!=='evidenceRef'))id(request[k]);
  check(typeof request.evidenceRef==='string'&&request.evidenceRef.length>0&&request.evidenceRef.length<=4000);
  const state=await read(statePath),proof=validateObservationContext(state,request,{scope:'task',team_id:state.team.id,task_id:request.taskId,round_id:request.roundId,step_id:request.stepId},{now:at});
  check(proof.validation.role==='Worker','activity_step_worker_required');
  const manifest=validateManifest(JSON.parse(await readFile(manifestPath,'utf8')),dirname(manifestPath));
  check(manifest.teamId===state.team.id&&(!state.registry||manifest.registryId===state.registry.registryId),'activity_step_team_mismatch');
  const source=manifest.sources.find(s=>s.sourceId===sourceId);check(source?.kind==='activity-jsonl'&&source.mutationPolicy==='append-only','activity_source_not_append');
  check(source.selection.taskId===request.taskId&&source.selection.roundId===request.roundId,'activity_task_scope_mismatch');
  const bindings=source.bindings.filter(b=>b.memberId===proof.validation.memberId&&b.hostId===request.hostId&&b.threadId===request.threadId&&b.role==='Worker'&&b.from<=at&&at<b.to);
  check(bindings.length===1,'activity_binding_mismatch');const b=bindings[0];
  return {manifest,source,task:state.tasks.find(t=>t.id===request.taskId),context:{teamId:manifest.teamId,memberId:b.memberId,hostId:b.hostId,threadId:b.threadId,bindingRevision:b.bindingRevision,roleEpoch:b.roleEpoch,role:b.role,taskId:request.taskId,roundId:request.roundId,stepId:request.stepId,assurance:'worker-declared',evidenceRef:request.evidenceRef}};
}
function validateOutcome(value){exact(value,['exitCode','signal','errorCode']);check(value.exitCode===null||Number.isSafeInteger(value.exitCode),'activity_step_outcome_invalid');for(const k of ['signal','errorCode'])check(value[k]===null||typeof value[k]==='string'&&value[k].length<=128,'activity_step_outcome_invalid');check(value.exitCode!==null||value.signal!==null||value.errorCode!==null,'activity_step_outcome_invalid');}
function execute(command,cwd){return new Promise(resolveResult=>{
  let errorCode=null;const child=spawn(command[0],command.slice(1),{cwd,shell:false,stdio:'inherit',windowsHide:true});
  child.once('error',e=>{errorCode=String(e.code??'SPAWN_ERROR');});
  child.once('close',(exitCode,signal)=>resolveResult({exitCode,signal,errorCode}));
});}
// Short append locks may contend between parallel steps. Retry only idempotent
// producer calls, never the business operation and never delete a stale lock.
async function append(fn){for(let attempt=0;;attempt++){try{return await fn();}catch(e){if(e.code!=='EEXIST'||attempt>=24)throw e;await delay(20);}}}

// A receipt claims one explicit command attempt, not exactly-once business work.
// No wrapper lock spans the command; an exclusive journal claim has one winner.
export async function runActivityStep(statePath,manifestPath,sourceId,request,receiptPath,command,{cwd=process.cwd(),now=()=>new Date().toISOString(),operation=execute,read=readState}={}){
  statePath=resolve(statePath);manifestPath=resolve(manifestPath);receiptPath=resolve(receiptPath);cwd=resolve(cwd);id(sourceId);
  check(Array.isArray(command)&&command.length>0&&command.length<=256&&command.every(x=>typeof x==='string'&&x.length<=8192)&&command[0].length>0,'activity_step_command_invalid');
  const current=await scope(statePath,manifestPath,sourceId,request,now(),read),activityReceiptPath=receiptPath+'.activity.json';
  const forbidden=new Set([statePath,statePath+'.lock',manifestPath,manifestPath+'.lock',...current.manifest.sources.flatMap(s=>[s.path,s.path+'.activity.lock'])].map(pathKey));
  for(const path of [receiptPath,receiptPath+'.lock',activityReceiptPath,activityReceiptPath+'.lock'])check(!forbidden.has(pathKey(path)),'activity_receipt_path_collision');
  const fixed={schemaVersion:'activity-step/v1',statePath,manifestPath,sourceId,sourceHash:hash(current.source),requestHash:hash(request),commandHash:hash({command,cwd}),context:current.context,activityReceiptPath};
  let journal=await readJournal(receiptPath),replayed=journal!==null;
  if(journal){
    exact(journal,JOURNAL);check(hash(Object.fromEntries(Object.keys(fixed).map(k=>[k,journal[k]])))===hash(fixed),'activity_step_scope_changed');
    check(['prepared','running','finishing','finished'].includes(journal.phase),'activity_step_receipt_invalid');
    check(journal.phase==='finishing'||journal.phase==='finished','activity_step_incomplete_use_new_receipt');
    time(journal.endAt);validateOutcome(journal.outcome);
    // Validate both append evidence and scope before completing/replaying.
    await append(()=>beginActivity(manifestPath,sourceId,current.context,activityReceiptPath,{now}));
  }else{
    check(['executing','rework'].includes(current.task.status),'activity_step_task_not_executing');
    // Never adopt an existing low-level receipt into a new workflow attempt.
    check(await readJournal(activityReceiptPath)===null,'activity_step_producer_receipt_exists');
    journal={...fixed,phase:'prepared',endAt:null,outcome:null};
    try{await atomicWrite(receiptPath,JSON.stringify(journal),true);}catch(e){if(e.code==='EEXIST')check(false,'activity_step_already_claimed');throw e;}
    await append(()=>beginActivity(manifestPath,sourceId,current.context,activityReceiptPath,{now}));
    journal.phase='running';await atomicWrite(receiptPath,JSON.stringify(journal));
    try{journal.outcome=await operation(command,cwd);}catch(e){journal.outcome={exitCode:null,signal:null,errorCode:String(e.code??'OPERATION_ERROR').slice(0,128)};}
    journal.endAt=now();time(journal.endAt);validateOutcome(journal.outcome);
    journal.phase='finishing';await atomicWrite(receiptPath,JSON.stringify(journal));
  }
  const ending=await scope(statePath,manifestPath,sourceId,request,now(),read);
  check(journal.phase==='finished'||['executing','rework'].includes(ending.task.status),'activity_step_task_not_executing');
  check(hash(ending.context)===hash(current.context)&&hash(ending.source)===journal.sourceHash,'activity_step_scope_changed');
  await append(()=>endActivity(manifestPath,activityReceiptPath,{now:()=>journal.endAt}));
  // A changed producer end cannot be silently accepted as this command's end.
  const evidence=JSON.parse(await readFile(activityReceiptPath,'utf8'));
  check(evidence.endEvent.at===journal.endAt,'activity_step_end_mismatch');
  journal.phase='finished';await atomicWrite(receiptPath,JSON.stringify(journal));
  return {schemaVersion:1,phase:'finished',receiptPath,eventId:evidence.beginEvent.eventId,stepId:request.stepId,assurance:'worker-declared',replayed,outcome:journal.outcome,endAt:journal.endAt,businessSuccess:journal.outcome.exitCode===0&&journal.outcome.errorCode===null,semantics:'declared command-attempt interval; not pure work time'};
}
