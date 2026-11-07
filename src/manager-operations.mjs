import {readFile,lstat,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {isDeepStrictEqual as same} from 'node:util';
import {validateCaller,evolve} from './runtime.mjs';
import {readRawState,atomicWrite} from './store.mjs';
import {withStateGuard} from './registry-projection.mjs';
import {planSubmissionReview,submissionContext} from './submission-notice.mjs';
import {validateInboxLedger,digest,INBOX_LIMITS,parseInboxJson,jsonBoundary} from './manager-inbox-contract.mjs';
import {inboxRuntime} from './manager-inbox.mjs';
import {loadObject} from './dispatch-objects.mjs';
import {validateBrief} from './dispatch-contract.mjs';
import {revocationFor} from './worker-revocation.mjs';
import {fail,validateManagerRequest,operationPrefix,operationEventId,fingerprint} from './manager-operations-contract.mjs';

const key=p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p);
const check=(ok,code,field,legal)=>{if(!ok)fail(code,field,legal);};
async function readLedger(path) {
  try {
    const info=await lstat(path);
    check(info.isFile()&&!info.isSymbolicLink()&&info.size<=INBOX_LIMITS.ledger,'MODE_UNKNOWN','$.mode','inspect trusted inbox storage');
    return validateInboxLedger(JSON.parse(await readFile(path,'utf8')));
  } catch(e) {if(e.code==='ENOENT')return null;throw e;}
}
function scope(s,r,l,path) {
  validateCaller(r.caller);
  check(s.team.id===r.teamId,'IDENTITY_CONFLICT','$.teamId','current trusted team');
  const manager=s.members.find(m=>m.role==='Manager'),round=s.rounds.find(x=>x.id===r.roundId);
  check(manager?.lifecycle==='active'&&manager.binding.status==='bound'&&
    manager.binding.hostId===r.caller.hostId&&manager.binding.threadId===r.caller.threadId&&!revocationFor(s,manager.id),
    'ROLE_DENIED','$.caller','current active bound Manager');
  check(round&&same(round.members.find(m=>m.id===manager.id)?.binding,manager.binding),'IDENTITY_CONFLICT','$.roundId','historical Manager binding');
  const worker=s.members.find(m=>m.id===r.workerId),old=round.members.find(m=>m.id===r.workerId);
  check(worker?.role==='Worker'&&worker.lifecycle==='active'&&worker.binding.status==='bound'&&same(old?.binding,worker.binding)&&!revocationFor(s,worker.id),
    'IDENTITY_CONFLICT','$.workerId','current and historical active Worker');
  if(l)check(s.schemaVersion===2&&l.teamId===s.team.id&&l.registryId===s.registry.registryId&&l.stateBinding===digest(key(path))&&
    l.leader.memberId===manager.id&&l.leader.hostId===r.caller.hostId&&l.leader.threadId===r.caller.threadId,
    'MODE_UNKNOWN','$.mode','matching trusted inbox binding');
  check(r.mode===(l?.mode??'legacy'),'MODE_CONFLICT','$.mode',l?.mode??'legacy');
  if(r.mode==='queue_first')check(s.schemaVersion===2&&!!l,'CAPABILITY_UNKNOWN','$.mode','existing active E05 ledger required');
  const task=s.tasks.find(t=>t.id===r.taskId);
  if(task)check(task.roundId===r.roundId&&task.workerId===r.workerId,'IDENTITY_CONFLICT','$.taskId','exact task/round/Worker');
  if(!['enqueue','status'].includes(r.action))check(task,'TASK_NOT_FOUND','$.taskId','existing task');
  return manager;
}
function claimGate(l,r) {
  const c=r.claim;
  check(l?.mode==='queue_first'&&l.consumer?.runId===c.runId&&l.consumer.generation===c.generation&&l.consumer.claimId===c.claimId,
    'CLAIM_CONFLICT','$.claim','existing owner and active claim');
  const claim=l.claims.find(x=>x.id===c.claimId),item=l.items.find(x=>x.id===c.itemId);
  check(claim?.phase==='active'&&claim.itemId===c.itemId&&claim.runId===c.runId&&claim.generation===c.generation&&item?.kind==='submission'&&item.state==='processing'&&item.taskId===r.taskId&&item.roundId===r.roundId&&item.submissionId===r.submissionId,
    'CLAIM_CONFLICT','$.claim.itemId','exact claimed submission');
  const work=l.works.find(w=>w.work_id===l.activeWorkId);
  check(work?.work_id==='work-'+c.claimId&&same(work.owner_binding,l.leader)&&work.recovery_generation===c.generation&&
    work.kind==='task-review'&&work.phase==='active'&&work.task_ref?.task_id===r.taskId&&work.task_ref.round_id===r.roundId&&work.task_ref.submit_event_id===r.submissionId,
    'CLAIM_CONFLICT','$.claim','current review work and complete owner binding');
  check(!['started','unknown'].includes(work.last_effect.status),'EFFECT_UNKNOWN','$.claim','reconcile current work effect before decision');
  check(!l.operations.some(o=>o.phase==='review-prepared'),'EFFECT_UNKNOWN','$.claim','recover pending E05 review first');
}
function receipt(r,s,event,extra={}) {
  return {status:'recorded',operationId:r.operationId,requestFingerprint:fingerprint(r),
    teamId:r.teamId,roundId:r.roundId,taskId:r.taskId,submissionId:r.submissionId??null,
    eventId:event?.id??null,sourceVersion:s.version,recordedVersion:event?s.events.findIndex(e=>e.id===event.id)+1:null,
    effects:'committed',hostActionExecuted:false,sendNow:false,...extra};
}

// Only Manager CLI calls import this module. No startup scan, sender or new store.
// options are trusted test/adapter hooks, never accepted from JSON requests.
export async function managerRequest({statePath,request,options={}}) {
  let r,writeStarted=false;
  try {
    r=typeof request==='string'?parseInboxJson(request):jsonBoundary(request,65536);
    r=validateManagerRequest(r);
    const path=await realpath(statePath),ledgerPath=path+'.manager-inbox.json';
    return await withStateGuard(path,ledgerPath,readRawState,async s=>{
      const l=await readLedger(ledgerPath),manager=scope(s,r,l,path),prefix=operationPrefix(r),eventId=operationEventId(r);
      if(l) {
        // Reuse the ORIGINAL E05 read-only fence under these same locks. This
        // validates native Registry team revision, leader's full binding tuple
        // (including binding revision), ready membership and historical leader.
        // A projected host/thread pair alone cannot establish this capability.
        const fence=await inboxRuntime({statePath:path,registryPath:s.registry?.registryPath,
          request:{action:'status',actor_host_id:r.caller.hostId,actor_thread_id:r.caller.threadId,team_id:r.teamId,reason:r.reason,limit:1},
          options:{...options,lockRunner:async(_paths,fn)=>fn()}});
        check(fence.status!=='error',fence.reasonCode??'CAPABILITY_UNKNOWN','$.caller','existing E05 Registry/leader fence must pass');
      }
      const events=s.events.filter(e=>e.id.startsWith(prefix)),ops=l?.operations.filter(o=>o.id.startsWith(prefix))??[];
      check(events.length+ops.length<=1,'OPERATION_CONFLICT','$.operationId','one existing effect');
      const prior=events[0]??ops[0];
      // Status envelopes carry a fingerprint, not the original input. Bind every
      // reported target to the durable event/claim, never to selector labels.
      if(prior) {
        const op=ops[0],claim=op&&l.claims.find(c=>c.id===op.request.claim_id),item=claim&&l.items.find(i=>i.id===claim.itemId);
        const originalEvent=events[0]??(op.intent&&s.events.find(e=>e.id===op.intent.event.id));
        const taskId=events[0]?.taskId??item?.taskId,roundId=events[0]?.roundId??item?.roundId;
        const task=s.tasks.find(t=>t.id===taskId&&t.roundId===roundId);
        check(taskId===r.taskId&&roundId===r.roundId&&task?.workerId===r.workerId&&(!item||item.sender.memberId===r.workerId),
          'OPERATION_SCOPE_CONFLICT','$.taskId','original event/E05 task, round and assigned Worker');
        if(op)check(op.request.team_id===r.teamId&&op.request.actor_host_id===r.caller.hostId&&op.request.actor_thread_id===r.caller.threadId,
          'OPERATION_SCOPE_CONFLICT','$.caller','original E05 team and Manager');
        const index=originalEvent?s.events.findIndex(e=>e.id===originalEvent.id):-1;
        const submissionId=item?.submissionId??(events[0]?.type==='enqueue'?null:
          s.events.slice(0,index).filter(e=>e.type==='submit'&&e.taskId===taskId&&e.roundId===roundId).at(-1)?.id);
        if(r.action==='status')check((r.submissionId??null)===(submissionId??null),'OPERATION_SCOPE_CONFLICT','$.submissionId',submissionId??'omit for enqueue');
      }
      if(r.action==='status') {
        if(!prior)return {...receipt(r,s,null),status:'unknown',effects:'unknown',requestFingerprint:r.requestFingerprint,
          nextAction:'verify-original-execution-ended; do not retry an unknown effect'};
        check(prior.id===prefix+r.requestFingerprint,'OPERATION_CONFLICT','$.requestFingerprint','original complete request fingerprint');
        const e=events[0]??s.events.find(e=>e.id===ops[0].intent?.event.id);
        return {...receipt(r,s,e),requestFingerprint:r.requestFingerprint,status:ops[0]?.phase==='review-prepared'?'reconcile':'recorded',
          effects:ops[0]?.phase==='review-prepared'?(e?'committed':'partial'):'committed',
          projectionPending:ops[0]?.phase==='review-prepared',nextAction:ops[0]?.phase==='review-prepared'?'recover exact receive through E05':'inspect independent evidence'};
      }
      if(prior) {
        check(prior.id===eventId,'OPERATION_CONFLICT','$.operationId','reuse exact original input, including expectedVersion');
        if(events[0])return receipt(r,s,events[0],{replayed:true});
        // E05 owns its intent/business/projection recovery and exact-input replay.
      } else check(r.expectedVersion===s.version,'VERSION_CONFLICT','$.expectedVersion','inspect current version; construct a new authorized request');
      const at=options.at??new Date().toISOString();
      let event={id:eventId,actor:manager.id,at,roundId:r.roundId,taskId:r.taskId,
        source:{kind:s.team.source.kind==='fixture'?'fixture':'manual',ref:'manager-operation:'+fingerprint(r)}};
      if(r.action==='enqueue') {
        const brief=validateBrief(await loadObject(path,r.briefRef));
        check(brief.teamId===r.teamId&&brief.roundId===r.roundId&&brief.taskId===r.taskId&&same(brief.actor,r.caller),
          'BRIEF_MISMATCH','$.briefRef','frozen brief for exact target and Manager');
        event={...event,type:'enqueue',caller:r.caller,title:r.title,workerId:r.workerId,required:r.required,assignedAt:null,
          source:{...event.source,ref:r.briefRef}};
      } else if(r.action==='receive'&&r.mode==='queue_first') {
        // Check the immutable item scope even on E05 replay; leave claim recovery to E05.
        const item=l.items.find(x=>x.id===r.claim.itemId);
        check(item?.taskId===r.taskId&&item.roundId===r.roundId&&item.submissionId===r.submissionId,'CLAIM_CONFLICT','$.claim.itemId','exact submission');
        const req={action:'start_review',operation_id:eventId,actor_host_id:r.caller.hostId,actor_thread_id:r.caller.threadId,
          team_id:r.teamId,reason:r.reason,run_id:r.claim.runId,generation:r.claim.generation,claim_id:r.claim.claimId,expected_state_version:r.expectedVersion};
        const result=await inboxRuntime({statePath:path,registryPath:s.registry.registryPath,request:req,
          options:{...options,lockRunner:async(_paths,fn)=>fn()}});
        if(result.status==='error') {
          let effects=result.mutationUnknown?'unknown':'none',businessEventId=null,phase='not-proven';
          try {
            const current=await readRawState(path),ledger=await readLedger(ledgerPath),op=ledger?.operations.find(o=>o.id===eventId);
            const actual=op?.intent&&current.events.find(e=>e.id===op.intent.event.id);
            if(actual&&same(actual,op.intent.event)){effects='committed';businessEventId=actual.id;phase='business-committed-projection-pending';}
            else if(op){effects='partial';phase=op.phase;}
          } catch {effects='unknown';}
          return {status:'error',reasonCode:result.reasonCode,operationId:r.operationId,requestFingerprint:fingerprint(r),eventId:businessEventId,phase,
            effects,field:'$.claim',legal:'inspect original E05 operation; no native fallback',hostActionExecuted:false,sendNow:false,nextAction:'status; recover exact E05 operation'};
        }
        const actual=await readRawState(path),e=actual.events.find(e=>e.id===result.businessEventId);
        const review=e??(result.status==='review-resume'?actual.events.filter(e=>e.type==='review'&&e.taskId===r.taskId&&e.roundId===r.roundId).at(-1):null);
        return receipt(r,actual,review,{replayed:result.replayed??false,reviewStatus:result.status});
      } else if(r.action==='receive') {
        check(r.notice.submissionId===r.submissionId&&r.notice.taskId===r.taskId&&r.notice.roundId===r.roundId&&r.notice.teamId===r.teamId,
          'NOTICE_MISMATCH','$.notice','exact requested submission');
        const plan=planSubmissionReview(s,r.caller,r.notice);
        if(plan.action!=='review')return {...receipt(r,s,null),status:'ignored',effects:'none',reasonCode:plan.reason,nextAction:'inspect current submission; no replay proof for ignored requests'};
        event={...event,type:'review',source:{...event.source,ref:r.notice.notificationId}};
      } else if(r.action==='record_decision') {
        const ctx=submissionContext(s,r.taskId),sub=ctx.submissions.at(-1)?.event;
        check(sub?.id===r.submissionId,'SUBMISSION_CHANGED','$.submissionId','current exact submission');
        const review=s.events.filter(e=>e.taskId===r.taskId&&e.roundId===r.roundId&&e.type==='review').at(-1);
        check(review?.id===r.reviewEventId&&review.actor===manager.id&&s.events.indexOf(review)>s.events.indexOf(sub),
          'REVIEW_REQUIRED','$.reviewEventId','existing Manager review of this submission');
        if(r.mode==='queue_first')claimGate(l,r);
        event={...event,type:r.decision,summary:r.summary,...(r.decision==='approve'?{evidence:r.evidence}:{})};
      }
      // Same existing CAS engine, validation and write guard as store.transact.
      // No new business event fields, transitions or side ledger.
      const next=evolve(s,event,r.expectedVersion);
      await options.fault?.('before-business',{state:s,event});
      writeStarted=true;
      await atomicWrite(path,JSON.stringify(next,null,2)+'\n');
      await options.fault?.('after-business',{state:next,event});
      return receipt(r,next,event,{replayed:false});
    },options);
  } catch(e) {
    return {status:'error',reasonCode:e.code==='EEXIST'?'BUSY':e.code??'INVALID_REQUEST',
      operationId:typeof r?.operationId==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(r.operationId)?r.operationId:null,
      requestFingerprint:r?(r.action==='status'&&/^[a-f0-9]{64}$/.test(r.requestFingerprint??'')?r.requestFingerprint:fingerprint(r)):null,
      field:String(e.field??'$').slice(0,200),legal:e.legal??'inspect existing core validation and original request',
      message:String(e.message).slice(0,300),effects:writeStarted?'unknown':'none',hostActionExecuted:false,sendNow:false,
      nextAction:writeStarted?'status; do not blindly retry':'correct named fields or inspect conflict'};
  }
}
