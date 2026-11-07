// Manager-only library template. Never invoked by Worker startup or CLI imports.
import {freezeDispatchBrief,dispatchRuntime} from './dispatch-runtime.mjs';
import {validateDispatchRequest,validateBrief} from './dispatch-contract.mjs';
import {readRawState} from './store.mjs';
import {managerRequest} from './manager-operations.mjs';
import {validateManagerRequest,fingerprint,fail} from './manager-operations-contract.mjs';
import {inboxRuntime} from './manager-inbox.mjs';

const requireScope=(ok,field)=>{if(!ok)fail('IDENTITY_CONFLICT',field,'exact frozen Manager/task scope');};
const error=(e,stages)=>({status:'error',reasonCode:e.code??'HOST_FLOW_ERROR',field:e.field??'host',
  message:String(e.message).slice(0,300),stages,sendNow:false,nextAction:'inspect completed stages and exact operation status; never resend automatically'});

export async function prepareManagerDispatch({statePath,enqueueInput,brief,prepareInput,options={}}) {
  const stages={};
  try {
    if(!enqueueInput||Object.hasOwn(enqueueInput,'briefRef')||!prepareInput||
      Object.keys(prepareInput).some(k=>!['operation_id','reason','admission','baseline','retry_of_attempt_id'].includes(k)))
      fail('INVALID_REQUEST','inputs','enqueueInput omits briefRef; prepareInput contains only operation_id/reason/admission/baseline/retry_of_attempt_id');
    let enqueueRequest={...enqueueInput,briefRef:'e04-brief:sha256:'+'0'.repeat(64)};
    let prepareRequest={...prepareInput,action:'prepare',actor_host_id:enqueueRequest.caller?.hostId,actor_thread_id:enqueueRequest.caller?.threadId,
      team_id:enqueueRequest.teamId,round_id:enqueueRequest.roundId,task_id:enqueueRequest.taskId,worker_id:enqueueRequest.workerId,
      brief_ref:enqueueRequest.briefRef,enqueue_event_id:'pending'};
    validateBrief(brief);validateManagerRequest(enqueueRequest);validateDispatchRequest(prepareRequest);
    requireScope(enqueueRequest.action==='enqueue'&&prepareRequest.action==='prepare','action');
    for(const [a,b] of [['teamId','team_id'],['roundId','round_id'],['taskId','task_id'],['workerId','worker_id']])
      requireScope(enqueueRequest[a]===prepareRequest[b],b);
    requireScope(brief.teamId===enqueueRequest.teamId&&brief.roundId===enqueueRequest.roundId&&brief.taskId===enqueueRequest.taskId&&
      fingerprint(brief.actor)===fingerprint(enqueueRequest.caller)&&prepareRequest.actor_host_id===enqueueRequest.caller.hostId&&
      prepareRequest.actor_thread_id===enqueueRequest.caller.threadId,'caller');
    stages.frozen=await freezeDispatchBrief(statePath,brief,options);
    enqueueRequest={...enqueueRequest,briefRef:stages.frozen.briefRef};
    prepareRequest={...prepareRequest,brief_ref:stages.frozen.briefRef};
    stages.enqueue=await managerRequest({statePath,request:enqueueRequest,options});
    if(stages.enqueue.status!=='recorded')return {status:'stopped',stages,sendNow:false};
    prepareRequest={...prepareRequest,enqueue_event_id:stages.enqueue.eventId};
    const s=await readRawState(statePath),call=request=>dispatchRuntime({statePath,registryPath:s.registry?.registryPath,request,options});
    const prepared=await call(prepareRequest);
    stages.prepare={...prepared};delete stages.prepare.hostRequest;
    if(prepared.sendNow!==true)return {status:'stopped',stages,sendNow:false};
    const {admission,baseline,brief_ref,enqueue_event_id,retry_of_attempt_id,...common}=prepareRequest;
    return {status:'prepared',stages,sendNow:true,hostRequest:prepared.hostRequest,
      resultRequestBase:{...common,action:'result',operation_id:'mr-'+fingerprint([prepareRequest.operation_id,'result']),attempt_id:prepared.attemptId}};
  } catch(e) {return error(e,stages);}
}

export async function dispatchManagerOperation(args) {
  const {statePath,host,options={}}=args;
  let stages={};
  try {
    if(typeof host?.authorize!=='function'||typeof host?.send!=='function'||typeof host?.result!=='function')
      fail('CAPABILITY_UNKNOWN','host','trusted authorization/send/result adapter required');
    if(await host.authorize(args)!==true)fail('AUTHORIZATION_REQUIRED','host.authorize','existing explicit user authorization');
    const prepared=await prepareManagerDispatch(args);stages=prepared.stages;
    if(prepared.sendNow!==true)return prepared;
    let outcome;
    try {
      const raw=await host.send(prepared.hostRequest);
      outcome=await host.result(raw,prepared.resultRequestBase.attempt_id);
    } catch(e) {
      // A thrown/lost host result is unknown. Require the host to provide real
      // failure evidence; without it leave the persisted attempt unresolved.
      stages.host={outcome:'unknown',attemptId:prepared.resultRequestBase.attempt_id};
      return error(e,stages);
    }
    stages.host={outcome:outcome?.outcome??'unknown',attemptId:prepared.resultRequestBase.attempt_id};
    const s=await readRawState(statePath);
    stages.result=await dispatchRuntime({statePath,registryPath:s.registry?.registryPath,request:{...prepared.resultRequestBase,result:outcome},options});
    return {status:stages.result.status==='error'?'reconcile':'recorded',stages,sendNow:false};
  } catch(e) {return error(e,stages);}
}

// Call only AFTER independent inspection and the Manager's explicit decision.
// There is deliberately no receive→approve convenience flow.
export async function recordManagerDecision({statePath,request,resolveRequest,options={}}) {
  const stages={decision:await managerRequest({statePath,request,options})};
  if(stages.decision.status!=='recorded'||request.mode!=='queue_first')return {status:stages.decision.status,stages};
  if(!resolveRequest)return {status:'resolve-pending',stages,nextAction:'supply current E05 owner/control/work revisions; do not repeat decision'};
  try {
    requireScope(resolveRequest.action==='resolve'&&resolveRequest.disposition==='settle'&&
      resolveRequest.team_id===request.teamId&&resolveRequest.actor_host_id===request.caller.hostId&&
      resolveRequest.actor_thread_id===request.caller.threadId&&resolveRequest.run_id===request.claim.runId&&
      resolveRequest.generation===request.claim.generation&&resolveRequest.item_id===request.claim.itemId&&
      resolveRequest.claim_id===request.claim.claimId,'resolveRequest');
    // The event is the ACTUAL result, never an invented approval ID.
    const state=await readRawState(statePath);
    stages.resolve=await inboxRuntime({statePath,registryPath:state.registry.registryPath,
      request:{...resolveRequest,decision_event_id:stages.decision.eventId},options});
    return {status:stages.resolve.status==='error'?'resolve-pending':'recorded',stages};
  } catch(e) {return error(e,stages);}
}
