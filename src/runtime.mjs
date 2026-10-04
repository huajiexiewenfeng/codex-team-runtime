import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {isDispatch,dispatchHold} from './dispatch-contract.mjs';
import { deliveryState, deliveryEventTypes } from './delivery-state.mjs';
import {revocationFor,handoffHold,checkRevocation,checkResolution} from './worker-revocation.mjs';
const revocationFields=['caller','revocation'];
const resolutionFields=['caller','revocationId','disposition','evidenceRef'];

const roles = ['Manager', 'Liaison', 'Worker'];
const statuses = ['queued', 'executing', 'submitted', 'reviewing', 'rework', 'approved', 'blocked', 'cancelled'];
const transitions = {queued:['executing','cancelled'],executing:['submitted','blocked','cancelled'],submitted:['reviewing','blocked'],reviewing:['rework','approved','blocked'],rework:['submitted','blocked'],approved:[],cancelled:[]};
const fail = message => { throw new Error(message); };
const check = (condition, message) => { if (!condition) fail(message); };
function object(x, keys, context = '') {
 check(x && typeof x === 'object' && !Array.isArray(x), 'Expected object');
 const unknown = Object.keys(x).filter(k => !keys.includes(k));
 if (unknown.length) {
  // Show at most three bounded, escaped names; never interpolate their values.
  const names = unknown.slice(0, 3).map(k => JSON.stringify(k.slice(0, 80)).replace(/[^\x20-\x7e]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) + (k.length > 80 ? ' (truncated)' : ''));
  fail(`Unknown field${unknown.length > 1 ? 's' : ''}${context ? ` in ${context}` : ''}: ${names.join(', ')}${unknown.length > 3 ? ' (additional fields omitted)' : ''}`);
 }
}
function text(x) { check(typeof x === 'string' && x.trim().length > 0 && x.length <= 4000, 'Expected nonempty text (max 4000)'); }
function id(x) { text(x); check(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(x), 'Invalid identifier'); }
export function validateCaller(x) {
 object(x,['hostId','threadId']); id(x.hostId); id(x.threadId);
 check(!x.threadId.startsWith('client-new-thread:')&&!x.threadId.startsWith('pending:'),'Pending identity is not a task');
 return x;
}
function time(x, nullable = false) { if (x === null && nullable) return; check(typeof x === 'string' && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x, 'Expected canonical UTC ISO timestamp'); }
function provenance(x) {
 object(x, ['kind','ref','hostId','threadId']); check(['fixture','manual','host-observation'].includes(x.kind), 'Invalid source kind'); text(x.ref);
 if (x.kind === 'host-observation') { id(x.hostId); id(x.threadId); }
 else check(x.hostId === undefined && x.threadId === undefined, 'Host identity only on host observations');
}
function binding(x) {
 object(x,['status','hostId','threadId','pendingId']); check(['bound','unbound','creating','missing'].includes(x.status),'Invalid binding');
 if (['bound','missing'].includes(x.status)) { id(x.hostId); id(x.threadId); check(x.pendingId === undefined,'Pending is not a thread identity'); }
 else { check(x.hostId === undefined && x.threadId === undefined,'Unresolved binding cannot contain thread identity'); if (x.status==='creating') id(x.pendingId); else check(x.pendingId===undefined,'Unexpected pending identity'); }
}
function members(xs) {
 check(Array.isArray(xs),'Expected members'); const ids=new Set(), bindings=new Set();
 for (const m of xs) { object(m,['id','role','name','lifecycle','binding']); id(m.id); text(m.name); check(roles.includes(m.role),'Invalid role'); check(['active','exited'].includes(m.lifecycle),'Invalid lifecycle'); binding(m.binding); check(!ids.has(m.id),'Duplicate member'); ids.add(m.id);
  if (['bound','missing'].includes(m.binding.status)) { const key=JSON.stringify([m.binding.hostId,m.binding.threadId]); check(!bindings.has(key),'Duplicate host/thread'); bindings.add(key); }
 }
 for (const role of ['Manager','Liaison']) check(xs.filter(m=>m.role===role).length===1,`Exactly one ${role} required`);
}
function observation(o) { object(o,['id','at','observedAt','summary','progress','source']); id(o.id); time(o.at); time(o.observedAt,true); text(o.summary); check(typeof o.progress==='boolean','Invalid progress'); provenance(o.source); check(o.observedAt===null || o.observedAt<=o.at,'Future observation'); }
// Evidence references are checked declarations, not host authentication or a stop command.
function stoppedCancellation(s,t,e) {
 const c=e.cancellation;object(c,['worker','authorizationRef','authorizedAt','stopObservationId','workerAcknowledgementRef','idle','execution','deliveryAttemptId','wip']);
 const r=s.rounds.find(r=>r.id===t.roundId),w=r.members.find(m=>m.id===t.workerId),m=r.members.find(m=>m.id===e.actor&&m.role==='Manager');
 validateCaller(e.caller);check(m&&m.binding.status==='bound'&&e.caller.hostId===m.binding.hostId&&e.caller.threadId===m.binding.threadId,'Cancellation Manager identity mismatch');
 validateCaller(c.worker);check(c.worker.hostId===w.binding.hostId&&c.worker.threadId===w.binding.threadId,'Cancellation Worker identity mismatch');
 const stages=t.status==='cancelled'?t.stages.slice(0,-1):t.stages;
 check(stages.at(-1)?.status==='executing'&&stages.every(p=>['queued','executing'].includes(p.status))&&t.submissions===0&&t.assignedAt!==null,'Only initial executing work can be withdrawn');
 text(e.summary);text(c.authorizationRef);time(c.authorizedAt);check(c.authorizationRef===e.source.ref,'Withdrawal source mismatch');
 check(c.authorizedAt>=t.assignedAt&&c.authorizedAt<=e.at,'Withdrawal authorization time invalid');
 id(c.stopObservationId);text(c.workerAcknowledgementRef);
 const o=t.observations.find(o=>o.id===c.stopObservationId);
 check(o&&o.progress===false&&o.source.kind==='host-observation'&&o.source.hostId===c.worker.hostId&&o.source.threadId===c.worker.threadId&&o.observedAt!==null&&o.observedAt>=c.authorizedAt&&o.at<=e.at,'Stopped Worker observation required');
 check(t.observations.at(-1)?.id===o.id,'Newer observation requires stop reconciliation');
 const observationIndex=s.events.findIndex(a=>a.id===o.id&&a.type==='observe'&&a.taskId===t.id&&a.roundId===t.roundId&&a.at===o.at&&isDeepStrictEqual(a.source,o.source));
 check(observationIndex>=0,'Stopped observation audit required');
 const cancellationIndex=s.events.findIndex(a=>a.id===e.id);
 check(cancellationIndex<0||observationIndex<cancellationIndex,'Stopped observation must precede cancellation');
 object(c.idle,['status','checkedAt','ref']);text(c.idle.ref);time(c.idle.checkedAt);
 check(c.idle.status==='idle'&&c.idle.checkedAt>=o.at&&c.idle.checkedAt<=e.at&&Date.parse(e.at)-Date.parse(c.idle.checkedAt)<=300000,'Fresh idle observation required (within five minutes)');
 object(c.execution,['status','checkedAt','inFlightMessages','ref']);check(c.execution.status==='stopped'&&c.execution.inFlightMessages==='none','Execution and in-flight messages must be confirmed stopped');text(c.execution.ref);time(c.execution.checkedAt);
 check(c.execution.checkedAt>=o.at&&c.execution.checkedAt<=e.at&&Date.parse(e.at)-Date.parse(c.execution.checkedAt)<=300000,'Fresh execution check required (within five minutes)');
 const delivery=deliveryState(s,t);id(c.deliveryAttemptId);check(delivery.status==='delivered'&&delivery.attemptId===c.deliveryAttemptId,'Resolved delivered assignment required; unknown delivery cannot be cancelled');
 object(c.wip,['disposition','ref','summary']);check(['none','retained','handed-off'].includes(c.wip.disposition),'Invalid WIP disposition');text(c.wip.ref);text(c.wip.summary);
}
function undeliveredCancellation(s,t,e) {
 const index=s.events.findIndex(x=>x.id===e.id),prior=index<0?s.events:s.events.slice(0,index);
 const stages=t.status==='cancelled'?t.stages.slice(0,-1):t.stages;
 check(isDispatch(e)&&stages.at(-1)?.status==='executing'&&stages.every(p=>['queued','executing'].includes(p.status))&&t.submissions===0&&t.observations.length===0,'Only unobserved initial E04 work can be withdrawn');
 const fields=['authorization_ref','reason','nonreceipt_evidence_ref','execution_evidence_ref'];object(e.cancellation,fields);for(const key of fields)text(e.cancellation[key]);
 validateCaller(e.caller);const actor=s.members.find(m=>m.id===e.actor);check(actor?.role==='Manager'&&actor.binding.hostId===e.caller.hostId&&actor.binding.threadId===e.caller.threadId,'Cancellation Manager mismatch');
 const projection={...s,events:prior},delivery=deliveryState(projection,{...t,status:'executing'});
 check(['not-delivered','policy-denied'].includes(delivery.status)&&delivery.attemptId===e.attemptId,'All attempts must be resolved undelivered');
 check(!prior.some(x=>x.taskId===t.id&&x.type==='deliveryCheck'&&x.outcome==='delivered'),'Accepted work cannot be withdrawn as undelivered');
 check(!revocationFor(projection,t.workerId)&&!handoffHold(projection,t.id)&&!dispatchHold(projection,t.workerId),'Unresolved Worker risk');
}
export function validate(s) {
 object(s,['schemaVersion','version','updatedAt','team','members','rounds','tasks','events','reporting','session','registry']); check([1,2].includes(s.schemaVersion),'Unsupported schema version'); check(Number.isSafeInteger(s.version)&&s.version>=0,'Invalid version'); time(s.updatedAt);
 object(s.team,['id','name','source']); id(s.team.id); text(s.team.name); provenance(s.team.source); members(s.members);
 if(s.schemaVersion===1) check(s.registry===undefined,'Legacy state cannot contain Registry link');
 else {
  object(s.registry,['registryId','registryPath','teamId','migrationId','sourceSha256','sourceVersion','phase','teamRevision','readyMemberIds']);
  id(s.registry.registryId);text(s.registry.registryPath);check(isAbsolute(s.registry.registryPath),'Registry path must be absolute');id(s.registry.teamId);id(s.registry.migrationId);
  check(s.registry.teamId===s.team.id,'Registry team mismatch');check(/^[0-9a-f]{64}$/.test(s.registry.sourceSha256),'Invalid Registry source SHA-256');
  check(Number.isSafeInteger(s.registry.sourceVersion)&&s.registry.sourceVersion>=0,'Invalid Registry source version');check(['prepared','active'].includes(s.registry.phase),'Invalid Registry phase');
  check(Number.isSafeInteger(s.registry.teamRevision)&&s.registry.teamRevision>=0,'Invalid Registry team revision');check(Array.isArray(s.registry.readyMemberIds),'Invalid Registry readiness');
  const ready=new Set();for(const memberId of s.registry.readyMemberIds){id(memberId);check(!ready.has(memberId),'Duplicate ready Registry member');ready.add(memberId);}
  if(s.registry.phase==='prepared'){check(s.registry.sourceVersion===s.version,'Prepared Registry source version mismatch');check(s.registry.teamRevision===0,'Prepared Registry revision must be zero');check(ready.size===0,'Prepared Registry readiness must be empty');}
  else {check(s.registry.sourceVersion<=s.version,'Registry source version exceeds state version');check(s.registry.teamRevision>0,'Active Registry revision must be positive');check([...ready].every(memberId=>s.members.some(m=>m.id===memberId)),'Ready Registry member is missing');}
 }
 check(Array.isArray(s.rounds)&&Array.isArray(s.tasks)&&Array.isArray(s.events),'Invalid collections');
 const roundIds=new Set(), taskIds=new Set(), eventIds=new Set();
 const recordedTime=x=>check(x===null||x<=s.updatedAt,'Timestamp exceeds state update');
 for(const r of s.rounds) { object(r,['id','title','status','openedAt','closedAt','members']); id(r.id); text(r.title); check(!roundIds.has(r.id),'Duplicate round'); roundIds.add(r.id); check(['open','closed'].includes(r.status),'Invalid round status'); time(r.openedAt); time(r.closedAt,true); check((r.status==='closed')===(r.closedAt!==null),'Invalid round closure'); check(!r.closedAt || r.closedAt>=r.openedAt,'Invalid closure time'); members(r.members); }
 for(const r of s.rounds) { recordedTime(r.openedAt); recordedTime(r.closedAt); }
 for(const t of s.tasks) {
  object(t,['id','roundId','title','workerId','required','assignedAt','status','completedAt','stages','submissions','observations','acceptance']); id(t.id); check(!taskIds.has(t.id),'Duplicate task'); taskIds.add(t.id); id(t.roundId); check(roundIds.has(t.roundId),'Missing round'); text(t.title); check(typeof t.required==='boolean','Invalid required flag');
  const r=s.rounds.find(r=>r.id===t.roundId); check(r.members.some(m=>m.id===t.workerId&&m.role==='Worker'&&m.binding.status==='bound'),'Missing assigned worker binding');
  time(t.assignedAt,true); time(t.completedAt,true); check(statuses.includes(t.status),'Invalid task status'); check((['approved','cancelled'].includes(t.status))===(t.completedAt!==null),'Invalid completed time'); check(Number.isSafeInteger(t.submissions)&&t.submissions>=0,'Invalid submissions');
  check(Array.isArray(t.stages)&&t.stages.length>0,'Missing stages'); let previous=null;
  for(const [i,p] of t.stages.entries()) { object(p,['status','startedAt','endedAt']); check(statuses.includes(p.status),'Invalid stage'); time(p.startedAt,true); time(p.endedAt,true); check(!p.startedAt||!p.endedAt||p.endedAt>=p.startedAt,'Negative stage'); if(i) check(previous.endedAt===p.startedAt,'Discontinuous stages'); if(i<t.stages.length-1) check(p.endedAt!==null,'Unclosed stage'); previous=p; }
  check(previous.status===t.status && previous.endedAt===null,'Invalid current stage');
  const first=t.stages[0],execution=t.stages.find(p=>p.status==='executing');
  check(['queued','executing'].includes(first.status),'Invalid initial stage');
  check((execution?.startedAt??null)===t.assignedAt,'Assignment mismatch');
  if(first.status==='queued') {check(first.startedAt!==null,'Queue time required');check(!execution||execution.startedAt!==null,'Started queued task requires assignment time');}
  check(!t.completedAt || t.completedAt===previous.startedAt,'Completion mismatch');
  for(let i=1;i<t.stages.length;i++) { const before=t.stages[i-1].status, after=t.stages[i].status; check(before==='blocked'?i>=2&&after===t.stages[i-2].status:transitions[before]?.includes(after),'Invalid stage transition'); }
  check(t.submissions===t.stages.filter((p,i)=>p.status==='submitted'&&t.stages[i-1]?.status!=='blocked').length,'Submission count mismatch');
  recordedTime(t.assignedAt); recordedTime(t.completedAt); check(t.assignedAt===null||t.assignedAt>=r.openedAt,'Task predates round');
  for(const p of t.stages) { recordedTime(p.startedAt); recordedTime(p.endedAt); check(p.startedAt===null||p.startedAt>=r.openedAt,'Stage predates round'); }
  check(!r.closedAt||t.completedAt<=r.closedAt,'Task completed after round closed');
  check(Array.isArray(t.observations),'Invalid observations'); check(!(t.status==='queued'||(t.status==='cancelled'&&!execution))||t.observations.length===0,'Unstarted task cannot have observations'); t.observations.forEach(o=>{
   observation(o); recordedTime(o.at); check(o.at>=r.openedAt,'Observation predates round');
   if(o.source.kind==='host-observation') {
    const b=r.members.find(m=>m.id===t.workerId).binding;
    check(b.hostId===o.source.hostId&&b.threadId===o.source.threadId,'Observation identity mismatch');
   }
  });
  if(t.status==='approved') { object(t.acceptance,['actor','at','summary','evidence']); check(r.members.some(m=>m.id===t.acceptance.actor&&m.role==='Manager'),'Approval requires Manager'); time(t.acceptance.at); text(t.acceptance.summary); check(t.acceptance.at===t.completedAt && Array.isArray(t.acceptance.evidence)&&t.acceptance.evidence.length>0,'Missing acceptance'); t.acceptance.evidence.forEach(text); } else check(t.acceptance===null,'Premature acceptance');
  check(r.status!=='closed'||['approved','cancelled'].includes(t.status),'Closed round contains unfinished work');
 }
 for(const e of s.events) { object(e,['id','type','actor','at','source','roundId','taskId','summary',...(e.type==='revokeWorker'?revocationFields:[]),...(e.type==='resolveRevocation'?resolutionFields:[]),...(['cancelStopped','cancelUndelivered'].includes(e.type)?['caller','cancellation']:[]),...(e.type==='admitRegistryMember'?['memberId']:[]),...(e.type==='detachLiaison'?['detachedInvitation']:[]),...([...deliveryEventTypes,'dispatchConflict','cancelUndelivered'].includes(e.type)?['attemptId']:[]),...(e.type==='deliveryCheck'?['outcome']:[])]); id(e.id); check(!eventIds.has(e.id),'Duplicate event'); eventIds.add(e.id); text(e.type); id(e.actor); time(e.at); provenance(e.source); if(e.type==='admitRegistryMember')id(e.memberId);if(e.summary!==undefined) text(e.summary); if([...deliveryEventTypes,'dispatchConflict','cancelUndelivered'].includes(e.type)){id(e.taskId);id(e.roundId);id(e.attemptId);} }
 let previousEventAt=null;
 for(const e of s.events) { check(Object.hasOwn(fields,e.type),'Unknown audit event'); recordedTime(e.at); check(previousEventAt===null||e.at>=previousEventAt,'Events out of order'); previousEventAt=e.at; check(s.members.some(m=>m.id===e.actor),'Unknown event actor'); if(e.roundId!==undefined) check(roundIds.has(e.roundId),'Unknown event round'); if(e.taskId!==undefined) check(s.tasks.some(t=>t.id===e.taskId&&t.roundId===e.roundId),'Unknown event task'); }
 check(s.events.length===s.version,'Version/event mismatch'); check(previousEventAt===null||previousEventAt===s.updatedAt,'Last event/update mismatch');
 for(const e of s.events)check(!e.source.ref.startsWith('e04-op:')||isDispatch(e),'Malformed E04 operation reference');
 for(const task of s.tasks)deliveryState(s,task);
 for(const e of s.events.filter(x=>x.type==='dispatchConflict'))check(isDispatch(e)&&s.events.some(x=>x.id===e.attemptId&&isDispatch(x)&&x.taskId===e.taskId&&['startTask','deliveryClaim'].includes(x.type)),'Invalid dispatch conflict audit');
 for(const t of s.tasks.filter(t=>t.status==='cancelled')) {
  const forced=revocationFor(s,t.workerId);
  if(forced?.revocation.taskIds.includes(t.id)){check(t.completedAt===forced.at&&t.stages.at(-2)&&['executing','queued'].includes(t.stages.at(-2).status),'Revocation cancellation mismatch');continue;}
  const cancellations=s.events.filter(e=>['cancelQueued','cancelStopped','cancelUndelivered'].includes(e.type)&&e.taskId===t.id&&e.roundId===t.roundId),r=s.rounds.find(r=>r.id===t.roundId);
  if(cancellations[0]?.type==='cancelUndelivered')undeliveredCancellation(s,t,cancellations[0]);
  else if(cancellations[0]?.type==='cancelStopped')stoppedCancellation(s,t,cancellations[0]);
  else check(t.stages.length===2&&t.stages[0].status==='queued'&&t.assignedAt===null&&t.submissions===0,'Only unstarted queued tasks can be cancelled');
  check(cancellations.length===1&&cancellations[0].at===t.completedAt&&r.members.some(m=>m.id===cancellations[0].actor&&m.role==='Manager'),'Cancellation audit mismatch');text(cancellations[0].summary);
 }
 for(const e of s.events.filter(e=>['cancelQueued','cancelStopped','cancelUndelivered'].includes(e.type)))check(s.tasks.some(t=>t.id===e.taskId&&t.roundId===e.roundId&&t.status==='cancelled'),'Cancellation event requires cancelled task');
 const revoked=new Set(),resolved=new Set();
 for(const e of s.events){
  if(e.type==='revokeWorker'){checkRevocation(s,e);check(!revoked.has(e.revocation.memberId),'Duplicate Worker revocation');revoked.add(e.revocation.memberId);for(const id of e.revocation.taskIds)check(s.tasks.find(t=>t.id===id)?.status==='cancelled','Revocation task must stay cancelled');}
  if(e.type==='resolveRevocation'){checkResolution(s,e);check(!resolved.has(e.revocationId),'Duplicate revocation resolution');resolved.add(e.revocationId);}
 }
 for(const r of s.rounds.filter(r=>r.status==='closed')) check(s.tasks.some(t=>t.roundId===r.id&&t.required),'Closed round lacks required work');
 object(s.reporting,['enabled','desired','actual','intentVersion','offlineReceipt']); check(typeof s.reporting.enabled==='boolean','Invalid reporting preference'); check(['running','stopped'].includes(s.reporting.desired)&&s.reporting.actual==='unknown','Host state cannot be confirmed by offline runtime'); check(Number.isSafeInteger(s.reporting.intentVersion)&&s.reporting.intentVersion>=0&&s.reporting.intentVersion<=s.version,'Invalid report intent');
 check(s.reporting.desired===(s.reporting.enabled&&s.rounds.some(r=>r.status==='open')?'running':'stopped'),'Inconsistent reporting intent');
 if(s.reporting.offlineReceipt!==null) { const r=s.reporting.offlineReceipt; object(r,['intentVersion','actual','at','source']); check(r.intentVersion===s.reporting.intentVersion,'Stale receipt'); check(['running','stopped','failed'].includes(r.actual),'Invalid receipt'); time(r.at); recordedTime(r.at); provenance(r.source); }
 const detachments=s.events.filter(e=>e.type==='detachLiaison');
 check(!detachments.length||s.session!==undefined,'Detached pairing requires session history');
 if(s.session!==undefined) {
  object(s.session,['invitation']);
  const revoked=new Set();
  for(const e of detachments) {check(e.detachedInvitation&&e.detachedInvitation.confirmedAt!==null,'Missing detached pairing');text(e.summary);check(!revoked.has(e.detachedInvitation.id),'Pairing detached twice');revoked.add(e.detachedInvitation.id);}
  check(s.session.invitation===null||!revoked.has(s.session.invitation?.id),'Revoked invitation cannot be current');
  for(const {q,detachment} of [...detachments.map(e=>({q:e.detachedInvitation,detachment:e})),{q:s.session.invitation,detachment:null}]) {
  if(q!==null) {
   object(q,['id','issuedVersion','managerId','liaisonId','target','expiresAt','confirmedAt','confirmationId']); id(q.id); id(q.managerId); id(q.liaisonId); validateCaller(q.target); time(q.expiresAt); time(q.confirmedAt,true);
   check(Number.isSafeInteger(q.issuedVersion)&&q.issuedVersion>0&&q.issuedVersion<=s.version,'Invalid invitation version');
   const invite=s.events[q.issuedVersion-1];
   check(invite?.id===q.id&&invite.type==='attachInvite'&&invite.actor===q.managerId,'Invitation audit mismatch');
   check(q.expiresAt>invite.at,'Invalid invitation expiry');
   const manager=s.members.find(m=>m.id===q.managerId), liaison=s.members.find(m=>m.id===q.liaisonId);
   check(manager?.role==='Manager'&&liaison?.role==='Liaison','Invitation role mismatch');
   if(q.confirmedAt===null) check(q.confirmationId===null&&liaison.binding.status==='unbound','Unconfirmed invitation binding mismatch');
   else {
    id(q.confirmationId); recordedTime(q.confirmedAt); check(q.confirmedAt>=invite.at&&q.confirmedAt<q.expiresAt,'Invalid confirmation time');
    const confirmation=s.events.find(e=>e.id===q.confirmationId);
    check(confirmation?.type==='attachConfirm'&&confirmation.actor===q.liaisonId&&confirmation.at===q.confirmedAt,'Confirmation audit mismatch');
    if(detachment) check(detachment.actor===q.managerId&&detachment.at>=q.confirmedAt&&s.events.indexOf(detachment)>s.events.indexOf(confirmation),'Detached pairing audit mismatch');
    else check(liaison.binding.status==='bound'&&liaison.binding.hostId===q.target.hostId&&liaison.binding.threadId===q.target.threadId,'Confirmed binding mismatch');
   }
  }
  }
  if(detachments.length&&s.session.invitation===null) check(s.members.find(m=>m.role==='Liaison').binding.status==='unbound','Detached Liaison must be unbound');
 }
 return s;
}
export function createState(config, at) {
 object(config,['teamId','name','source','members']); time(at);
 return validate({schemaVersion:1,version:0,updatedAt:at,team:{id:config.teamId,name:config.name,source:structuredClone(config.source)},members:structuredClone(config.members),rounds:[],tasks:[],events:[],reporting:{enabled:true,desired:'stopped',actual:'unknown',intentVersion:0,offlineReceipt:null}});
}
const fields={openRound:['roundId','title'],assign:['roundId','taskId','title','workerId','required','assignedAt'],submit:['roundId','taskId','summary'],review:['roundId','taskId'],rework:['roundId','taskId','summary'],approve:['roundId','taskId','summary','evidence'],block:['roundId','taskId','summary'],unblock:['roundId','taskId','summary'],observe:['roundId','taskId','observedAt','summary','progress'],closeRound:['roundId'],reports:['enabled'],reportReceipt:['intentVersion','actual'],bindMember:['memberId','binding'],exitMember:['memberId'],attachInvite:['caller','target','expiresAt'],attachConfirm:['caller','invitationId','invitationVersion'],detachLiaison:['caller','invitationId','invitationVersion','summary'],registerWorker:['caller','memberId','name','binding'],admitRegistryMember:['caller','roundId','memberId']};
fields.assign.push('caller');
fields.enqueue=[...fields.assign];
fields.startTask=['roundId','taskId','caller'];
fields.cancelQueued=['roundId','taskId','caller','summary'];
fields.cancelStopped=['roundId','taskId','caller','summary','cancellation'];
fields.revokeWorker=[...revocationFields,'summary'];
fields.resolveRevocation=[...resolutionFields,'summary'];
fields.deliveryCheck=['roundId','taskId','caller','attemptId','outcome','summary'];
fields.deliveryClaim=['roundId','taskId','caller','attemptId','summary'];
fields.cancelUndelivered=['roundId','taskId','caller','attemptId','summary','cancellation'];
fields.dispatchConflict=['roundId','taskId','caller','attemptId','summary'];
export function evolve(state,e,expectedVersion,{nowMs=Date.now(),dispatchOperation=false}={}) {
 validate(state); check(!e.source?.ref?.startsWith('e04-op:')||dispatchOperation,'E04 events require dispatch runtime'); check(expectedVersion===state.version,'Version conflict'); check(fields[e.type]!==undefined,'Unknown event'); object(e,['id','type','actor','at','source',...fields[e.type]],`event ${e.type}`); id(e.id); time(e.at); provenance(e.source); check(e.at>=state.updatedAt,'Event time moved backwards'); check(!state.events.some(x=>x.id===e.id),'Duplicate event');
 if(state.schemaVersion===2){check(state.registry.phase==='active','Registry link is prepared; writes are fenced');check(!['bindMember','exitMember','attachInvite','attachConfirm','detachLiaison','registerWorker'].includes(e.type),'Legacy identity event forbidden in linked state');}
 check(Number.isFinite(nowMs),'Invalid host clock');check(Date.parse(e.at)<=nowMs+60000,'Event time exceeds host clock (maximum skew 60 seconds)');
 const s=structuredClone(state), actor=s.members.find(m=>m.id===e.actor); check(actor?.lifecycle==='active'&&(actor.binding.status==='bound'||(e.type==='attachConfirm'&&actor.role==='Liaison'&&actor.binding.status==='unbound')),'Actor unavailable');
 check(!revocationFor(s,actor.id),'Worker revoked');
 if(['assign','enqueue','startTask','deliveryClaim'].includes(e.type)){check(!revocationFor(s,e.workerId??s.tasks.find(t=>t.id===e.taskId)?.workerId),'Worker revoked');if(e.type!=='enqueue')check(!handoffHold(s,e.taskId),'Handoff execution risk unresolved');}
 if(s.schemaVersion===2){const ready=new Set(s.registry.readyMemberIds),leader=s.members.find(m=>m.role==='Manager');check(ready.has(actor.id),'Actor is not Registry ready');check(leader&&ready.has(leader.id),'Manager leader is not Registry ready');}
 if(['assign','startTask','deliveryClaim'].includes(e.type))check(!dispatchHold(s,e.workerId??s.tasks.find(t=>t.id===e.taskId)?.workerId),'Dispatch conflict hold requires reconciliation');
 const manager=actor.role==='Manager'; check(manager||['submit','observe','attachConfirm'].includes(e.type),'Manager action required');
 const r=e.roundId?s.rounds.find(r=>r.id===e.roundId):null;
 const t=e.taskId?s.tasks.find(t=>t.id===e.taskId&&t.roundId===e.roundId):null;
 const initial=t?s.events.find(x=>x.taskId===t.id&&['assign','startTask'].includes(x.type)):null;
 const lateDispatch=isDispatch(initial)&&isDispatch(e)&&(e.type==='dispatchConflict'||(e.type==='deliveryCheck'&&['delivered','unknown'].includes(e.outcome)));
 if(e.type!=='openRound'&&e.roundId) check(r&&(r.status==='open'||lateDispatch),'Round unavailable or closed');
 if(e.taskId&&!['assign','enqueue'].includes(e.type)) { check(t,'Task missing'); check(manager||(actor.role==='Worker'&&actor.id===t.workerId),'Worker ownership mismatch'); }
 if(['enqueue','startTask','cancelQueued','cancelStopped','cancelUndelivered','dispatchConflict','admitRegistryMember',...deliveryEventTypes].includes(e.type)||(e.type==='assign'&&Object.hasOwn(e,'caller'))) {validateCaller(e.caller);check(e.caller.hostId===actor.binding.hostId&&e.caller.threadId===actor.binding.threadId,'Manager caller mismatch');}
 check(t?.status!=='cancelled'||lateDispatch,'Cancelled task immutable');
 if(t?.status==='queued')check(['startTask','cancelQueued'].includes(e.type),'Queued task must start before work');
 if(e.type==='submit') check(actor.role==='Worker'&&actor.id===t.workerId,'Only assigned Worker can submit');
 const transition=status=>{ check(t.status!=='approved','Completed task immutable'); const last=t.stages.at(-1); last.endedAt=e.at; t.stages.push({status,startedAt:e.at,endedAt:null}); t.status=status; };
 const assignedWorker=workerId=>{const w=r.members.find(m=>m.id===workerId),current=s.members.find(m=>m.id===workerId);check(w?.role==='Worker'&&w.lifecycle==='active'&&w.binding.status==='bound','Worker not bound');validateCaller({hostId:w.binding.hostId,threadId:w.binding.threadId});check(current?.lifecycle==='active'&&isDeepStrictEqual(current.binding,w.binding),'Worker binding changed');if(s.schemaVersion===2)check(s.registry.readyMemberIds.includes(w.id),'Selected Worker is not Registry ready');return w;};
 const workerAvailable=workerId=>check(!s.tasks.some(x=>x.workerId===workerId&&!['queued','approved','cancelled'].includes(x.status)),'Worker busy with unapproved work');
 let detachedInvitation;
 switch(e.type) {
  case 'revokeWorker': {
   check(s.schemaVersion===2&&s.registry.phase==='active','Active Registry-linked team required');
   checkRevocation(s,e);const c=e.revocation,w=s.members.find(m=>m.id===c.memberId);
   check(w.lifecycle==='active'&&!revocationFor(s,w.id),'Worker unavailable or revoked');
   const pending=s.tasks.filter(t=>t.workerId===w.id&&!['approved','cancelled'].includes(t.status));
   check(isDeepStrictEqual(pending.map(t=>t.id).sort(),[...c.taskIds].sort()),'All current Worker tasks must be explicitly scoped');
   for(const id of c.handoffTaskIds)check(s.tasks.find(t=>t.id===id).status==='queued','Handoff task must remain queued');
   for(const t of pending){check(['queued','executing'].includes(t.status),'Only initial unsubmitted work can be revoked');t.stages.at(-1).endedAt=e.at;t.stages.push({status:'cancelled',startedAt:e.at,endedAt:null});t.status='cancelled';t.completedAt=e.at;}
   break;
  }
  case 'resolveRevocation': checkResolution(s,e);check(!s.events.some(r=>r.type==='resolveRevocation'&&r.revocationId===e.revocationId),'Revocation already resolved');break;
  case 'admitRegistryMember': {
   check(s.schemaVersion===2&&s.registry.phase==='active','Active linked state required');id(e.memberId);
   check(!r.members.some(m=>m.id===e.memberId),'Member already participates in round');
   const current=s.members.find(m=>m.id===e.memberId);
   check(current?.role==='Worker'&&current.lifecycle==='active'&&current.binding.status==='bound','Registry member is not an active bound Worker');
   check(s.registry.readyMemberIds.includes(current.id),'Registry member is not ready');
   r.members.push(structuredClone(current));break;
  }
  case 'detachLiaison': {
   validateCaller(e.caller);id(e.invitationId);text(e.summary);
   check(e.caller.hostId===actor.binding.hostId&&e.caller.threadId===actor.binding.threadId,'Manager caller mismatch');
   check(!s.rounds.some(r=>r.status==='open'),'Cannot detach during open rounds');
   check(s.reporting.enabled===false,'Disable reports before detaching');
   const liaison=s.members.find(m=>m.role==='Liaison'),q=s.session?.invitation;
   check(liaison.lifecycle==='active'&&liaison.binding.status==='bound','Liaison unavailable or unpaired');
   check(q?.confirmedAt&&q.id===e.invitationId&&q.issuedVersion===e.invitationVersion,'Confirmed invitation missing or mismatched');
   detachedInvitation=structuredClone(q);s.session.invitation=null;liaison.binding={status:'unbound'};
   break;
  }
  case 'registerWorker': {
   validateCaller(e.caller); validateCaller(e.binding); id(e.memberId); text(e.name);
   check(e.caller.hostId===actor.binding.hostId&&e.caller.threadId===actor.binding.threadId,'Manager caller mismatch');
   check(!s.rounds.some(r=>r.status==='open'),'Cannot register Worker during open rounds');
   check(!s.members.some(m=>m.id===e.memberId),'Member already exists');
   s.members.push({id:e.memberId,name:e.name,role:'Worker',lifecycle:'active',binding:{status:'bound',...e.binding}});
   break;
  }
  case 'attachInvite': {
   validateCaller(e.caller); validateCaller(e.target); time(e.expiresAt);
   check(e.caller.hostId===actor.binding.hostId&&e.caller.threadId===actor.binding.threadId,'Manager caller mismatch');
   check(!s.rounds.some(r=>r.status==='open'),'Cannot attach during open rounds');
   const liaison=s.members.find(m=>m.role==='Liaison');
   check(liaison.lifecycle==='active'&&liaison.binding.status==='unbound','Liaison unavailable or already paired');
   check(!s.members.some(m=>['bound','missing'].includes(m.binding.status)&&m.binding.hostId===e.target.hostId&&m.binding.threadId===e.target.threadId),'Target already assigned');
   check(e.expiresAt>e.at,'Invitation must expire after issue time');
   s.session={invitation:{id:e.id,issuedVersion:s.version+1,managerId:actor.id,liaisonId:liaison.id,target:structuredClone(e.target),expiresAt:e.expiresAt,confirmedAt:null,confirmationId:null}};
   break;
  }
  case 'attachConfirm': {
   validateCaller(e.caller); id(e.invitationId);
   const q=s.session?.invitation, manager=s.members.find(m=>m.role==='Manager');
   check(actor.role==='Liaison'&&actor.binding.status==='unbound','Only unpaired Liaison can confirm');
   check(manager.lifecycle==='active'&&manager.binding.status==='bound','Manager unavailable');
   check(q&&q.id===e.invitationId&&q.issuedVersion===e.invitationVersion&&q.confirmedAt===null,'Invitation missing, stale or already confirmed');
   check(q.liaisonId===actor.id&&q.managerId===manager.id,'Invitation role mismatch');
   check(e.caller.hostId===q.target.hostId&&e.caller.threadId===q.target.threadId,'Liaison caller mismatch');
   check(e.at<q.expiresAt,'Invitation expired');
   check(!s.rounds.some(r=>r.status==='open'),'Cannot attach during open rounds');
   actor.binding={status:'bound',...e.caller}; q.confirmedAt=e.at; q.confirmationId=e.id;
   break;
  }
  case 'openRound': id(e.roundId); text(e.title); check(!r,'Round exists'); if(s.session) check(s.members.some(m=>m.role==='Worker'&&m.lifecycle==='active'&&m.binding.status==='bound'),'Register an active bound Worker before opening a session round'); s.rounds.push({id:e.roundId,title:e.title,status:'open',openedAt:e.at,closedAt:null,members:structuredClone(s.members)}); break;
  case 'enqueue': case 'assign': {
   id(e.taskId);text(e.title);check(!s.tasks.some(x=>x.id===e.taskId),'Task exists');const w=assignedWorker(e.workerId),queued=e.type==='enqueue';
   time(e.assignedAt,true);check(e.assignedAt===null||(e.assignedAt>=r.openedAt&&e.assignedAt<=e.at),'Invalid assignment time');check(typeof e.required==='boolean','Required flag missing');
   if(queued)check(e.assignedAt===null,'Queued assignment time must be null');
   else {workerAvailable(w.id);check(!s.tasks.some(x=>x.workerId===w.id&&x.status==='queued'),'Cannot bypass Worker queue');}
   const status=queued?'queued':'executing';s.tasks.push({id:e.taskId,roundId:r.id,title:e.title,workerId:w.id,required:e.required,assignedAt:e.assignedAt,status,completedAt:null,stages:[{status,startedAt:queued?e.at:e.assignedAt,endedAt:null}],submissions:0,observations:[],acceptance:null});break;
  }
  case 'startTask': {
   check(dispatchOperation||!s.events.some(x=>x.type==='enqueue'&&x.taskId===t.id&&x.source.ref.startsWith('e04-brief:')),'Frozen E04 queue requires dispatch prepare');
   check(t.status==='queued','Only queued tasks can start');const w=assignedWorker(t.workerId);workerAvailable(w.id);
   check(s.tasks.find(x=>x.workerId===w.id&&x.status==='queued')?.id===t.id,'Only FIFO queue head may start');
   transition('executing');t.assignedAt=e.at;break;
  }
  case 'deliveryCheck': case 'deliveryClaim': {
   check(t?.status==='executing'||lateDispatch,'Delivery recovery requires initial executing work');if(!lateDispatch)assignedWorker(t.workerId);id(e.attemptId);text(e.summary);
   if(e.type==='deliveryClaim'||['not-delivered','policy-denied'].includes(e.outcome))check(t.observations.length===0,'Observed work forbids non-delivery retry');
   if(e.type==='deliveryClaim')check(!s.tasks.some(x=>x.id!==t.id&&x.workerId===t.workerId&&!['queued','approved','cancelled'].includes(x.status)),'Competing Worker reservation blocks retry');
   break; // Audit projection validates attempt lineage and outcome after append.
  }
  case 'dispatchConflict': check(isDispatch(initial)&&isDispatch(e),'E04 conflict requires original dispatch');id(e.attemptId);text(e.summary);check(s.events.some(x=>x.id===e.attemptId&&x.taskId===t.id&&isDispatch(x)&&['startTask','deliveryClaim'].includes(x.type)),'Unknown conflict attempt');break;
  case 'cancelUndelivered': check(isDispatch(initial)&&isDispatch(e),'E04 cancellation requires dispatch');assignedWorker(t.workerId);undeliveredCancellation(s,t,e);transition('cancelled');t.completedAt=e.at;break;
  case 'cancelQueued': check(t.status==='queued','Only queued tasks can be cancelled');text(e.summary);transition('cancelled');t.completedAt=e.at;break;
  case 'cancelStopped': check(t.status==='executing','Only initial executing work can be withdrawn');assignedWorker(t.workerId);stoppedCancellation(s,t,e);transition('cancelled');t.completedAt=e.at;break;
  case 'submit': text(e.summary); check(['executing','rework'].includes(t.status),'Submission not allowed'); transition('submitted'); t.submissions++; break;
  case 'review': check(t.status==='submitted','Review requires submission'); transition('reviewing'); break;
  case 'rework': text(e.summary); check(t.status==='reviewing','Rework requires review'); transition('rework'); break;
  case 'approve': text(e.summary); check(t.status==='reviewing','Approval requires review'); check(Array.isArray(e.evidence)&&e.evidence.length>0,'Independent evidence required'); e.evidence.forEach(text); transition('approved'); t.completedAt=e.at; t.acceptance={actor:e.actor,at:e.at,summary:e.summary,evidence:structuredClone(e.evidence)}; break;
  case 'block': text(e.summary); check(t.status!=='blocked','Already blocked'); transition('blocked'); break;
  case 'unblock': text(e.summary); check(t.status==='blocked','Not blocked'); transition(t.stages.at(-2).status); break;
  case 'observe': { check(t.status!=='approved','Completed task immutable'); const o={id:e.id,at:e.at,observedAt:e.observedAt,summary:e.summary,progress:e.progress,source:structuredClone(e.source)}; observation(o); if(e.source.kind==='host-observation') { const b=r.members.find(m=>m.id===t.workerId).binding; check(b.hostId===e.source.hostId&&b.threadId===e.source.threadId,'Observation identity mismatch'); } t.observations.push(o); break; }
  case 'closeRound': check(s.tasks.some(t=>t.roundId===r.id&&t.required),'No required work'); check(s.tasks.filter(t=>t.roundId===r.id).every(t=>['approved','cancelled'].includes(t.status)),'Unaccepted work remains'); r.status='closed'; r.closedAt=e.at; break;
  case 'reports': check(typeof e.enabled==='boolean','Expected report preference'); s.reporting.enabled=e.enabled; break;
  case 'reportReceipt': check(e.intentVersion===s.reporting.intentVersion,'Stale report receipt'); check(['running','stopped','failed'].includes(e.actual),'Invalid receipt'); s.reporting.offlineReceipt={intentVersion:e.intentVersion,actual:e.actual,at:e.at,source:structuredClone(e.source)}; break;
  case 'bindMember': case 'exitMember': { const m=s.members.find(m=>m.id===e.memberId); check(m,'Member missing'); check(!s.rounds.some(r=>r.status==='open'&&r.members.some(x=>x.id===m.id)),'Cannot change participating member during an open round'); if(e.type==='bindMember') { check(!s.session||m.role==='Worker','Session roles require two-sided attach; rebinding unsupported'); binding(e.binding); m.binding=structuredClone(e.binding); } else m.lifecycle='exited'; break; }
 }
 s.version++; s.updatedAt=e.at;
 if(['openRound','closeRound','reports'].includes(e.type)) { s.reporting.desired=s.reporting.enabled&&s.rounds.some(r=>r.status==='open')?'running':'stopped'; s.reporting.intentVersion=s.version; s.reporting.offlineReceipt=null; }
 const audit={id:e.id,type:e.type,actor:e.actor,at:e.at,source:structuredClone(e.source)}; for(const k of ['roundId','taskId','summary',...(e.type==='revokeWorker'?revocationFields:[]),...(e.type==='resolveRevocation'?resolutionFields:[]),...(['cancelStopped','cancelUndelivered'].includes(e.type)?['caller','cancellation']:[]),...(e.type==='admitRegistryMember'?['memberId']:[]),...([...deliveryEventTypes,'dispatchConflict','cancelUndelivered'].includes(e.type)?['attemptId','outcome']:[])]) if(e[k]!==undefined) audit[k]=structuredClone(e[k]); if(detachedInvitation) audit.detachedInvitation=detachedInvitation; s.events.push(audit);
 return validate(s);
}
function freeze(x) { if(x&&typeof x==='object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; }
export function snapshot(state,asOf,roundId=null,staleAfterMs=15*60000) {
 validate(state); time(asOf); check(asOf>=state.updatedAt,'Snapshot precedes recorded state'); check(Number.isFinite(staleAfterMs)&&staleAfterMs>=0,'Invalid stale threshold'); const s=structuredClone(state);
 if(roundId!==null) check(s.rounds.some(r=>r.id===roundId),'Round missing');
 const tasks=s.tasks.filter(t=>roundId===null||t.roundId===roundId).map(t=>{
  const end=t.completedAt??asOf, duration=start=>start===null?null:Date.parse(end)-Date.parse(start);
  const known=t.observations.filter(o=>o.observedAt!==null).sort((a,b)=>b.observedAt.localeCompare(a.observedAt)||b.at.localeCompare(a.at));
  const latestObservation=known[0]??null, latestProgress=known.find(o=>o.progress)??null;
  const revoked=revocationFor(s,t.workerId),hold=handoffHold(s,t.id);
  return {...t,...(revoked?.revocation.taskIds.includes(t.id)?{revocation:{operationId:revoked.id,summary:revoked.summary,execution:'unknown'}}:{}),...(hold?{handoffRisk:{operationId:hold.id,status:'unresolved'}}:{}),...(dispatchHold(s,t.workerId)?{dispatchRisk:{operationId:dispatchHold(s,t.workerId).id,status:'unresolved'}}:{}),delivery:deliveryState(s,t),elapsedMs:duration(t.assignedAt),phaseElapsedMs:duration(t.stages.at(-1).startedAt),stages:t.stages.map(p=>({...p,durationMs:p.startedAt===null?null:Date.parse(p.endedAt??end)-Date.parse(p.startedAt)})),latestObservation,latestProgress,freshness:latestObservation===null?'unknown':Date.parse(asOf)-Date.parse(latestObservation.observedAt)>staleAfterMs?'stale':'recorded'};
 });
 const registry=s.schemaVersion===2?{registryId:s.registry.registryId,migrationId:s.registry.migrationId,phase:s.registry.phase,teamRevision:s.registry.teamRevision,readyMemberIds:structuredClone(s.registry.readyMemberIds)}:undefined;
 const payload={schemaVersion:s.schemaVersion,sourceVersion:s.version,sourceUpdatedAt:s.updatedAt,asOf,staleAfterMs,roundId,team:s.team,members:roundId===null?s.members:s.rounds.find(r=>r.id===roundId).members,rounds:s.rounds.filter(r=>roundId===null||r.id===roundId),tasks,events:s.events.filter(e=>roundId===null||e.roundId===roundId),reporting:s.reporting,...(registry?{registry}:{}),sourceKinds:[...new Set([s.team.source.kind,...s.events.map(e=>e.source.kind)])],navigation:{available:false,reason:'独立 HTML 的受支持导航尚未验证；Agent 导航工具不是网页 API'}};
 return freeze({...payload,snapshotId:createHash('sha256').update(JSON.stringify(payload)).digest('hex')});
}
