import { validate, validateCaller } from './runtime.mjs';
import { pendingSubmissions } from './submission-notice.mjs';

const check=(ok,message)=>{if(!ok)throw new Error(message);};
const key=identity=>JSON.stringify([identity.hostId,identity.threadId]);
function identity(binding) {validateCaller({hostId:binding.hostId,threadId:binding.threadId});return {hostId:binding.hostId,threadId:binding.threadId};}

// A plan is not an observation. Identity comes from the caller, not authentication.
export function planSupervision(state,caller,cursors=[]) {
 validate(state);validateCaller(caller);
 const manager=state.members.find(m=>m.role==='Manager');
 check(manager.lifecycle==='active'&&manager.binding.status==='bound'&&key(manager.binding)===key(caller),'Supervision requires the current active bound Manager');
 const targets=new Map(),taskChecks=[];
 for(const task of state.tasks) {
  const round=state.rounds.find(r=>r.id===task.roundId);
  if(round.status!=='open'||['approved','queued','cancelled'].includes(task.status))continue;
  const historical=round.members.find(m=>m.id===task.workerId),current=state.members.find(m=>m.id===task.workerId);
  check(historical?.role==='Worker'&&historical.lifecycle==='active'&&historical.binding.status==='bound','Historical Worker unavailable');
  check(current?.role==='Worker'&&current.lifecycle==='active'&&current.binding.status==='bound'&&key(current.binding)===key(historical.binding),'Current Worker identity differs from historical assignment');
  const target=identity(historical.binding);targets.set(key(target),target);
  taskChecks.push({taskId:task.id,roundId:task.roundId,worker:{...target},taskStatus:task.status,
   nextAction:({submitted:'inspect-submission',reviewing:'continue-review',blocked:'inspect-blocker'})[task.status]??'check-progress',
   notificationStatus:'unknown',notificationSource:'not-read',requiresManagerReview:true});
 }
 check(Array.isArray(cursors),'Cursors must be an array of exact target identities');
 const seen=new Set();
 for(const cursor of cursors) {
  check(cursor&&typeof cursor==='object'&&!Array.isArray(cursor)&&Object.keys(cursor).every(k=>['hostId','threadId','afterCursor'].includes(k)),'Invalid cursor fields');
  const target=identity(cursor),targetKey=key(target);
  check(typeof cursor.afterCursor==='string'&&cursor.afterCursor.trim().length>0,'Cursor must be a nonempty opaque string');
  check(targets.has(targetKey)&&!seen.has(targetKey),'Cursor identity is unmatched or duplicated');seen.add(targetKey);
  targets.get(targetKey).afterCursor=cursor.afterCursor;
 }
 const values=[...targets.values()],batches=[];
 for(let i=0;i<values.length;i+=8)batches.push({targets:values.slice(i,i+8),timeoutMs:0});
 return {sourceVersion:state.version,sourceUpdatedAt:state.updatedAt,team:structuredClone(state.team),sourceKinds:[...new Set([state.team.source.kind,...state.events.map(e=>e.source.kind)])],identityAssurance:'caller-declared',readOnly:true,executed:false,
  taskChecks,pendingSubmissions:pendingSubmissions(state,caller),batches};
}

// Inject a host adapter explicitly. Node does not inherently have Desktop tools.
// Fixture sources require a fixture adapter; a host caller must check provenance.
export async function runSupervision(state,caller,waitThreads,cursors=[]) {
 const plan=planSupervision(state,caller,cursors),batchResults=[];
 if(plan.batches.length)check(typeof waitThreads==='function','A waitThreads host adapter is required');
 for(const request of plan.batches) {
  try {
   const rawResult=await waitThreads(structuredClone(request));
   const present=rawResult!==null&&rawResult!==undefined&&(typeof rawResult==='object'||typeof rawResult==='string');
   batchResults.push({request,status:present?'returned':'invalid-result',rawResult,requiresManagerReview:true,...(present?{}:{error:{name:'InvalidToolResult',message:'Host adapter returned no usable raw result'}})});
  } catch(error) {
   batchResults.push({request,status:'error',error:{name:error?.name??'HostError',message:error?.message??String(error)},requiresManagerReview:true});
  }
 }
 return {...plan,executed:batchResults.length>0,nativeOutcomeInterpreted:false,batchResults};
}
