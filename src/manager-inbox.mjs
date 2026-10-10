import {readFile,lstat,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readRawState,atomicWrite} from './store.mjs';
import {withStateGuard} from './registry-projection.mjs';
import {evolve} from './runtime.mjs';
import {submissionContext,makeNotice,planSubmissionReview} from './submission-notice.mjs';
import {validateLedger as validateNoticeLedger} from './submission-recovery.mjs';
import {revocationFor} from './worker-revocation.mjs';
import {INBOX_LIMITS,demand,exact,digest,parseInboxJson,validateInboxRequest,validateInboxLedger} from './manager-inbox-contract.mjs';

const terminal=new Set(['settled','superseded','stale']);
const key=p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p);
const tuple=m=>({memberId:m.id,role:m.role,hostId:m.binding.hostId,threadId:m.binding.threadId,revision:m.binding.revision});
const same=(a,b)=>digest(a)===digest(b);
const unknown=w=>w&&['started','unknown'].includes(w.last_effect.status);
const currentWork=l=>l.works.find(w=>w.work_id===l.activeWorkId);
const currentClaim=l=>l.claims.find(c=>c.id===l.consumer?.claimId);
const latestSubmit=(s,t)=>s.events.filter(e=>e.type==='submit'&&e.taskId===t.id&&e.roundId===t.roundId).at(-1);
async function diskJson(path,max){const info=await lstat(path);demand(info.isFile()&&!info.isSymbolicLink()&&info.size<=max,'STORAGE_CORRUPT');return parseInboxJson(await readFile(path,'utf8'),max);}
function baseLedger(state,path,leader){return {schemaVersion:'manager-inbox/v1',teamId:state.team.id,registryId:state.registry.registryId,stateBinding:digest(key(path)),leader,version:0,controlRevision:0,nextSeq:1,checkpointOrdinal:0,mode:'observe',claimsPaused:true,consumer:null,activeWorkId:null,protocolLoaded:[],audit:[],items:[],works:[],claims:[],operations:[],integrity:null};}
function audit(l,type,data,at){demand(l.audit.length<INBOX_LIMITS.audit,'INBOX_CAPACITY');const row={seq:l.nextSeq++,type,at,data:structuredClone(data)};l.audit.push(row);return row;}
function pendingIntents(l){return l.operations.filter(o=>o.phase==='review-prepared');}
function controlCAS(l,r){demand(r.expected_control_revision===l.controlRevision,'CONTROL_VERSION_CONFLICT');}
function owner(l,r){demand(l.mode==='queue_first','MODE_NOT_CONSUMING');demand(l.consumer?.runId===r.run_id,'CONSUMER_BUSY');demand(l.consumer.generation===r.generation,'GENERATION_CONFLICT');}
function workCAS(l,r){demand(l.activeWorkId===r.expected_work_id,'WORK_CONFLICT');}
function claimGate(l,r){owner(l,r);const c=currentClaim(l);demand(c?.id===r.claim_id&&c.phase==='active','CLAIM_CONFLICT');return c;}
function validateWorkScope(state,w){if(w.kind==='task-review'){const task=state.tasks.find(t=>t.id===w.task_ref.task_id);demand(task&&task.roundId===w.task_ref.round_id&&latestSubmit(state,task)?.id===w.task_ref.submit_event_id,'CONTINUATION_SUBMISSION_CHANGED');}}
function saveWork(l,state,r,actor,at){
 workCAS(l,r);const data=r.continuation;validateWorkScope(state,data);let w=l.works.find(w=>w.work_id===data.work_id);demand(data.continuation_revision===(w?.continuation_revision??0),'WORK_VERSION_CONFLICT');
 if(r.effect_result)demand(!pendingIntents(l).some(o=>o.id===r.effect_result.operation_ref),'UNRESOLVED_INTENT');
 if(unknown(w)&&!same(w.last_effect,data.last_effect)){const result=r.effect_result;demand(result&&result.operation_ref===w.last_effect.operation_ref&&data.last_effect.operation_ref===result.operation_ref&&data.last_effect.status===result.status&&data.last_effect.evidence_ref===result.evidence_ref,'EFFECT_RECONCILIATION_REQUIRED');audit(l,'effect-result',{workId:w.work_id,result,assurance:'caller-assessed exact-operation result'},at);}else demand(r.effect_result===undefined,'EFFECT_RESULT_CONFLICT');
 if(l.activeWorkId!==null&&l.activeWorkId!==data.work_id){demand(r.transition==='switch'&&r.human_ref,'WORK_CONFLICT');demand(!currentClaim(l)&&!pendingIntents(l).length&&!unknown(currentWork(l)),'UNRESOLVED_EFFECT');currentWork(l).phase='paused';}
 if(w)Object.assign(w,structuredClone(data));else{w=structuredClone(data);l.works.push(w);}w.continuation_revision++;w.owner_binding=actor;w.observed_state_version=state.version;w.recovery_generation=l.consumer.generation;l.activeWorkId=w.work_id;
}
function releaseClaim(l){const c=currentClaim(l);if(!c)return;c.phase='released';const work=currentWork(l);if(work)work.phase='paused';l.consumer.claimId=null;const previous=l.works.find(w=>w.work_id===c.resumeRef);l.activeWorkId=previous&&previous.phase!=='completed'?previous.work_id:null;if(previous&&l.activeWorkId)previous.phase='active';}
function payload(l,item,seq=item.pendingSeqs.at(-1)){return l.audit.find(a=>a.seq===seq)?.data.payload;}
function describe(l,item,seq){let p=payload(l,item,seq);if(['identity-hold','transport-hold'].includes(item.state))p={kind:item.kind,fullSource:item.submissionId?'state-event:'+item.submissionId:'inbox-audit:'+seq,summary:null,summaryWithheld:true};return {itemId:item.id,kind:item.kind,state:item.state,taskId:item.taskId,submissionId:item.submissionId,payloadSeq:seq??item.pendingSeqs.at(-1),firstPendingSeq:item.firstSeq,defers:item.defers,payload:p};}
function stats(l){const groups={};for(const i of l.items)groups[i.state]=(groups[i.state]??0)+1;return {counts:groups,pending:l.items.filter(i=>!terminal.has(i.state)).length,oldestSeq:l.items.filter(i=>!terminal.has(i.state)).reduce((n,i)=>Math.min(n,i.firstSeq),Infinity)===Infinity?null:l.items.filter(i=>!terminal.has(i.state)).reduce((n,i)=>Math.min(n,i.firstSeq),Infinity)};}
function wireBytes(v){return Buffer.byteLength(JSON.stringify({content:[{type:'text',text:JSON.stringify(v)}],isError:v.status==='error'}))+512;}
function boundedReply(v){demand(wireBytes(v)<=INBOX_LIMITS.response,'RESPONSE_TOO_LARGE');return v;}
function addItem(l,{id,kind,task,sender,scopeKey,payload:p,submissionId=null},at){
 const record=audit(l,'message',{itemId:id,sender,payload:p},at);const item={id,kind,taskId:task.id,roundId:task.roundId,submissionId,sender,scopeKey,firstSeq:record.seq,pendingSeqs:[record.seq],state:'queued',defers:0,deferred:null,received:null,hold:null};l.items.push(item);return item;
}
function freezeItem(l,item,seq){
 demand(item.pendingSeqs.includes(seq),'PAYLOAD_VERSION_CONFLICT');const later=item.pendingSeqs.filter(n=>n>seq);item.pendingSeqs=item.pendingSeqs.filter(n=>n<=seq);
 if(later.length){const successor={...structuredClone(item),id:'successor-'+digest([item.id,later[0]]),firstSeq:later[0],pendingSeqs:later,state:'queued',defers:0,received:null,deferred:null};l.items.push(successor);}return item;
}
function historicalSender(state,task,team){const old=state.rounds.find(r=>r.id===task.roundId)?.members.find(m=>m.id===task.workerId),current=team.members.find(m=>m.id===task.workerId);demand(old?.role==='Worker','IDENTITY_CONFLICT');const provenInitial=current?.binding.revision===1&&old.binding.hostId===current.binding.hostId&&old.binding.threadId===current.binding.threadId;return {memberId:old.id,role:old.role,hostId:old.binding.hostId,threadId:old.binding.threadId,revision:provenInitial?1:null};}
function formalPayload(state,task,event){return {kind:'submission',submit_event_id:event.id,submissionVersion:state.events.indexOf(event)+1,summary:event.summary.slice(0,2000),summaryTruncated:event.summary.length>2000,summaryDigest:digest(event.summary),businessStatus:task.status,fullSource:'state-event:'+event.id};}
function eligible(l,item,state,trigger){
 if(!['queued','received','deferred'].includes(item.state)||!item.pendingSeqs.length)return false;if(item.state!=='deferred')return true;const d=item.deferred;if(d.kind==='needs-input')return false;if(d.kind==='dependency')return state.tasks.find(t=>t.id===d.condition.task_id)?.status===d.condition.status;return l.checkpointOrdinal>d.ordinal&&(trigger===d.trigger||trigger==='resume'||trigger==='post_compaction');
}

// All paths/options come from the trusted local adapter. There is no host sender.
export async function inboxRuntime({statePath,registryPath,request,runtimeRevision='unversioned',options={}}){
 let mutationUnknown=false;
 try{
  const r=validateInboxRequest(request),path=await realpath(statePath),ledgerPath=path+'.manager-inbox.json',at=options.at??new Date().toISOString();demand(new Date(at).toISOString()===at,'INVALID_REQUEST');
  const readNative=options.readNative??(p=>diskJson(p,8*1024*1024)),write=options.write??atomicWrite,fault=options.fault??(()=>{}),deadline=()=>demand(!options.deadline||performance.now()<options.deadline,'BRIDGE_TIMEOUT');
  deadline();return await withStateGuard(path,ledgerPath,readRawState,async state=>{
   deadline();demand(state.schemaVersion===2&&state.registry.phase==='active','TEAM_NOT_CONNECTED');demand(key(state.registry.registryPath)===key(registryPath)&&state.team.id===r.team_id,'IDENTITY_CONFLICT');
   const native=await readNative(registryPath),team=native.teams?.find(t=>t.id===r.team_id);demand(native.registryId===state.registry.registryId&&team?.revision===state.registry.teamRevision&&key(team.runtime.statePath)===key(path),'IDENTITY_CONFLICT');
   const leader=team.members.find(m=>m.id===team.leaderMemberId&&m.role==='Manager'),actor=team.members.find(m=>m.binding.hostId===r.actor_host_id&&m.binding.threadId===r.actor_thread_id);demand(leader?.lifecycle==='active'&&actor?.lifecycle==='active'&&state.registry.readyMemberIds.includes(actor.id)&&state.registry.readyMemberIds.includes(leader.id),'IDENTITY_CONFLICT');
   demand(Number.isInteger(actor.binding.revision)&&Number.isInteger(leader.binding.revision),'IDENTITY_CONFLICT');const actorSnapshot=tuple(actor),leaderSnapshot=tuple(leader),caller={hostId:r.actor_host_id,threadId:r.actor_thread_id};
   const localActor=state.members.find(m=>m.id===actor.id);demand(localActor&&localActor.role===actor.role&&localActor.binding.hostId===r.actor_host_id&&localActor.binding.threadId===r.actor_thread_id,'IDENTITY_CONFLICT');
   for(const round of state.rounds.filter(x=>x.status==='open')){const old=round.members.find(m=>m.id===leader.id);demand(old?.role==='Manager'&&old.binding.hostId===leader.binding.hostId&&old.binding.threadId===leader.binding.threadId,'LEADER_CONFLICT');}
   demand(r.action==='post'?actor.role==='Worker':r.action==='status'?['Manager','Worker'].includes(actor.role):actor.id===leader.id,'ROLE_DENIED');
   let ledger;try{ledger=validateInboxLedger(await diskJson(ledgerPath,INBOX_LIMITS.ledger));}catch(e){if(e.code!=='ENOENT')throw e;}
   if(!ledger){if(r.action==='status')return {status:'uninitialized',mode:'legacy',hostActionExecuted:false};demand(r.action==='control'&&r.command==='init','INBOX_NOT_INITIALIZED');demand(r.expected_state_version===state.version&&r.team_revision===team.revision,'STATE_VERSION_CONFLICT');ledger=baseLedger(state,path,leaderSnapshot);}
   const l=structuredClone(ledger);demand(l.teamId===state.team.id&&l.registryId===state.registry.registryId&&l.stateBinding===digest(key(path))&&same(l.leader,leaderSnapshot),'LEADER_CONFLICT');
   const response=(status,extra={})=>({status,teamId:state.team.id,sourceVersion:state.version,inboxVersion:l.version,controlRevision:l.controlRevision,mode:l.mode,runtimeRevision,hostActionExecuted:false,identityAssurance:'caller-declared',...extra});
   const persist=async stage=>{deadline();l.version++;l.integrity=digest({...l,integrity:null});demand(Buffer.byteLength(JSON.stringify(l))<=INBOX_LIMITS.ledger,'INBOX_CAPACITY');validateInboxLedger(l);await fault('before-'+stage,{state,ledger:l});mutationUnknown=true;await write(ledgerPath,JSON.stringify(l)+'\n');await fault('after-'+stage,{state,ledger:l});mutationUnknown=false;};
   let notices;try{notices=await diskJson(path+'.submission-notices.json',INBOX_LIMITS.ledger);validateNoticeLedger(notices,path,state.team.id);}catch(e){if(e.code!=='ENOENT')throw e;notices=null;}
   const transport=submissionId=>{const entry=notices?.entries.find(e=>e.notice.submissionId===submissionId),attempt=entry?.attempts.at(-1);return attempt?(attempt.observations.at(-1)?.result.outcome??'unknown'):(entry?.baseline.outcome??'untracked');};
   const unresolvedTransport=()=>notices?.entries.some(e=>{const a=e.attempts.at(-1);return a?(a.observations.at(-1)?.result.outcome??'unknown')==='unknown':e.baseline.outcome==='unknown';});
   const itemScope=item=>{const task=state.tasks.find(t=>t.id===item.taskId),current=team.members.find(m=>m.id===item.sender.memberId),round=state.rounds.find(x=>x.id===item.roundId),old=round?.members.find(m=>m.id===item.sender.memberId);return task&&task.workerId===item.sender.memberId&&round.status==='open'&&current?.lifecycle==='active'&&state.registry.readyMemberIds.includes(current.id)&&same(tuple(current),item.sender)&&old?.role==='Worker'&&old.binding.hostId===current.binding.hostId&&old.binding.threadId===current.binding.threadId&&!revocationFor(state,current.id);};
   const reconcile=()=>{
    // Canonical submissions are durable even if their producer never posts.
    for(const task of state.tasks.filter(t=>['submitted','reviewing','blocked'].includes(t.status))){const event=latestSubmit(state,task);if(!event)continue;const id='submission-'+digest([state.team.id,task.roundId,task.id,event.id]);if(!l.items.some(i=>i.id===id)){const sender=historicalSender(state,task,team),p=formalPayload(state,task,event);if(sender.revision===null||['unknown','policy-denied'].includes(transport(event.id))){p.summary=null;p.summaryWithheld=true;}addItem(l,{id,kind:'submission',task,sender,scopeKey:id,payload:p,submissionId:event.id},at);}}
    for(const item of l.items){if(terminal.has(item.state))continue;const task=state.tasks.find(t=>t.id===item.taskId);if(item.submissionId&&task&&latestSubmit(state,task)?.id!==item.submissionId){item.state='superseded';continue;}if(!task||['approved','cancelled','rework'].includes(task.status)&&item.kind==='submission'){item.state=item.kind==='submission'?'settled':'stale';continue;}if(['approved','cancelled'].includes(task.status)){item.state='stale';continue;}
     if(!itemScope(item)){item.state='identity-hold';item.hold=item.sender.revision===null?'HISTORICAL_REVISION_UNKNOWN':'IDENTITY_CONFLICT';continue;}const outcome=transport(item.submissionId);if(['unknown','policy-denied'].includes(outcome)){item.state='transport-hold';item.hold=outcome;continue;}
     if(item.state==='transport-hold'){demand(['accepted','transient-not-delivered'].includes(outcome),'TRANSPORT_RECONCILE_REQUIRED');item.state='queued';item.hold=null;}
    }
   };
   const findItem=id=>{const i=l.items.find(i=>i.id===id);demand(i,'ITEM_NOT_FOUND');demand(itemScope(i),'IDENTITY_CONFLICT');return i;};
   const replay=r.action==='status'?null:l.operations.find(o=>o.id===r.operation_id);
   if(replay){demand(same(replay.request,r)&&same(replay.actor,actorSnapshot),'OPERATION_CONFLICT');if(replay.phase==='finished')return boundedReply({...replay.response,replayed:true,hostActionExecuted:false});demand(replay.phase==='review-prepared'&&r.action==='start_review','OPERATION_ABORTED');}
   if(r.action==='status'){
    if(r.operation_id){const op=l.operations.find(o=>o.id===r.operation_id);demand(op&&(actor.role==='Manager'||same(op.actor,actorSnapshot)),'OPERATION_NOT_FOUND');return boundedReply(response('observed',{operation:{id:op.id,phase:op.phase,response:op.response??null,intent:op.intent??null}}));}
    if(r.work_id){demand(actor.role==='Manager','ROLE_DENIED');const w=l.works.find(w=>w.work_id===r.work_id);demand(w,'WORK_NOT_FOUND');return response('observed',{work:w});}
    const items=l.items.filter(i=>(!r.item_id||i.id===r.item_id)&&(actor.role==='Manager'||same(i.sender,actorSnapshot))).sort((a,b)=>a.firstSeq-b.firstSeq).slice(0,r.limit??8);return boundedReply(response('observed',{items:items.map(i=>describe(l,i)),...(actor.role==='Manager'?{queue:stats(l),consumer:l.consumer,claimsPaused:l.claimsPaused,activeWork:currentWork(l)??null,pendingIntents:pendingIntents(l).map(o=>o.id)}:{})}));
   }
   const storeOperation=(out,phase='finished',intent=null)=>{const op={id:r.operation_id,request:structuredClone(r),fingerprint:digest(r),actor:actorSnapshot,phase,response:out,intent};l.operations.push(op);return op;};
   const finish=async out=>{out.inboxVersion=l.version+1;boundedReply(out);storeOperation(out);await persist('commit');return out;};
   // Default initialization is shadow-only and paused, never queue_first.
   if(r.action==='control'&&r.command==='init'){demand(l.version===0,'ALREADY_INITIALIZED');l.controlRevision++;return finish(response('initialized',{claimsPaused:true}));}
   reconcile();let out;
   if(r.action==='post'){
    const message=r.message;let item;
    if(message.kind==='submission'){const event=state.events.find(e=>e.id===message.submit_event_id&&e.type==='submit'),task=state.tasks.find(t=>t.id===event?.taskId);demand(event?.actor===actor.id&&task?.workerId===actor.id,'TASK_SCOPE_CONFLICT');item=l.items.find(i=>i.submissionId===event.id);demand(item,'SUBMISSION_NOT_PENDING');demand(!['unknown','policy-denied'].includes(transport(event.id)),'TRANSPORT_RECONCILE_REQUIRED');}
    else{
     const task=state.tasks.find(t=>t.id===message.task_id),round=state.rounds.find(x=>x.id===message.round_id),old=round?.members.find(m=>m.id===actor.id);demand(task&&task.workerId===actor.id&&task.roundId===message.round_id&&round?.status==='open'&&old?.binding.hostId===actor.binding.hostId&&old.binding.threadId===actor.binding.threadId&&!revocationFor(state,actor.id),'TASK_SCOPE_CONFLICT');demand(['executing','rework','blocked','submitted','reviewing'].includes(task.status),'TASK_TERMINAL');
     if(l.mode==='queue_first')demand(l.protocolLoaded.some(p=>p.member_id===actor.id&&p.binding_revision===actor.binding.revision),'PROTOCOL_NOT_LOADED');
     if(message.block_event_id)demand(state.events.some(e=>e.id===message.block_event_id&&e.type==='block'&&e.taskId===task.id),'BLOCK_EVENT_CONFLICT');
     const stream=digest([state.team.id,actorSnapshot,task.id,message.kind,message.step_id]),identity=digest([state.team.id,actorSnapshot,task.id,message.kind,message.message_id]),prior=l.audit.find(a=>a.type==='message'&&a.data.messageIdentity===identity);
     if(prior){demand(same(prior.data.payload,message),'MESSAGE_CONFLICT');item=l.items.find(i=>i.pendingSeqs.includes(prior.seq))??l.items.find(i=>i.id===prior.data.itemId);}
     else{const previous=l.audit.filter(a=>a.type==='message'&&a.data.stream===stream).at(-1);demand(!previous||message.producer_seq>previous.data.payload.producer_seq,'PRODUCER_SEQUENCE_CONFLICT');item=message.kind==='progress'?l.items.filter(i=>i.scopeKey===stream&&['queued','deferred'].includes(i.state)).at(-1):null;
      if(item){const a=audit(l,'message',{itemId:item.id,sender:actorSnapshot,payload:message,stream,messageIdentity:identity},at);item.pendingSeqs.push(a.seq);}else{item=addItem(l,{id:'message-'+identity,kind:message.kind,task,sender:actorSnapshot,scopeKey:stream,payload:message},at);Object.assign(l.audit.at(-1).data,{stream,messageIdentity:identity});}
     }
    }
    return finish(response(l.mode==='queue_first'?'enqueued':'shadow-recorded',{itemId:item.id,arrivalSeq:item.pendingSeqs.at(-1),itemState:item.state,wakeStatus:'not-requested'}));
   }
   if(r.action==='control'){
    controlCAS(l,r);const unresolved=()=>pendingIntents(l).length||unknown(currentWork(l));
    if(r.command==='pause_claims')l.claimsPaused=true;
    else if(r.command==='set_mode'){
     demand(l.claimsPaused&&!l.consumer&&!unresolved(),'UNRESOLVED_EFFECT');
     if(r.mode==='queue_first'){demand(!unresolvedTransport(),'TRANSPORT_RECONCILE_REQUIRED');const required=team.members.filter(m=>m.lifecycle==='active'&&['Manager','Worker'].includes(m.role)&&state.registry.readyMemberIds.includes(m.id));demand(r.protocol_loaded&&required.every(m=>r.protocol_loaded.some(p=>p.member_id===m.id&&p.binding_revision===m.binding.revision)),'PROTOCOL_NOT_LOADED');l.protocolLoaded=structuredClone(r.protocol_loaded);}l.mode=r.mode;
    }else if(r.command==='resume_claims'){demand(l.mode==='queue_first','MODE_NOT_CONSUMING');demand(!unresolved(),'UNRESOLVED_EFFECT');l.claimsPaused=false;}
    else if(r.command==='release_consumer'){owner(l,r);workCAS(l,r);demand(!currentClaim(l)&&!unresolved(),'UNRESOLVED_EFFECT');demand(!currentWork(l)||['paused','completed'].includes(currentWork(l).phase),'WORK_STILL_ACTIVE');l.consumer=null;}
    else if(r.command==='recover'){
     demand(l.mode==='queue_first'&&l.claimsPaused,'CLAIMS_NOT_PAUSED');workCAS(l,r);const rec=r.recovery;demand(r.run_id!==rec.old_run_id,'NEW_INSTANCE_REQUIRED');demand(l.consumer?.runId===rec.old_run_id&&l.consumer.generation===rec.old_generation&&r.generation===rec.old_generation&&l.consumer.claimId===(r.claim_id??null),'CONSUMER_CONFLICT');
     for(const op of pendingIntents(l)){const event=state.events.find(e=>e.id===op.intent.event.id);if(event){demand(same(event,op.intent.event),'BUSINESS_EFFECT_CONFLICT');op.phase='finished';op.response=response('review-started',{businessEventId:event.id,recovered:true});const w=l.works.find(w=>w.last_effect.operation_ref===op.id);if(w){w.last_effect={operation_ref:op.id,status:'succeeded',evidence_ref:'state-event:'+event.id};w.continuation_revision++;}}else{demand(rec.no_effect_intents.includes(op.id),'UNRESOLVED_INTENT');op.phase='aborted';op.response=null;}}
     for(const w of l.works.filter(unknown)){const e=rec.effects.find(e=>e.work_id===w.work_id);demand(e&&e.expected_revision===w.continuation_revision,'UNRESOLVED_EFFECT');w.last_effect={...w.last_effect,status:e.status,evidence_ref:e.evidence_ref};w.continuation_revision++;}
     l.consumer={...l.consumer,runId:r.run_id,generation:l.consumer.generation+1};const c=currentClaim(l);if(c){c.runId=r.run_id;c.generation=l.consumer.generation;}if(currentWork(l))currentWork(l).recovery_generation=l.consumer.generation;
    }l.controlRevision++;audit(l,'control',{command:r.command,actor:actorSnapshot,evidenceRef:r.authorization_ref},at);return finish(response('controlled',{claimsPaused:l.claimsPaused,consumer:l.consumer}));
   }
   if(r.action==='checkpoint'){
    controlCAS(l,r);l.checkpointOrdinal++;
    if(l.mode==='queue_first'){
     if(!l.consumer){demand(!l.claimsPaused,'CLAIMS_PAUSED');l.consumer={runId:r.run_id,generation:l.controlRevision+1,claimId:null};}else demand(l.consumer.runId===r.run_id,'CONSUMER_BUSY');
     if(r.continuation)saveWork(l,state,r,actorSnapshot,at);if(currentWork(l))validateWorkScope(state,currentWork(l));l.controlRevision++;
    }else demand(!r.continuation,'MODE_NOT_CONSUMING');
    const highWatermark=l.nextSeq-1,candidates=l.items.filter(i=>eligible(l,i,state,r.trigger)).sort((a,b)=>a.firstSeq-b.firstSeq),items=[],heldItems=l.items.filter(i=>['deferred','identity-hold','transport-hold'].includes(i.state)).slice(0,8).map(i=>({itemId:i.id,state:i.state,payloadSeq:i.pendingSeqs.at(-1),hold:i.hold,deferred:i.deferred}));out=response(l.mode==='queue_first'?'checkpoint':'shadow-checkpoint',{checkpointId:r.operation_id,ordinal:l.checkpointOrdinal,highWatermark,items,heldItems,queue:stats(l),consumer:l.consumer,activeWork:currentWork(l)??null,claimsPaused:l.claimsPaused,finalTicket:{controlRevision:l.controlRevision,stateVersion:state.version,arrivalHighWatermark:highWatermark,activeWorkId:l.activeWorkId,unresolvedCount:stats(l).pending,unresolvedItemIds:l.items.filter(i=>!terminal.has(i.state)).slice(0,8).map(i=>i.id),capturedAt:at},hasMore:false});
    for(const item of candidates.slice(0,r.limit??3)){items.push(describe(l,item));if(wireBytes(out)>INBOX_LIMITS.response-4096){items.pop();break;}}out.hasMore=candidates.length>items.length;return finish(out);
   }
   if(r.action==='claim'){
    owner(l,r);controlCAS(l,r);workCAS(l,r);demand(!l.claimsPaused,'CLAIMS_PAUSED');demand(!currentClaim(l)&&!pendingIntents(l).length&&!unknown(currentWork(l)),'CONSUMER_BUSY');
    const snapshot=l.operations.find(o=>o.id===r.checkpoint_id&&o.request.action==='checkpoint'&&o.phase==='finished'&&o.request.run_id===r.run_id),frozen=snapshot?.response.items.find(i=>i.itemId===r.item_id&&i.payloadSeq===r.payload_seq);demand(frozen,'CHECKPOINT_CONFLICT');const item=findItem(r.item_id);demand(!terminal.has(item.state)&&!['identity-hold','transport-hold'].includes(item.state),'ITEM_NOT_ELIGIBLE');
    const first=l.items.filter(i=>eligible(l,i,state,snapshot.request.trigger)).sort((a,b)=>a.firstSeq-b.firstSeq)[0];demand(first?.id===item.id,'FIFO_CONFLICT');demand(item.pendingSeqs.includes(r.payload_seq),'PAYLOAD_VERSION_CONFLICT');
    const resumeRef=l.activeWorkId;freezeItem(l,item,r.payload_seq);item.state='processing';
    if(currentWork(l))currentWork(l).phase='paused';const claim={id:'claim-'+randomUUID(),itemId:item.id,runId:r.run_id,generation:l.consumer.generation,payloadSeq:r.payload_seq,phase:'active',resumeRef};l.claims.push(claim);l.consumer.claimId=claim.id;
    const work={work_id:'work-'+claim.id,kind:item.kind==='submission'?'task-review':'user-work',task_ref:item.kind==='submission'?{round_id:item.roundId,task_id:item.taskId,submit_event_id:item.submissionId}:null,user_work_ref:item.kind==='submission'?null:'inbox-item:'+item.id,authorization_ref:r.boundary_ref,step_id:'inspect-inbox',phase:'active',next_action:{kind:'inspect-evidence',target_ref:'inbox-item:'+item.id},evidence_refs:[],last_effect:{operation_ref:null,status:'not-started',evidence_ref:null},continuation_revision:1,owner_binding:actorSnapshot,observed_state_version:state.version,recovery_generation:l.consumer.generation};l.works.push(work);l.activeWorkId=work.work_id;l.controlRevision++;return finish(response('claimed',{claim,work,payload:frozen.payload}));
   }
   if(r.action==='start_review'){
    const c=claimGate(l,r);let item=l.items.find(i=>i.id===c.itemId),op=replay,actual=op&&state.events.find(e=>e.id===op.intent.event.id);demand(item?.kind==='submission','CLAIM_CONFLICT');
    let ctx,sub,notice;if(actual){demand(op.intent.claimId===c.id&&same(actual,op.intent.event),'BUSINESS_EFFECT_CONFLICT');demand(currentWork(l)?.last_effect.operation_ref===op.id,'EFFECT_RECONCILIATION_REQUIRED');}else{item=findItem(c.itemId);demand(item.state==='processing','CLAIM_CONFLICT');demand(!['unknown','policy-denied'].includes(transport(item.submissionId)),'TRANSPORT_RECONCILE_REQUIRED');ctx=submissionContext(state,item.taskId);sub=ctx.submissions.find(s=>s.event.id===item.submissionId);demand(sub===ctx.submissions.at(-1),'SUBMISSION_CHANGED');notice=makeNotice(state,ctx,sub);}
    if(!op){demand(r.expected_state_version===state.version,'STATE_VERSION_CONFLICT');const plan=planSubmissionReview(state,caller,notice);if(plan.reason==='already-reviewing'){currentWork(l).next_action={kind:'inspect-evidence',target_ref:'state-event:'+item.submissionId};return finish(response('review-resume',{submissionId:item.submissionId}));}demand(plan.action==='review','REVIEW_NOT_ALLOWED');const event={id:'e05-review-'+digest([l.teamId,r.operation_id]),type:'review',actor:leader.id,at,source:{kind:state.team.source.kind==='fixture'?'fixture':'manual',ref:notice.notificationId},roundId:item.roundId,taskId:item.taskId};op=storeOperation(null,'review-prepared',{event,expectedVersion:state.version,claimId:c.id});currentWork(l).last_effect={operation_ref:r.operation_id,status:'started',evidence_ref:null};await persist('review-intent');}
    if(!actual){demand(state.version===op.intent.expectedVersion,'STATE_VERSION_CONFLICT');const next=evolve(state,op.intent.event,op.intent.expectedVersion);await fault('before-business',{state,ledger:l});mutationUnknown=true;await write(path,JSON.stringify(next,null,2)+'\n');await fault('after-business',{state:next,ledger:l});actual=op.intent.event;state=next;mutationUnknown=false;}
    op.phase='finished';currentWork(l).last_effect={operation_ref:r.operation_id,status:'succeeded',evidence_ref:'state-event:'+actual.id};currentWork(l).next_action=terminal.has(item.state)?{kind:'none',target_ref:null}:{kind:'inspect-evidence',target_ref:'state-event:'+item.submissionId};if(terminal.has(item.state))currentWork(l).phase='completed';l.controlRevision++;out=response('review-started',{businessEventId:actual.id,submissionId:item.submissionId});out.inboxVersion=l.version+1;op.response=out;await persist('review-projection');return out;
   }
   if(r.action==='resolve'){
    owner(l,r);controlCAS(l,r);workCAS(l,r);const item=findItem(r.item_id);
    if(r.claim_id){const c=claimGate(l,r);demand(c.itemId===item.id,'CLAIM_CONFLICT');}else{demand(!currentClaim(l),'CONSUMER_BUSY');const receipt=l.operations.find(o=>o.id===r.checkpoint_id&&o.request.action==='checkpoint'&&o.request.run_id===r.run_id),frozen=receipt?.response?.items.find(i=>i.itemId===item.id)??(r.disposition==='reconcile'?receipt?.response?.heldItems?.find(i=>i.itemId===item.id):null);demand(frozen,'CHECKPOINT_CONFLICT');demand(['queued','received','deferred'].includes(item.state),'ITEM_NOT_ELIGIBLE');freezeItem(l,item,frozen.payloadSeq);}
    demand(!pendingIntents(l).length&&!unknown(currentWork(l)),'UNRESOLVED_EFFECT');
    if(r.disposition==='settle'&&item.kind==='submission'){
     const task=state.tasks.find(t=>t.id===item.taskId),event=state.events.find(e=>e.id===r.decision_event_id),index=state.events.indexOf(event);demand(event&&['approve','rework','cancelStopped','cancelUndelivered','cancelQueued'].includes(event.type),'REVIEW_NOT_FINISHED');demand(event.taskId===item.taskId&&event.roundId===item.roundId&&state.events.slice(0,index).filter(e=>e.type==='submit'&&e.taskId===item.taskId).at(-1)?.id===item.submissionId&&latestSubmit(state,task)?.id===item.submissionId&&['approved','rework','cancelled'].includes(task.status),'DECISION_CONFLICT');
    }
    if(r.disposition==='acknowledge'){demand(item.state!=='processing','CLAIM_CONFLICT');item.state='received';item.received={at,actor:actorSnapshot,payloadSeq:item.pendingSeqs.at(-1)};}
    else if(r.disposition==='defer'){demand(r.defer.kind!=='busy'||item.defers<3,'DEFER_LIMIT');item.defers++;item.state='deferred';item.deferred={...r.defer,ordinal:l.checkpointOrdinal};releaseClaim(l);}
    else if(r.disposition==='settle'){item.state='settled';releaseClaim(l);}
    else{demand(item.state==='deferred','ITEM_NOT_RECONCILABLE');item.state='queued';item.deferred=null;}
    l.controlRevision++;audit(l,'disposition',{itemId:item.id,disposition:r.disposition,evidenceRef:r.reason_ref,decisionEventId:r.decision_event_id??null},at);return finish(response('resolved',{itemId:item.id,itemState:item.state,activeWork:currentWork(l)??null}));
   }
   demand(false,'INVALID_REQUEST');
  },options);
 }catch(e){return {status:'error',reasonCode:e.code==='EEXIST'?'BUSY':['ENOSPC','EACCES','EPERM','EIO','EROFS'].includes(e.code)?'STORAGE_ERROR':e.code==='ENOENT'?'RUNTIME_UNAVAILABLE':e.code??'INVALID_REQUEST',hostActionExecuted:false,...(mutationUnknown?{mutationUnknown:true,nextAction:'recover-exact-operation'}:{})};}
}
