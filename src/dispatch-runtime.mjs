import {realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {evolve} from './runtime.mjs';
import {readRawState,readState,atomicWrite} from './store.mjs';
import {withStateGuard} from './registry-projection.mjs';
import {deliveryState} from './delivery-state.mjs';
import {revocationFor,handoffHold} from './worker-revocation.mjs';
import {canonical,hash,demand,bounded,isDispatch,dispatchHold,operationEventId,validateDispatchRequest,validateBrief} from './dispatch-contract.mjs';
import {loadObject,saveObject,validateDispatchObjects} from './dispatch-objects.mjs';

function managerFor(s,caller){
 demand(s.schemaVersion===2&&s.registry.phase==='active','TEAM_NOT_CONNECTED','Active Registry team required');
 const m=s.members.find(m=>m.role==='Manager');
 demand(m?.lifecycle==='active'&&m.binding.status==='bound'&&m.binding.hostId===caller.hostId&&m.binding.threadId===caller.threadId&&!revocationFor(s,m.id),'IDENTITY_CONFLICT','Current Manager required');
 demand(s.registry.readyMemberIds.includes(m.id),'TEAM_NOT_CONNECTED','Manager must be Registry ready');return m;
}
export async function freezeDispatchBrief(statePath,brief,options={}){
 validateBrief(brief);const path=await realpath(statePath);
 return withStateGuard(path,null,readRawState,async s=>{managerFor(s,brief.actor);demand(brief.teamId===s.team.id&&s.rounds.some(r=>r.id===brief.roundId&&r.status==='open'),'IDENTITY_CONFLICT','Brief team/round mismatch');
  const task=s.tasks.find(t=>t.id===brief.taskId);demand(!task||task.status==='queued','TASK_ADVANCED','Started task material is immutable');
  return {briefRef:await saveObject(path,'brief',brief),contentSha256:hash(brief.text),bodyBytes:Buffer.byteLength(brief.text),sourceVersion:s.version,hostActionExecuted:false};},options);
}
function failure(error,mutationUnknown){return {status:'error',reasonCode:error.code==='EEXIST'?'BUSY':error.code??'INVALID_REQUEST',message:String(error.message).slice(0,1000),readOnly:!mutationUnknown,mutationUnknown,sendNow:false,hostActionExecuted:false,nextAction:mutationUnknown?'dispatch_status':'inspect-error'};}

export async function dispatchRuntime({statePath,registryPath,request,runtimeRevision='unversioned',options={}}){
 let mutationUnknown=false;
 try{
  const r=validateDispatchRequest(request),path=await realpath(statePath),caller={hostId:r.actor_host_id,threadId:r.actor_thread_id};
  const deadline=()=>demand(!options.deadline||performance.now()<options.deadline,'BRIDGE_TIMEOUT','Dispatch deadline exceeded');deadline();
  const execute=async s=>{
   deadline();const actor=managerFor(s,caller);
   demand(resolve(s.registry.registryPath)===resolve(registryPath)&&s.team.id===r.team_id,'IDENTITY_CONFLICT','Trusted Registry/team mismatch');
   const task=s.tasks.find(t=>t.id===r.task_id&&t.roundId===r.round_id&&t.workerId===r.worker_id);demand(task,'IDENTITY_CONFLICT','Task scope mismatch');
   const round=s.rounds.find(x=>x.id===task.roundId),worker=round.members.find(m=>m.id===task.workerId);
   const {operations,briefs}=await validateDispatchObjects(path,s),chain=[...operations.values()].filter(o=>o.request.task_id===task.id),prepares=chain.filter(o=>o.request.action==='prepare');
   const initial=s.events.find(e=>e.taskId===task.id&&['assign','startTask'].includes(e.type)),delivery=deliveryState(s,task),hold=dispatchHold(s,task.workerId);
   const base={teamId:s.team.id,roundId:task.roundId,taskId:task.id,workerId:task.workerId,sourceVersion:s.version,currentStateVersion:s.version,runtimeRevision,readOnly:true,hostActionExecuted:false,sendNow:false,identityAssurance:'caller-declared',evidenceAssurance:'caller-assessed'};
   const snapshot=()=>({...base,businessStatus:task.status,delivery:delivery.status,latestAttemptId:delivery.attemptId,correlationVerified:false,initialAttemptPresent:!!initial,retryClaimCount:delivery.attempts,totalAttemptCount:initial?1+delivery.attempts:0,
    allowedNextAction:hold?'reconcile-conflict':task.status==='queued'?'prepare':['approved','cancelled'].includes(task.status)?'inspect-status':task.status!=='executing'||task.observations.length?'supervise':delivery.status==='not-delivered'?'prepare-retry':delivery.status==='policy-denied'?'reconcile-withdrawal':'reconcile-evidence',...(hold?{dispatchHold:hold.id}:{})});
   const receipt=op=>({...base,sourceVersion:op.sourceVersion,runtimeRevision:op.runtimeRevision,operationId:op.request.operation_id,attemptId:op.attemptId,briefRef:op.briefRef,correlationVerified:true,recorded:true,
    status:op.event.type==='dispatchConflict'?'conflict':op.request.action==='prepare'?'prepared':'recorded',reasonCode:op.event.type==='dispatchConflict'?'DELIVERY_CONFLICT':op.request.action==='prepare'?'PREPARED':op.request.action==='cancel'?'CANCELLED_UNDELIVERED':'RESULT_RECORDED'});
   if(r.action==='status'){
    let op=r.operation_id?operations.get(r.operation_id):null;
    if(r.operation_id&&!op)return bounded({...snapshot(),status:'reconcile',reasonCode:'OPERATION_NOT_FOUND',operationCommitted:false,nextAction:'verify-execution-ended'});
    if(op)demand(op.request.task_id===task.id&&op.request.round_id===task.roundId,'INVALID_REQUEST','Operation scope mismatch');
    if(r.attempt_id){const p=prepares.find(o=>o.attemptId===r.attempt_id);demand(p&&(!op||op.attemptId===p.attemptId),'ATTEMPT_NOT_FOUND','Selectors disagree or attempt missing');op??=p;}
    const out={...snapshot(),status:'observed',reasonCode:initial&&!isDispatch(initial)?'LEGACY_ATTEMPT':'STATUS',...(op?receipt(op):{}),evidenceRefs:chain.filter(o=>!op||o.attemptId===op.attemptId).flatMap(o=>o.request.result?[o.request.result.evidence_ref]:[])};
    if(r.include_content){const ref=op?.briefRef??prepares.at(-1)?.briefRef;if(ref)out.brief=briefs.get(ref);}
    return bounded(out);
   }
   const previous=operations.get(r.operation_id);
   if(previous){demand(previous.fingerprint===hash(canonical(r))&&canonical(previous.request)===canonical(r),'OPERATION_CONFLICT','Operation ID reused with different complete input');return bounded({...snapshot(),...receipt(previous),replayed:true});}
   demand(!s.events.some(e=>e.id===operationEventId(s,r.operation_id)),'OPERATION_CONFLICT','Event identity already exists');
   if(initial)demand(isDispatch(initial),'LEGACY_ATTEMPT','Use legacy recovery for legacy attempts');
   const at=options.at??new Date().toISOString();
   const event={id:operationEventId(s,r.operation_id),actor:actor.id,at,roundId:task.roundId,taskId:task.id,caller};
   let briefRef,brief,attemptId,hostRequest;
   const missing=(code,path,description)=>bounded({...base,status:'reconcile',reasonCode:code,requiredInput:[{path,type:'object',description}]});
   if(r.action==='prepare'){
    demand(s.team.source.kind!=='fixture'&&s.events.filter(e=>e.taskId===task.id).every(e=>e.source.kind!=='fixture'),'FIXTURE','Fixture provenance cannot grant a native send');
    if(!r.admission)return missing('NATIVE_CHECK_REQUIRED','admission','native host_id/thread_id/status=idle/evidence_ref; verify no unregistered work');
    if(!initial&&!r.baseline)return {...missing('HISTORY_REQUIRED','baseline','Verified no native send, competing sender or in-flight request'),requiredInput:[{path:'baseline.outcome',type:'string',const:'not-attempted'},{path:'baseline.evidence_ref',type:'string',minLength:1}]};
    const n=r.admission.native;
    demand(n.host_id===worker.binding.hostId&&n.thread_id===worker.binding.threadId,'IDENTITY_CONFLICT','Native evidence target mismatch');
    if(n.observed_at)demand(Date.parse(n.observed_at)<=Date.parse(at),'INVALID_REQUEST','Future source observation');
    briefRef=r.brief_ref;brief=validateBrief(await loadObject(path,briefRef));
    demand(brief.teamId===s.team.id&&brief.roundId===task.roundId&&brief.taskId===task.id,'IDENTITY_CONFLICT','Brief scope mismatch');
    if(!(brief.authorizationRef&&brief.dependencyRef)&&!r.admission.scope_evidence_ref)return missing('SCOPE_REQUIRED','admission.scope_evidence_ref','Verified authorization and prerequisites reference');
    const enqueue=s.events.find(e=>e.id===r.enqueue_event_id&&e.type==='enqueue'&&e.taskId===task.id&&e.roundId===task.roundId);
    demand(enqueue&&(enqueue.source.ref===briefRef||(brief.enqueueEventId===enqueue.id&&brief.originalSourceRef===enqueue.source.ref)),'BRIEF_MISMATCH','Frozen brief does not match enqueue');
    if(initial){demand(r.retry_of_attempt_id===delivery.attemptId&&delivery.status==='not-delivered',delivery.status==='policy-denied'?'POLICY_DENIED':'DELIVERY_UNKNOWN','Retry requires exact terminal nonreceipt');demand(prepares.at(-1)?.briefRef===briefRef,'BRIEF_MISMATCH','Retry brief cannot change');Object.assign(event,{type:'deliveryClaim',attemptId:delivery.attemptId,summary:'E04 retry after verified terminal nonreceipt'});}
    else{demand(!r.retry_of_attempt_id,'ATTEMPT_NOT_FOUND','No retry attempt');event.type='startTask';}
    attemptId=event.id;
    hostRequest={tool:'mcp__codex_app__send_message_to_thread',arguments:{hostId:worker.binding.hostId,threadId:worker.binding.threadId,prompt:`[codex-team-runtime E04/v1]\nTeam: ${s.team.id}\nRound: ${task.roundId}\nTask: ${task.id}\nAttempt: ${attemptId}\n\n${brief.text}`}};
   }else{
    const prep=prepares.find(o=>o.attemptId===r.attempt_id);demand(prep,'ATTEMPT_NOT_FOUND','Unknown E04 attempt');briefRef=prep.briefRef;brief=briefs.get(briefRef);attemptId=prep.attemptId;event.attemptId=attemptId;
    if(r.action==='cancel'){
     if(!r.cancellation)return missing('CANCELLATION_AUTH_REQUIRED','cancellation','Explicit withdrawal authorization plus all-attempt nonreceipt and no execution/in-flight evidence');
     Object.assign(event,{type:'cancelUndelivered',summary:r.cancellation.reason,cancellation:r.cancellation});
    }else{
     const terminal=chain.filter(o=>o.attemptId===attemptId&&o.event.type==='deliveryCheck').at(-1)?.event.outcome??'unknown';
     const outcome={accepted:'delivered',unknown:'unknown','terminal-not-delivered':'not-delivered',denied:'policy-denied'}[r.result.outcome];
     const contradictory=(terminal!=='unknown'&&outcome!=='unknown'&&terminal!==outcome)||(outcome==='delivered'&&(task.status==='cancelled'||attemptId!==delivery.attemptId));
     if(contradictory)Object.assign(event,{type:'dispatchConflict',summary:r.result.summary});
     else{
      demand(attemptId===delivery.attemptId,'ATTEMPT_MISMATCH','Result is not for current attempt');
      if(terminal!=='unknown')return bounded({...snapshot(),status:'already_recorded',reasonCode:'ATTEMPT_RESOLVED',operationRecorded:false,attemptId});
      Object.assign(event,{type:'deliveryCheck',outcome,summary:r.result.summary});
     }
    }
   }
   // The object embeds the exact persisted audit, without its self-reference.
   const {caller:ignored,...audit}=event;
   if(event.type==='cancelUndelivered')audit.caller=caller;
   const op={schemaVersion:1,wrapperVersion:1,request:r,fingerprint:hash(canonical(r)),event:audit,briefRef,attemptId,sourceVersion:s.version+1,runtimeRevision};
   const ref='e04-op:sha256:'+hash(canonical(op));event.source={kind:'manual',ref};
   const next=evolve(s,event,s.version,{dispatchOperation:true});
   const response=bounded({...receipt(op),currentStateVersion:next.version,readOnly:false,replayed:false,...(r.action==='prepare'?{sendNow:true,hostRequest,bodyBytes:{prepareInput:0,hostRequest:Buffer.byteLength(brief.text),nativeSend:Buffer.byteLength(brief.text)},observationAgeMs:r.admission.native.observed_at?Date.parse(at)-Date.parse(r.admission.native.observed_at):null}:{} )});
   deadline();await (options.saveObject??saveObject)(path,'op',op);await validateDispatchObjects(path,next);deadline();
   mutationUnknown=true;await (options.writeState??atomicWrite)(path,JSON.stringify(next,null,2)+'\n');return response;
  };
  return r.action==='status'?await execute(await readState(path,options)):await withStateGuard(path,null,readRawState,execute,options);
 }catch(error){return failure(error,mutationUnknown);}
}
