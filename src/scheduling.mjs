import { validate, validateCaller } from './runtime.mjs';
import { readState, transact } from './store.mjs';

const check=(ok,message)=>{if(!ok)throw new Error(message);};
const same=(a,b)=>a.hostId===b.hostId&&a.threadId===b.threadId;
function managerFor(state,caller) {
 validate(state);validateCaller(caller);
 const manager=state.members.find(m=>m.role==='Manager');
 check(manager.lifecycle==='active'&&manager.binding.status==='bound'&&same(manager.binding,caller),'Scheduling requires the current active bound Manager');
 return manager;
}
function requestShape(request,keys,expectedVersion) {
 check(request&&typeof request==='object'&&!Array.isArray(request)&&Object.keys(request).every(k=>keys.includes(k)),'Unknown scheduling request field');
 check(Number.isSafeInteger(expectedVersion)&&expectedVersion>=0,'Invalid expectedVersion');
}
export async function queueTask(path,request,expectedVersion) {
 requestShape(request,['id','caller','at','source','roundId','taskId','title','workerId','required'],expectedVersion);
 const state=await readState(path),actor=managerFor(state,request.caller);
 return transact(path,expectedVersion,{...request,type:'enqueue',actor:actor.id,assignedAt:null});
}
export async function startTask(path,request,expectedVersion) {
 requestShape(request,['id','caller','at','source','roundId','taskId'],expectedVersion);
 const state=await readState(path),actor=managerFor(state,request.caller);
 return transact(path,expectedVersion,{...request,type:'startTask',actor:actor.id});
}
export async function cancelQueuedTask(path,request,expectedVersion) {
 requestShape(request,['id','caller','at','source','roundId','taskId','summary'],expectedVersion);
 const state=await readState(path),actor=managerFor(state,request.caller);
 return transact(path,expectedVersion,{...request,type:'cancelQueued',actor:actor.id});
}

// Readiness is local admission only, never proof that the native task is idle.
// No message payload: enqueueing and inspecting a queue must not contact Workers.
export function planDispatch(state,caller,workerId) {
 managerFor(state,caller);
 const worker=state.members.find(m=>m.id===workerId);
 check(worker?.role==='Worker'&&worker.lifecycle==='active'&&worker.binding.status==='bound','Worker unavailable');
 validateCaller({hostId:worker.binding.hostId,threadId:worker.binding.threadId});
 const tasks=state.tasks.filter(t=>t.workerId===workerId&&!['approved','cancelled'].includes(t.status));
 for(const task of tasks) {
  const historical=state.rounds.find(r=>r.id===task.roundId)?.members.find(m=>m.id===workerId);
  check(historical?.role==='Worker'&&historical.lifecycle==='active'&&historical.binding.status==='bound'&&same(historical.binding,worker.binding),'Worker identity differs from historical binding');
 }
 const reserved=tasks.filter(t=>t.status!=='queued'),queued=tasks.filter(t=>t.status==='queued');
 return {sourceVersion:state.version,sourceUpdatedAt:state.updatedAt,identityAssurance:'caller-declared',readOnly:true,executed:false,
  workerId,decision:reserved.length?'held':queued.length?'ready':'no-work',reservedTaskIds:reserved.map(t=>t.id),queuedTaskIds:queued.map(t=>t.id),
  nextTaskId:reserved.length?null:queued[0]?.id??null,requiresNativeIdleCheck:true,hostRequest:null};
}
