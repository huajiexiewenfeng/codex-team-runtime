// Manager-only transport evidence. Business authority remains E04/managerRequest.
import {access,readFile,realpath} from 'node:fs/promises';
import {resolve,isAbsolute} from 'node:path';
import {atomicWrite,readRawState} from './store.mjs';
import {withFileLocks} from './registry-projection.mjs';
import {validateManagerDispatchInputs,prepareManagerDispatch} from './manager-operations-host.mjs';
import {dispatchRuntime} from './dispatch-runtime.mjs';
import {fingerprint,fail,operationPrefix} from './manager-operations-contract.mjs';

const requireValue=(ok,field,legal)=>{if(!ok)fail('INVALID_REQUEST',field,legal);};
const same=(a,b)=>fingerprint(a)===fingerprint(b);
const maybe=async p=>{try{return JSON.parse(await readFile(p,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const exact=async(p,value)=>{try{await atomicWrite(p,JSON.stringify(value)+'\n',true);}catch(e){if(e.code!=='EEXIST'||!same(await maybe(p),value))throw e;}};
export function buildDispatchInput(task){
 requireValue(task&&Object.keys(task).every(k=>['statePath','operationId','caller','teamId','roundId','workerId','expectedVersion','mode','reason','title','required','brief','admission','baseline','hostEvidencePath'].includes(k)),'task','closed single task decision');
 const {statePath,operationId,caller,teamId,roundId,workerId,expectedVersion,mode,reason,title,required,brief,admission,baseline,hostEvidencePath}=task;
 requireValue(brief&&Object.keys(brief).every(k=>['text','scope','materialRefs','authorizationRef','dependencyRef'].includes(k)),'task.brief','material and existing scope/authorization facts only');
 const taskId='task-'+fingerprint([teamId,operationId,'new-task']).slice(0,48);
 return validateEntryInput({statePath,hostEvidencePath,
  enqueueInput:{schemaVersion:1,action:'enqueue',operationId,caller,teamId,roundId,taskId,workerId,expectedVersion,mode,reason,title,required},
  brief:{schemaVersion:1,teamId,roundId,taskId,actor:caller,...brief},
  prepareInput:{operation_id:'prepare-'+fingerprint([teamId,operationId]),reason,admission,baseline}});
}
export function validateEntryInput(input){
 requireValue(input&&Object.keys(input).length===5&&['statePath','enqueueInput','brief','prepareInput','hostEvidencePath'].every(k=>Object.hasOwn(input,k)),'input','closed dispatch input');
 requireValue(typeof input.statePath==='string'&&typeof input.hostEvidencePath==='string'&&isAbsolute(input.statePath)&&isAbsolute(input.hostEvidencePath),'paths','absolute trusted state and new evidence path');
 validateManagerDispatchInputs(input);
 requireValue(!input.prepareInput.retry_of_attempt_id,'retry_of_attempt_id','this entry supports independent new tasks only');
 requireValue(!input.brief.enqueueEventId,'brief','new task material only');
 return input;
}
export async function dispatchEntryStage(action,requestFile,payload,options={}){
 requireValue(isAbsolute(requestFile),'requestFile','absolute task evidence path');
 // Lock is scoped to transport material; nested business calls take ORIGINAL
 // Registry/state locks. A stale lock is never automatically deleted.
 return withFileLocks([requestFile+'.entry.lock'],async()=>{
  let input=await maybe(requestFile);
  if(action==='save'){
   requireValue(!payload.task||!payload.input,'save','one task decision or advanced closed input');
   const next=payload.task?buildDispatchInput(payload.task):validateEntryInput(payload.input);
   const paths=[requestFile,next.statePath,next.hostEvidencePath,requestFile+'.prepared.json'].map(p=>resolve(p));
   requireValue(new Set(paths.map(p=>process.platform==='win32'?p.toLowerCase():p)).size===paths.length,'paths','distinct request, state, result and transport evidence paths');
   // Resolve state before saving, so alternate state aliases do not silently
   // change the original evidence binding. Existing business guards own identity.
   requireValue(await realpath(next.statePath)===next.statePath||resolve(await realpath(next.statePath))===resolve(next.statePath),'statePath','canonical state path');
   if(input&&!same(input,next)){
    if(payload.repairFingerprint!==fingerprint(input))fail('OPERATION_CONFLICT','input','exact original input; explicit repairFingerprint for a failed pre-prepare field correction');
    const a=input.enqueueInput,b=next.enqueueInput;
    requireValue(['operationId','caller','teamId','roundId','taskId','workerId'].every(k=>same(a[k],b[k]))&&
      input.statePath===next.statePath&&input.hostEvidencePath===next.hostEvidencePath&&input.prepareInput.operation_id===next.prepareInput.operation_id,'repair','same operation/task/target/path IDs');
    const s=await readRawState(input.statePath);
    requireValue(!await maybe(requestFile+'.prepared.json')&&!s.events.some(e=>e.taskId===a.taskId&&e.type==='startTask'),'repair','no prepared/started attempt');
    const enqueued=s.events.some(e=>e.id.startsWith(operationPrefix(a)));
    if(enqueued)requireValue(same(a,b)&&same(input.brief,next.brief),'repair','committed enqueue and brief immutable; only admission fields may be repaired');
    await atomicWrite(requestFile,JSON.stringify(next)+'\n');
   }else if(!input)await exact(requestFile,next);
   return {status:'saved',inputFingerprint:fingerprint(next),sendNow:false};
  }
  if(!input)fail('INVALID_REQUEST','requestFile','saved task material');
  validateEntryInput(input);
  const e=input.enqueueInput,p=input.prepareInput,common={actor_host_id:e.caller.hostId,actor_thread_id:e.caller.threadId,team_id:e.teamId,round_id:e.roundId,task_id:e.taskId,worker_id:e.workerId,reason:p.reason};
  const call=async request=>{const s=await readRawState(input.statePath);return dispatchRuntime({statePath:input.statePath,registryPath:s.registry?.registryPath,request,options});};
  const claimPath=async attemptId=>(await realpath(input.statePath))+'.dispatch-send-'+fingerprint(attemptId)+'.json';
  const claim=async prepared=>{
   const observed=await status();
   requireValue(prepared&&prepared.inputFingerprint===fingerprint(input)&&prepared.resultRequestBase.attempt_id===observed.attemptId,'claim','exact persisted prepare');
   requireValue(observed.businessStatus==='executing'&&observed.delivery==='unknown','claim','current unresolved original attempt');
   let executionBoundary=null;
   try {
    const canonical=await realpath(input.statePath);
    await access(canonical+'.watchdog-execution-logs.json');
    const {captureDispatchExecutionBoundary}=await import('./watchdog-dispatch-execution.mjs');
    let timer;
    try {
     const capture=readRawState(canonical).then(state=>captureDispatchExecutionBoundary(canonical,state,prepared));
     executionBoundary=await Promise.race([capture,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),750);})]);
    } finally { clearTimeout(timer); }
   } catch {} // Optional monitoring must not prevent dispatch.
   try{await atomicWrite(await claimPath(observed.attemptId),JSON.stringify({attemptId:observed.attemptId,inputFingerprint:fingerprint(input),...(executionBoundary?{executionBoundary}:{})})+'\n',true);}
   catch(err){if(err.code==='EEXIST')return {status:'reconcile',reasonCode:'SEND_ALREADY_CLAIMED',sendNow:false};throw err;}
   return {status:'claimed',sendNow:true,attemptId:observed.attemptId};
  };
  const status=()=>call({...common,action:'status',operation_id:p.operation_id});
  if(action==='entry_prepare'){
   const cached=await maybe(requestFile+'.prepared.json');
   if(cached)return {status:'reconcile',reasonCode:'PREPARE_ALREADY_RECORDED',sendNow:false,attemptId:cached.resultRequestBase.attempt_id,inputFingerprint:fingerprint(input),nextAction:'recover exact evidence; no resend'};
   const result={...await prepareManagerDispatch({...input,options}),inputFingerprint:fingerprint(input)};
   if(result.sendNow!==true)return result;
   await exact(requestFile+'.prepared.json',result);
   await options.entryFault?.('after-prepare');
   // Same bridge invocation consumes the unique attempt grant. Lost stdout
   // after this point is unknown, never permission to execute a second call.
   const claimed=await claim(result);
   await options.entryFault?.('after-claim');
   return claimed.sendNow===true?{...result,sendClaimed:true}:claimed;
  }
  const observed=await status();
  if(action==='entry_status')return {...observed,transport:{prepared:!!await maybe(requestFile+'.prepared.json'),sendClaimed:observed.attemptId?!!await maybe(await claimPath(observed.attemptId)):false,rawResultSaved:!!await maybe(input.hostEvidencePath)}};
  if(observed.status==='error'||!observed.recorded)return {...observed,sendNow:false};
  if(!['entry_result','recover'].includes(action))fail('INVALID_REQUEST','action','save/entry_prepare/entry_result/recover/entry_status');
  let evidence;
  if(action==='entry_result'){
   requireValue(Object.keys(payload).every(k=>['attemptId','inputFingerprint','raw'].includes(k))&&payload.attemptId===observed.attemptId&&payload.inputFingerprint===fingerprint(input),'result','exact original attempt/input plus actual raw result');
   const claim=await maybe(await claimPath(observed.attemptId));
   requireValue(claim?.attemptId===observed.attemptId&&claim.inputFingerprint===fingerprint(input),'result','existing send claim');
   evidence={...payload,outcome:assessNativeDispatchResult(payload.raw,{hostId:p.admission.native.host_id,threadId:p.admission.native.thread_id})};
   await exact(input.hostEvidencePath,evidence);
   await options.entryFault?.('after-native-evidence');
  }else{
   evidence=await maybe(input.hostEvidencePath);
   if(!evidence){
    const claimed=!!await maybe(await claimPath(observed.attemptId));
    return {status:'reconcile',reasonCode:claimed?'NATIVE_RESULT_UNKNOWN':'PREPARED_UNCLAIMED',attemptId:observed.attemptId,sendNow:false,
     nextAction:claimed?'inspect original native call/receipt; never resend or invent a result':'prepared without send claim; E04 replay grants no send permission; reconcile exact attempt, no automatic first send'};
   }
   requireValue(evidence.attemptId===observed.attemptId&&evidence.inputFingerprint===fingerprint(input),'evidence','exact original evidence');
   requireValue(evidence.outcome===assessNativeDispatchResult(evidence.raw,{hostId:p.admission.native.host_id,threadId:p.admission.native.thread_id}),'evidence','outcome derived from retained native output');
  }
  return call({...common,action:'result',operation_id:'mr-'+fingerprint([p.operation_id,'result']),attempt_id:evidence.attemptId,result:{outcome:evidence.outcome,evidence_ref:input.hostEvidencePath,summary:'Original native tool output retained; transport outcome only'}});
 });
}
export function assessNativeDispatchResult(raw,target){
 let value=raw?.structuredContent;
 if(!value&&Array.isArray(raw?.content)){
  const texts=raw.content.filter(c=>c.type==='text');
  if(texts.length===1){try{value=JSON.parse(texts[0].text);}catch{}}
 }
 if(raw?.isError===true&&['POLICY_DENIED','policy-denied'].includes(value?.code??value?.reasonCode))return 'denied';
 const exact=value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>['threadId','hostId'].includes(k))&&value.threadId===target.threadId&&(!('hostId'in value)||value.hostId===target.hostId);
 return raw?.isError===false&&exact?'accepted':'unknown';
}
